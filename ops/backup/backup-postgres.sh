#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

compose_dir=${TASKFLOW_COMPOSE_DIR:-/opt/TaskFlow}
compose_file=${TASKFLOW_COMPOSE_FILE:-${compose_dir}/docker-compose.yml}
backup_dir=${TASKFLOW_BACKUP_DIR:-/opt/taskflow-backups}
postgres_service=${TASKFLOW_POSTGRES_SERVICE:-postgres}
database_name=${TASKFLOW_DB_NAME:-taskflow}
database_user=${TASKFLOW_DB_USER:-taskflow}
retention_count=${TASKFLOW_BACKUP_RETENTION_LOCAL_COUNT:-3}
lock_file=${TASKFLOW_LOCK_FILE:-/run/lock/taskflow-backup.lock}
oss_uri=${TASKFLOW_OSS_URI:-}
ossutil_config=${TASKFLOW_OSSUTIL_CONFIG:-}
oss_sse_algorithm=${TASKFLOW_OSS_SSE_ALGORITHM:-AES256}
oss_kms_key_id=${TASKFLOW_OSS_KMS_KEY_ID:-}

if ! [[ ${retention_count} =~ ^[1-9][0-9]*$ ]]; then
  echo "TASKFLOW_BACKUP_RETENTION_LOCAL_COUNT must be a positive integer" >&2
  exit 2
fi

if [[ ${oss_sse_algorithm} != AES256 && ${oss_sse_algorithm} != KMS ]]; then
  echo "TASKFLOW_OSS_SSE_ALGORITHM must be AES256 or KMS" >&2
  exit 2
fi

for command_name in awk docker sha256sum stat; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "Required command is unavailable: ${command_name}" >&2
    exit 2
  fi
done

file_size() {
  local path=$1
  if stat -c %s "${path}" 2>/dev/null; then
    return
  fi
  stat -f %z "${path}"
}

if [[ ! -f ${compose_file} ]]; then
  echo "Compose file not found: ${compose_file}" >&2
  exit 2
fi

install -d -m 0700 "${backup_dir}"
lock_dir=$(dirname "${lock_file}")
if [[ ! -d ${lock_dir} ]]; then
  install -d -m 0755 "${lock_dir}"
fi
exec 9>"${lock_file}"
lock_directory=
if command -v flock >/dev/null 2>&1; then
  if ! flock -n 9; then
    echo "Another TaskFlow backup is already running" >&2
    exit 75
  fi
else
  lock_directory="${lock_file}.directory"
  if ! mkdir "${lock_directory}" 2>/dev/null; then
    echo "Another TaskFlow backup is already running" >&2
    exit 75
  fi
fi

timestamp=${TASKFLOW_BACKUP_TIMESTAMP:-$(date -u +%Y%m%dT%H%M%SZ)}
if ! [[ ${timestamp} =~ ^[0-9]{8}T[0-9]{6}Z$ ]]; then
  echo "TASKFLOW_BACKUP_TIMESTAMP must use YYYYMMDDTHHMMSSZ" >&2
  exit 2
fi

git_sha=${TASKFLOW_GIT_SHA:-}
if [[ -z ${git_sha} ]]; then
  git_sha=$(git -C "${compose_dir}" rev-parse --short=12 HEAD 2>/dev/null || true)
fi
git_sha=${git_sha:-unknown}
if ! [[ ${git_sha} =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "TASKFLOW_GIT_SHA contains unsupported characters" >&2
  exit 2
fi

compose=(docker compose -f "${compose_file}")
migration_count=$("${compose[@]}" exec -T "${postgres_service}" psql -U "${database_user}" -d "${database_name}" -Atc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL;' | tr -d '[:space:]')
if ! [[ ${migration_count} =~ ^[0-9]+$ ]]; then
  echo "Unable to determine the applied migration count" >&2
  exit 1
fi

base_name="taskflow-${timestamp}-${git_sha}-migration${migration_count}.dump"
final_file="${backup_dir}/${base_name}"
if [[ -e ${final_file} || -e ${final_file}.sha256 || -e ${final_file}.meta ]]; then
  echo "Refusing to overwrite an existing backup set: ${base_name}" >&2
  exit 73
fi
temp_file=$(mktemp "${backup_dir}/.${base_name}.partial.XXXXXX")

cleanup_partial() {
  if [[ -n ${temp_file:-} && -f ${temp_file} ]]; then
    rm -f -- "${temp_file}"
  fi
  if [[ -n ${lock_directory:-} ]]; then
    rmdir "${lock_directory}" 2>/dev/null || true
  fi
}
trap cleanup_partial EXIT

"${compose[@]}" exec -T "${postgres_service}" pg_dump \
  -U "${database_user}" \
  -d "${database_name}" \
  --format=custom \
  --compress=6 \
  --no-owner \
  --no-privileges >"${temp_file}"

if [[ ! -s ${temp_file} ]]; then
  echo "pg_dump produced an empty archive" >&2
  exit 1
fi

"${compose[@]}" exec -T "${postgres_service}" pg_restore --list <"${temp_file}" >/dev/null
chmod 0600 "${temp_file}"
mv -f -- "${temp_file}" "${final_file}"
temp_file=

(cd "${backup_dir}" && sha256sum "${base_name}" >"${base_name}.sha256")
chmod 0600 "${final_file}.sha256"
archive_sha=$(cut -d ' ' -f 1 <"${final_file}.sha256")
archive_bytes=$(file_size "${final_file}")

cat >"${final_file}.meta" <<EOF
createdAt=${timestamp}
database=${database_name}
gitSha=${git_sha}
appliedMigrations=${migration_count}
bytes=${archive_bytes}
sha256=${archive_sha}
EOF
chmod 0600 "${final_file}.meta"

upload_one() {
  local source_file=$1
  local destination=$2
  local expected_bytes
  expected_bytes=$(file_size "${source_file}")
  local args=(ossutil cp "${source_file}" "${destination}" --acl private --sse-algorithm "${oss_sse_algorithm}")
  if [[ ${oss_sse_algorithm} == KMS && -n ${oss_kms_key_id} ]]; then
    args+=(--kms-masterkey-id "${oss_kms_key_id}")
  fi
  if [[ -n ${ossutil_config} ]]; then
    args+=(--config-file "${ossutil_config}")
  fi
  "${args[@]}"
  local stat_args=(ossutil stat "${destination}")
  if [[ -n ${ossutil_config} ]]; then
    stat_args+=(--config-file "${ossutil_config}")
  fi
  local object_metadata
  object_metadata=$("${stat_args[@]}")
  local remote_bytes
  remote_bytes=$(printf '%s\n' "${object_metadata}" | awk -F ':' '
    tolower($1) ~ /^[[:space:]]*(content-length|size|size\(b\))[[:space:]]*$/ {
      value=$2
      gsub(/[[:space:]]/, "", value)
      print value
      exit
    }
  ')
  if [[ ${remote_bytes} != "${expected_bytes}" ]]; then
    echo "OSS object size verification failed for ${destination}: expected ${expected_bytes}, got ${remote_bytes:-missing}" >&2
    return 1
  fi

  local remote_sse
  remote_sse=$(printf '%s\n' "${object_metadata}" | awk -F ':' '
    tolower($1) ~ /^[[:space:]]*(x-oss-server-side-encryption|server-side-encryption|sse)[[:space:]]*$/ {
      value=$2
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      print value
      exit
    }
  ')
  if [[ ${remote_sse} != "${oss_sse_algorithm}" ]]; then
    echo "OSS encryption verification failed for ${destination}: expected ${oss_sse_algorithm}, got ${remote_sse:-missing}" >&2
    return 1
  fi
}

if [[ -n ${oss_uri} ]]; then
  if ! command -v ossutil >/dev/null 2>&1; then
    echo "TASKFLOW_OSS_URI is configured but ossutil is unavailable" >&2
    exit 2
  fi
  remote_base="${oss_uri%/}/${base_name}"
  upload_one "${final_file}" "${remote_base}"
  upload_one "${final_file}.sha256" "${remote_base}.sha256"
  upload_one "${final_file}.meta" "${remote_base}.meta"
fi

# This marker is deliberately local and is created only after every configured
# upload and metadata check succeeded. Consumers must ignore unmarked dumps.
touch "${final_file}.success"
chmod 0600 "${final_file}.success"

backup_index=0
while IFS= read -r old_file; do
  [[ -n ${old_file} ]] || continue
  backup_index=$((backup_index + 1))
  if (( backup_index <= retention_count )); then
    continue
  fi
  if [[ ${old_file} == "${backup_dir}"/taskflow-*.dump ]]; then
    rm -f -- "${old_file}" "${old_file}.sha256" "${old_file}.meta" "${old_file}.success"
  fi
done < <(find "${backup_dir}" -maxdepth 1 -type f -name 'taskflow-*.dump' -print | sort -r)

echo "backup_status=success file=${final_file} bytes=${archive_bytes} sha256=${archive_sha} oss_uploaded=$([[ -n ${oss_uri} ]] && echo true || echo false)"
