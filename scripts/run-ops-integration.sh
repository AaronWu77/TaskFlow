#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir=$(cd "$(dirname "$0")/.." && pwd -P)
source_compose_file="${repo_dir}/backend/test/docker-compose.integration.yml"
source_project=taskflow-ops-source
drill_project=taskflow-ops-restore
work_dir=$(mktemp -d "${TMPDIR:-/tmp}/taskflow-ops-integration.XXXXXX")
backup_dir="${work_dir}/backups"
report_dir="${work_dir}/reports"
restore_api_image=taskflow-ops-api:integration
mkdir -p "${backup_dir}" "${report_dir}"

source_compose=(docker compose -p "${source_project}" -f "${source_compose_file}")
cleanup() {
  "${source_compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  docker compose -p "${drill_project}" -f "${repo_dir}/ops/restore/drill/docker-compose.yml" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf -- "${work_dir}"
}
trap cleanup EXIT

"${source_compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
"${source_compose[@]}" up -d postgres
source_id=$("${source_compose[@]}" ps -q postgres)
for _ in $(seq 1 30); do
  source_health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${source_id}" 2>/dev/null || true)
  [[ ${source_health} == healthy ]] && break
  sleep 1
done
if [[ ${source_health:-} != healthy ]]; then
  echo "Source PostgreSQL did not become healthy" >&2
  exit 1
fi

(
  cd "${repo_dir}"
  DATABASE_URL=postgresql://taskflow:taskflow_integration_password@127.0.0.1:39002/taskflow_integration \
    npm --prefix backend run db:migrate
)

"${source_compose[@]}" exec -T postgres psql -U taskflow -d taskflow_integration -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO "User" (
  "id", "email", "password", "emailVerifiedAt", "passwordChangedAt", "authVersion", "createdAt", "updatedAt"
) VALUES (
  'ops-restore-user', 'ops-restore@taskflow.invalid', 'not-used-by-the-drill', NOW(), NOW(), 1, NOW(), NOW()
);
INSERT INTO "Task" (
  "id", "userId", "title", "priority", "status", "progress", "dueDate", "sortOrder", "version", "createdAt", "updatedAt"
) VALUES (
  'ops-restore-task', 'ops-restore-user', 'Restore drill task', 'P1', 'todo', 0, '2026-09-15', 0, 1, NOW(), NOW()
);
SQL

docker build -t "${restore_api_image}" "${repo_dir}/backend"

COMPOSE_PROJECT_NAME=${source_project} \
TASKFLOW_COMPOSE_DIR="$(dirname "${source_compose_file}")" \
TASKFLOW_COMPOSE_FILE="${source_compose_file}" \
TASKFLOW_BACKUP_DIR="${backup_dir}" \
TASKFLOW_POSTGRES_SERVICE=postgres \
TASKFLOW_DB_NAME=taskflow_integration \
TASKFLOW_DB_USER=taskflow \
TASKFLOW_LOCK_FILE="${work_dir}/backup.lock" \
TASKFLOW_BACKUP_TIMESTAMP=20260915T000000Z \
TASKFLOW_GIT_SHA=ops-integration \
  "${repo_dir}/ops/backup/backup-postgres.sh"

TASKFLOW_BACKUP_DIR="${backup_dir}" \
TASKFLOW_RESTORE_REPORT_DIR="${report_dir}" \
TASKFLOW_RESTORE_API_IMAGE="${restore_api_image}" \
TASKFLOW_RESTORE_DRILL_PROJECT=${drill_project} \
TASKFLOW_RESTORE_DRILL_LOCK_FILE="${work_dir}/restore.lock" \
TASKFLOW_COMPOSE_DIR="$(dirname "${source_compose_file}")" \
  "${repo_dir}/ops/restore/run-restore-drill.sh"

report=$(find "${report_dir}" -maxdepth 1 -type f -name 'restore-drill-*.report' -print | head -1)
test -n "${report}"
grep -q '^apiHealth=healthy$' "${report}"
grep -q '^bootstrap=verified$' "${report}"
echo "ops_restore_integration_status=ok"
