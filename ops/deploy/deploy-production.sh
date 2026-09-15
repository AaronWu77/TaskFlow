#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir=$(cd "$(dirname "$0")/../.." && pwd -P)
target_api_image=${1:-}
target_web_image=${2:-}
if [[ -z ${target_api_image} || -z ${target_web_image} || ${target_api_image} == *:latest || ${target_web_image} == *:latest ]]; then
  echo "Usage: $0 <immutable-api-image-tag> <immutable-web-image-tag>" >&2
  exit 2
fi

cd "${repo_dir}"
compose=(docker compose -f "${repo_dir}/docker-compose.yml")
api_container=$("${compose[@]}" ps -q api)
web_container=$("${compose[@]}" ps -q nginx)
previous_api_image=
previous_web_image=
if [[ -n ${api_container} ]]; then
  previous_api_image=$(docker inspect --format '{{.Config.Image}}' "${api_container}" 2>/dev/null || true)
fi
if [[ -n ${web_container} ]]; then
  previous_web_image=$(docker inspect --format '{{.Config.Image}}' "${web_container}" 2>/dev/null || true)
fi
if [[ (${previous_api_image} == "" || ${previous_web_image} == "") && ${TASKFLOW_ALLOW_DEPLOY_WITHOUT_ROLLBACK:-false} != true ]]; then
  echo "Both current API and web images must be discoverable before deployment; set TASKFLOW_ALLOW_DEPLOY_WITHOUT_ROLLBACK=true only for an explicit first install" >&2
  exit 1
fi

rollback_services() {
  echo "Rolling back API and web services" >&2
  if [[ -n ${previous_api_image} ]]; then export TASKFLOW_API_IMAGE=${previous_api_image}; fi
  if [[ -n ${previous_web_image} ]]; then export TASKFLOW_WEB_IMAGE=${previous_web_image}; fi
  if [[ -n ${previous_api_image} || -n ${previous_web_image} ]]; then
    "${compose[@]}" up -d --no-deps api nginx
  fi
}

if command -v systemctl >/dev/null 2>&1; then
  systemctl start taskflow-backup.service
  if systemctl is-failed --quiet taskflow-backup.service; then
    echo "Pre-deployment backup failed" >&2
    exit 1
  fi
fi

export TASKFLOW_API_IMAGE=${target_api_image}
export TASKFLOW_WEB_IMAGE=${target_web_image}
"${compose[@]}" pull api nginx
"${compose[@]}" run --rm --no-deps api npx prisma migrate deploy --schema=prisma/schema.prisma
"${compose[@]}" up -d --no-deps api

ready=false
for _ in $(seq 1 30); do
  if "${compose[@]}" exec -T api node -e "fetch('http://127.0.0.1:3000/ready').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"; then
    ready=true
    break
  fi
  sleep 2
done

if [[ ${ready} != true ]]; then
  echo "New API failed readiness; rolling back to ${previous_api_image:-unknown}" >&2
  rollback_services
  exit 1
fi

"${compose[@]}" up -d --no-deps nginx
web_ready=false
for _ in $(seq 1 15); do
  if "${compose[@]}" exec -T nginx wget -q -O /dev/null http://127.0.0.1/health \
    && "${compose[@]}" exec -T nginx wget -q --no-check-certificate -O /dev/null https://127.0.0.1/ \
    && "${compose[@]}" exec -T api node -e "fetch('http://127.0.0.1:3000/v1/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"; then
    web_ready=true
    break
  fi
  sleep 2
done

if [[ ${web_ready} != true ]]; then
  echo "New API/web deployment failed final health checks" >&2
  rollback_services
  exit 1
fi

echo "Deployed API ${target_api_image} and web ${target_web_image} successfully"
