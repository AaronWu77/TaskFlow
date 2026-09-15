#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 BACKUP.dump BACKUP.dump.sha256" >&2
  exit 2
fi

backup_file=$1
checksum_file=$2
compose_dir=${TASKFLOW_COMPOSE_DIR:-/opt/TaskFlow}
compose_file=${TASKFLOW_COMPOSE_FILE:-${compose_dir}/docker-compose.yml}
postgres_service=${TASKFLOW_POSTGRES_SERVICE:-postgres}

if [[ ! -f ${backup_file} || ! -f ${checksum_file} ]]; then
  echo "Backup or checksum file is missing" >&2
  exit 2
fi

(cd "$(dirname "${backup_file}")" && sha256sum -c "$(basename "${checksum_file}")")
docker compose -f "${compose_file}" exec -T "${postgres_service}" pg_restore --list <"${backup_file}" >/dev/null
echo "backup_verification=success file=${backup_file}"
