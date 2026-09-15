#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir=$(cd "$(dirname "$0")/.." && pwd -P)
compose_file="${repo_dir}/backend/test/docker-compose.integration.yml"
export COMPOSE_PROJECT_NAME=taskflow-integration
compose=(docker compose -f "${compose_file}")
api_pid=
api_log=$(mktemp -t taskflow-integration-api.XXXXXX)

cleanup() {
  if [[ -n ${api_pid} ]] && kill -0 "${api_pid}" 2>/dev/null; then
    kill "${api_pid}" 2>/dev/null || true
    wait "${api_pid}" 2>/dev/null || true
  fi
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -f -- "${api_log}"
}
trap cleanup EXIT
cleanup
"${compose[@]}" up -d postgres

postgres_id=$("${compose[@]}" ps -q postgres)
for _ in $(seq 1 30); do
  health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${postgres_id}" 2>/dev/null || true)
  [[ ${health} == healthy ]] && break
  sleep 2
done
if [[ ${health:-} != healthy ]]; then
  "${compose[@]}" logs postgres >&2
  exit 1
fi

export DATABASE_URL=postgresql://taskflow:taskflow_integration_password@127.0.0.1:39002/taskflow_integration
export JWT_ACCESS_SECRET=integration-access-secret-at-least-32-characters
export JWT_REFRESH_SECRET=integration-refresh-secret-at-least-32-characters
export PORT=39001
export NODE_ENV=development
export COOKIE_SECURE=false
export CORS_ORIGIN=http://127.0.0.1:39001,capacitor://localhost
export EMAIL_VERIFICATION_CONSOLE=true

npm --prefix "${repo_dir}/backend" run build
npm --prefix "${repo_dir}/backend" run db:migrate
(
  cd "${repo_dir}/backend"
  npx prisma migrate diff \
    --from-url "${DATABASE_URL}" \
    --to-schema-datamodel src/prisma/schema.prisma \
    --exit-code
)
node "${repo_dir}/backend/dist/index.js" >"${api_log}" 2>&1 &
api_pid=$!
for _ in $(seq 1 30); do
  if curl --fail --silent http://127.0.0.1:39001/ready >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "${api_pid}" 2>/dev/null; then
    cat "${api_log}" >&2
    exit 1
  fi
  sleep 1
done
if ! curl --fail --silent http://127.0.0.1:39001/ready >/dev/null; then
  cat "${api_log}" >&2
  exit 1
fi

node "${repo_dir}/scripts/postgres-sync.integration.mjs"

user_id=$("${compose[@]}" exec -T postgres psql -U taskflow -d taskflow_integration -Atc 'SELECT id FROM "User" ORDER BY "createdAt" LIMIT 1;')
assert_rejected() {
  local label=$1
  local sql=$2
  if "${compose[@]}" exec -T postgres psql -v ON_ERROR_STOP=1 -U taskflow -d taskflow_integration -c "${sql}" >/dev/null 2>&1; then
    echo "Database accepted invalid ${label}" >&2
    exit 1
  fi
}
assert_rejected priority "INSERT INTO \"Task\" (id, \"userId\", title, priority, status, progress, \"sortOrder\", \"createdAt\", \"updatedAt\") VALUES ('invalid-priority', '${user_id}', 'invalid', 'P9', 'todo', 0, 0, NOW(), NOW());"
assert_rejected progress "INSERT INTO \"Task\" (id, \"userId\", title, priority, status, progress, \"sortOrder\", \"createdAt\", \"updatedAt\") VALUES ('invalid-progress', '${user_id}', 'invalid', 'P1', 'todo', 101, 0, NOW(), NOW());"
assert_rejected completion "INSERT INTO \"Task\" (id, \"userId\", title, priority, status, progress, \"sortOrder\", \"createdAt\", \"updatedAt\") VALUES ('invalid-completion', '${user_id}', 'invalid', 'P1', 'done', 100, 0, NOW(), NOW());"
echo "database_constraint_status=ok"
