#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  echo "Usage: $0 --backup FILE --checksum FILE --target-compose-dir DIR --confirm-non-production" >&2
}

backup_file=
checksum_file=
target_compose_dir=
confirmed=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backup) backup_file=${2:-}; shift 2 ;;
    --checksum) checksum_file=${2:-}; shift 2 ;;
    --target-compose-dir) target_compose_dir=${2:-}; shift 2 ;;
    --confirm-non-production) confirmed=true; shift ;;
    *) usage; exit 2 ;;
  esac
done

if [[ -z ${backup_file} || -z ${checksum_file} || -z ${target_compose_dir} || ${confirmed} != true ]]; then
  usage
  exit 2
fi

production_compose_dir=${TASKFLOW_PRODUCTION_COMPOSE_DIR:-/opt/TaskFlow}
postgres_service=${TASKFLOW_POSTGRES_SERVICE:-postgres}
database_name=${TASKFLOW_DB_NAME:-taskflow}
database_user=${TASKFLOW_DB_USER:-taskflow}

if [[ ! -f ${backup_file} || ! -f ${checksum_file} ]]; then
  echo "Backup or checksum file is missing" >&2
  exit 2
fi
if [[ ! -f ${target_compose_dir}/docker-compose.yml ]]; then
  echo "Target Compose file is missing" >&2
  exit 2
fi

resolved_target=$(cd "${target_compose_dir}" && pwd -P)
if [[ -d ${production_compose_dir} ]]; then
  resolved_production=$(cd "${production_compose_dir}" && pwd -P)
  if [[ ${resolved_target} == "${resolved_production}" ]]; then
    echo "Refusing to restore into the production Compose directory" >&2
    exit 64
  fi
fi

(cd "$(dirname "${backup_file}")" && sha256sum -c "$(basename "${checksum_file}")")
compose=(docker compose -f "${target_compose_dir}/docker-compose.yml")
"${compose[@]}" exec -T "${postgres_service}" pg_restore --list <"${backup_file}" >/dev/null

existing_tables=$("${compose[@]}" exec -T "${postgres_service}" psql -U "${database_user}" -d "${database_name}" -Atc "SELECT count(*) FROM pg_tables WHERE schemaname = 'public';" | tr -d '[:space:]')
if ! [[ ${existing_tables} =~ ^[0-9]+$ ]]; then
  echo "Unable to inspect the target database" >&2
  exit 1
fi
if (( existing_tables > 0 )); then
  echo "Refusing to restore into a non-empty database (${existing_tables} public tables)" >&2
  exit 65
fi

"${compose[@]}" exec -T "${postgres_service}" pg_restore \
  -U "${database_user}" \
  -d "${database_name}" \
  --no-owner \
  --no-privileges \
  --exit-on-error <"${backup_file}"

validation=$("${compose[@]}" exec -T "${postgres_service}" psql -U "${database_user}" -d "${database_name}" -Atc '
SELECT json_build_object(
  '\''users'\'', (SELECT count(*) FROM "User"),
  '\''tasks'\'', (SELECT count(*) FROM "Task"),
  '\''taskChanges'\'', (SELECT count(*) FROM "TaskChange"),
  '\''maxSyncSeq'\'', COALESCE((SELECT max(seq) FROM "TaskChange"), 0),
  '\''migrations'\'', (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL)
);')

echo "restore_status=success target=${resolved_target} validation=${validation}"
