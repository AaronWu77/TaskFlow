#!/usr/bin/env bash
set -Eeuo pipefail

backup_dir=${TASKFLOW_BACKUP_DIR:-/opt/taskflow-backups}
drill_dir=${TASKFLOW_RESTORE_DRILL_DIR:-$(cd "$(dirname "$0")/drill" && pwd -P)}
project_name=${TASKFLOW_RESTORE_DRILL_PROJECT:-taskflow-restore-drill}
lock_file=${TASKFLOW_RESTORE_DRILL_LOCK_FILE:-/run/lock/taskflow-restore-drill.lock}
report_dir=${TASKFLOW_RESTORE_REPORT_DIR:-/opt/taskflow-restore-reports}
restore_api_image=${TASKFLOW_RESTORE_API_IMAGE:-}

if ! [[ ${project_name} =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
  echo "TASKFLOW_RESTORE_DRILL_PROJECT contains unsupported characters" >&2
  exit 2
fi
if [[ ! -f ${drill_dir}/docker-compose.yml ]]; then
  echo "Restore drill Compose file is missing: ${drill_dir}/docker-compose.yml" >&2
  exit 2
fi
for command_name in docker sha256sum; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "Required command is unavailable: ${command_name}" >&2
    exit 2
  fi
done

latest_backup=
while IFS= read -r candidate; do
  if [[ -f ${candidate}.success ]]; then
    latest_backup=${candidate}
    break
  fi
done < <(find "${backup_dir}" -maxdepth 1 -type f -name 'taskflow-*.dump' -print 2>/dev/null | sort -r)
if [[ -z ${latest_backup} || ! -f ${latest_backup}.sha256 ]]; then
  echo "Latest backup or checksum is missing" >&2
  exit 1
fi

install -d -m 0700 "$(dirname "${lock_file}")" "${report_dir}"
exec 9>"${lock_file}"
lock_directory=
if command -v flock >/dev/null 2>&1; then
  if ! flock -n 9; then
    echo "Another TaskFlow restore drill is already running" >&2
    exit 75
  fi
else
  lock_directory="${lock_file}.directory"
  if ! mkdir "${lock_directory}" 2>/dev/null; then
    echo "Another TaskFlow restore drill is already running" >&2
    exit 75
  fi
fi

export COMPOSE_PROJECT_NAME=${project_name}
compose=(docker compose -f "${drill_dir}/docker-compose.yml")
cleanup() {
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  if [[ -n ${lock_directory:-} ]]; then
    rmdir "${lock_directory}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

cleanup
"${compose[@]}" up -d postgres
postgres_id=$("${compose[@]}" ps -q postgres)
if [[ -z ${postgres_id} ]]; then
  echo "Restore drill PostgreSQL container did not start" >&2
  exit 1
fi

for _ in $(seq 1 30); do
  postgres_health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${postgres_id}" 2>/dev/null || true)
  [[ ${postgres_health} == healthy ]] && break
  sleep 2
done
if [[ ${postgres_health:-} != healthy ]]; then
  echo "Restore drill PostgreSQL did not become healthy" >&2
  exit 1
fi

restore_output=$(TASKFLOW_PRODUCTION_COMPOSE_DIR=${TASKFLOW_COMPOSE_DIR:-/opt/TaskFlow} \
  TASKFLOW_DB_USER=taskflow \
  TASKFLOW_DB_NAME=taskflow \
  "$(dirname "$0")/restore-postgres.sh" \
    --backup "${latest_backup}" \
    --checksum "${latest_backup}.sha256" \
    --target-compose-dir "${drill_dir}" \
    --confirm-non-production)

integrity=$("${compose[@]}" exec -T postgres psql -U taskflow -d taskflow -Atc '
SELECT json_build_object(
  '\''orphanTasks'\'', (SELECT count(*) FROM "Task" t LEFT JOIN "User" u ON u.id = t."userId" WHERE u.id IS NULL),
  '\''orphanChanges'\'', (SELECT count(*) FROM "TaskChange" c LEFT JOIN "User" u ON u.id = c."userId" WHERE u.id IS NULL),
  '\''duplicateOperations'\'', (SELECT count(*) FROM (SELECT "userId", "operationId" FROM "TaskOperation" GROUP BY 1, 2 HAVING count(*) > 1) d)
);')
if [[ ${integrity} != '{"orphanTasks" : 0, "orphanChanges" : 0, "duplicateOperations" : 0}' && ${integrity// /} != '{"orphanTasks":0,"orphanChanges":0,"duplicateOperations":0}' ]]; then
  echo "Restore drill integrity validation failed: ${integrity}" >&2
  exit 1
fi

if [[ -z ${restore_api_image} ]]; then
  production_compose_dir=${TASKFLOW_COMPOSE_DIR:-/opt/TaskFlow}
  if [[ -f ${production_compose_dir}/docker-compose.yml ]]; then
    production_api_id=$(docker compose -f "${production_compose_dir}/docker-compose.yml" ps -q api 2>/dev/null || true)
    if [[ -n ${production_api_id} ]]; then
      restore_api_image=$(docker inspect --format '{{.Config.Image}}' "${production_api_id}" 2>/dev/null || true)
    fi
  fi
fi
if [[ -n ${restore_api_image} ]]; then
  export TASKFLOW_RESTORE_API_IMAGE=${restore_api_image}
  "${compose[@]}" up -d api
else
  "${compose[@]}" up -d --build api
fi
api_id=$("${compose[@]}" ps -q api)
for _ in $(seq 1 40); do
  api_health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${api_id}" 2>/dev/null || true)
  [[ ${api_health} == healthy ]] && break
  sleep 3
done
if [[ ${api_health:-} != healthy ]]; then
  echo "Restore drill API did not become healthy" >&2
  exit 1
fi

user_id=$("${compose[@]}" exec -T postgres psql -U taskflow -d taskflow -Atc 'SELECT id FROM "User" WHERE "deletedAt" IS NULL ORDER BY "createdAt" LIMIT 1;' | tr -d '[:space:]')
if [[ -n ${user_id} ]]; then
  "${compose[@]}" exec -T -e DRILL_USER_ID="${user_id}" api node -e '
    const jwt = require("jsonwebtoken");
    const crypto = require("node:crypto");
    const { PrismaClient } = require("@prisma/client");
    const prisma = new PrismaClient();
    let sessionId;
    (async () => {
      const user = await prisma.user.findUniqueOrThrow({ where: { id: process.env.DRILL_USER_ID }, select: { authVersion: true } });
      sessionId = crypto.randomUUID();
      await prisma.refreshSession.create({ data: {
        id: sessionId,
        userId: process.env.DRILL_USER_ID,
        tokenHash: crypto.randomBytes(32).toString("hex"),
        familyId: crypto.randomUUID(),
        expiresAt: new Date(Date.now() + 120000),
        deviceName: "restore-drill",
        platform: "restore-drill",
      } });
      const token = jwt.sign({ userId: process.env.DRILL_USER_ID, authVersion: user.authVersion, sessionId }, process.env.JWT_ACCESS_SECRET, { expiresIn: "2m" });
      const response = await fetch("http://127.0.0.1:3000/sync/bootstrap", { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(`bootstrap ${response.status}: ${await response.text()}`);
    })().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
      if (sessionId) await prisma.refreshSession.deleteMany({ where: { id: sessionId } });
      await prisma.$disconnect();
    });
  '
fi

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
report_file="${report_dir}/restore-drill-${timestamp}.report"
cat >"${report_file}" <<EOF
completedAt=${timestamp}
backup=${latest_backup}
restore=${restore_output}
integrity=${integrity}
apiHealth=healthy
bootstrap=$([[ -n ${user_id} ]] && echo verified || echo skipped-no-active-user)
EOF
chmod 0600 "${report_file}"
echo "restore_drill_status=success backup=${latest_backup} report=${report_file}"
