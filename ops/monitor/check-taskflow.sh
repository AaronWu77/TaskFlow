#!/usr/bin/env bash
set -Eeuo pipefail

health_url=${TASKFLOW_HEALTH_URL:-https://taskflow.top/api/v1/health}
tls_host=${TASKFLOW_TLS_HOST:-taskflow.top}
disk_path=${TASKFLOW_DISK_PATH:-/var/lib/docker}
backup_dir=${TASKFLOW_BACKUP_DIR:-/opt/taskflow-backups}
oss_uri=${TASKFLOW_OSS_URI:-}
restore_report_dir=${TASKFLOW_RESTORE_REPORT_DIR:-/opt/taskflow-restore-reports}
compose_dir=${TASKFLOW_COMPOSE_DIR:-/opt/TaskFlow}
backup_max_age_hours=${TASKFLOW_BACKUP_MAX_AGE_HOURS:-30}
disk_warn_percent=${TASKFLOW_DISK_WARN_PERCENT:-70}
disk_critical_percent=${TASKFLOW_DISK_CRITICAL_PERCENT:-85}
tls_warn_days=${TASKFLOW_TLS_WARN_DAYS:-30}
long_transaction_seconds=${TASKFLOW_LONG_TRANSACTION_SECONDS:-300}
alert_webhook=${TASKFLOW_ALERT_WEBHOOK_URL:-}
metrics_url=${TASKFLOW_METRICS_URL:-https://taskflow.top/api/v1/ops/metrics}
metrics_token=${TASKFLOW_OPS_METRICS_TOKEN:-}
server_error_critical_percent=${TASKFLOW_5XX_CRITICAL_PERCENT:-5}
p95_warn_ms=${TASKFLOW_P95_WARN_MS:-2000}
sync_conflict_warn_percent=${TASKFLOW_SYNC_CONFLICT_WARN_PERCENT:-20}
sync_rejection_critical_percent=${TASKFLOW_SYNC_REJECTION_CRITICAL_PERCENT:-5}
restore_report_max_age_hours=${TASKFLOW_RESTORE_REPORT_MAX_AGE_HOURS:-840}
db_size_warn_mb=${TASKFLOW_DB_SIZE_WARN_MB:-1024}

failures=()
warnings=()

require_positive_integer() {
  local name=$1
  local value=$2
  if ! [[ ${value} =~ ^[1-9][0-9]*$ ]]; then
    echo "${name} must be a positive integer" >&2
    exit 2
  fi
}

require_positive_integer TASKFLOW_BACKUP_MAX_AGE_HOURS "${backup_max_age_hours}"
require_positive_integer TASKFLOW_DISK_WARN_PERCENT "${disk_warn_percent}"
require_positive_integer TASKFLOW_DISK_CRITICAL_PERCENT "${disk_critical_percent}"
require_positive_integer TASKFLOW_TLS_WARN_DAYS "${tls_warn_days}"
require_positive_integer TASKFLOW_LONG_TRANSACTION_SECONDS "${long_transaction_seconds}"
require_positive_integer TASKFLOW_5XX_CRITICAL_PERCENT "${server_error_critical_percent}"
require_positive_integer TASKFLOW_P95_WARN_MS "${p95_warn_ms}"
require_positive_integer TASKFLOW_SYNC_CONFLICT_WARN_PERCENT "${sync_conflict_warn_percent}"
require_positive_integer TASKFLOW_SYNC_REJECTION_CRITICAL_PERCENT "${sync_rejection_critical_percent}"
require_positive_integer TASKFLOW_RESTORE_REPORT_MAX_AGE_HOURS "${restore_report_max_age_hours}"
require_positive_integer TASKFLOW_DB_SIZE_WARN_MB "${db_size_warn_mb}"
if (( disk_warn_percent >= disk_critical_percent || disk_critical_percent > 100 )); then
  echo "Disk thresholds must satisfy 0 < warning < critical <= 100" >&2
  exit 2
fi

if [[ -z ${metrics_token} ]]; then
  failures+=("TASKFLOW_OPS_METRICS_TOKEN is not configured")
elif ! metrics_body=$(curl --fail --silent --show-error --max-time 10 -H "Authorization: Bearer ${metrics_token}" "${metrics_url}"); then
  failures+=("protected API metrics endpoint failed")
else
  json_number() {
    local key=$1
    printf '%s' "${metrics_body}" | sed -nE "s/.*\"${key}\":([0-9]+([.][0-9]+)?).*/\1/p"
  }
  metric_samples=$(json_number sampleSize)
  metric_5xx_ratio=$(json_number serverErrorRatio)
  metric_p95=$(json_number p95DurationMs)
  metric_p99=$(json_number p99DurationMs)
  metric_conflict_ratio=$(json_number conflictRatio)
  metric_rejection_ratio=$(json_number rejectionRatio)
  metric_sync_accepted=$(json_number accepted)
  metric_sync_conflicts=$(json_number conflicts)
  metric_sync_rejected=$(json_number rejected)
  if [[ -z ${metric_samples:-} ]]; then
    failures+=("API metrics response is invalid")
  elif (( metric_samples >= 20 )); then
    if awk -v ratio="${metric_5xx_ratio}" -v threshold="${server_error_critical_percent}" 'BEGIN { exit !(ratio * 100 >= threshold) }'; then
      failures+=("API 5xx ratio is above ${server_error_critical_percent}%")
    fi
    if awk -v latency="${metric_p95}" -v threshold="${p95_warn_ms}" 'BEGIN { exit !(latency >= threshold) }'; then
      warnings+=("API p95 latency is ${metric_p95}ms and p99 is ${metric_p99}ms")
    fi
  fi
  if [[ ${metric_sync_accepted:-} =~ ^[0-9]+$ && ${metric_sync_conflicts:-} =~ ^[0-9]+$ && ${metric_sync_rejected:-} =~ ^[0-9]+$ \
    && ${metric_conflict_ratio:-} =~ ^[0-9]+([.][0-9]+)?$ && ${metric_rejection_ratio:-} =~ ^[0-9]+([.][0-9]+)?$ ]]; then
    metric_sync_total=$((metric_sync_accepted + metric_sync_conflicts + metric_sync_rejected))
    if (( metric_sync_total >= 20 )); then
      if awk -v ratio="${metric_rejection_ratio}" -v threshold="${sync_rejection_critical_percent}" 'BEGIN { exit !(ratio * 100 >= threshold) }'; then
        failures+=("sync rejection ratio is above ${sync_rejection_critical_percent}%")
      fi
      if awk -v ratio="${metric_conflict_ratio}" -v threshold="${sync_conflict_warn_percent}" 'BEGIN { exit !(ratio * 100 >= threshold) }'; then
        warnings+=("sync conflict ratio is above ${sync_conflict_warn_percent}%")
      fi
    fi
  else
    failures+=("API sync metrics response is invalid")
  fi
fi

if ! health_body=$(curl --fail --silent --show-error --max-time 10 "${health_url}"); then
  failures+=("public health endpoint failed: ${health_url}")
elif [[ ${health_body} != *'"status":"ok"'* && ${health_body} != *'"status": "ok"'* ]]; then
  failures+=("public health endpoint returned an unexpected body")
fi

latest_restore_report=$(find "${restore_report_dir}" -maxdepth 1 -type f -name 'restore-drill-*.report' -print 2>/dev/null | sort -r | head -1)
if [[ -z ${latest_restore_report} ]]; then
  failures+=("no restore drill report found")
else
  restore_report_epoch=$(stat -c %Y "${latest_restore_report}" 2>/dev/null || true)
  if ! [[ ${restore_report_epoch} =~ ^[0-9]+$ ]]; then
    failures+=("unable to read latest restore drill report time")
  elif (( $(date +%s) - restore_report_epoch > restore_report_max_age_hours * 3600 )); then
    failures+=("latest restore drill report is older than ${restore_report_max_age_hours} hours")
  fi
fi

disk_percent=$(df -P "${disk_path}" | awk 'NR==2 {gsub(/%/, "", $5); print $5}')
if ! [[ ${disk_percent} =~ ^[0-9]+$ ]]; then
  failures+=("unable to read disk usage for ${disk_path}")
elif (( disk_percent >= disk_critical_percent )); then
  failures+=("disk usage is ${disk_percent}%")
elif (( disk_percent >= disk_warn_percent )); then
  warnings+=("disk usage is ${disk_percent}%")
fi

if [[ -z ${oss_uri} ]]; then
  failures+=("TASKFLOW_OSS_URI is not configured")
fi

latest_backup_file=
while IFS= read -r candidate; do
  if [[ -f ${candidate}.success ]]; then
    latest_backup_file=${candidate}
    break
  fi
done < <(find "${backup_dir}" -maxdepth 1 -type f -name 'taskflow-*.dump' -print 2>/dev/null | sort -r)
if [[ -z ${latest_backup_file} ]]; then
  failures+=("no verified-format local backup found")
else
  latest_backup_epoch=$(stat -c %Y "${latest_backup_file}" 2>/dev/null || true)
  if ! [[ ${latest_backup_epoch} =~ ^[0-9]+$ ]]; then
    failures+=("unable to read latest backup modification time")
    latest_backup_epoch=$(date +%s)
  fi
  backup_age_seconds=$(( $(date +%s) - latest_backup_epoch ))
  if (( backup_age_seconds > backup_max_age_hours * 3600 )); then
    failures+=("latest backup is older than ${backup_max_age_hours} hours")
  fi
  if [[ ! -f ${latest_backup_file}.sha256 ]]; then
    failures+=("latest backup checksum is missing")
  elif ! (cd "${backup_dir}" && sha256sum -c "$(basename "${latest_backup_file}.sha256")" >/dev/null); then
    failures+=("latest backup checksum validation failed")
  fi
fi

if [[ ! -f ${compose_dir}/docker-compose.yml ]]; then
  failures+=("production Compose file is missing")
else
  compose=(docker compose -f "${compose_dir}/docker-compose.yml")
  for service in postgres api nginx; do
    container_id=$("${compose[@]}" ps -q "${service}" 2>/dev/null || true)
    if [[ -z ${container_id} ]]; then
      failures+=("${service} container is missing")
      continue
    fi
    container_state=$(docker inspect --format '{{.State.Status}}' "${container_id}" 2>/dev/null || true)
    health_state=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${container_id}" 2>/dev/null || true)
    restart_count=$(docker inspect --format '{{.RestartCount}}' "${container_id}" 2>/dev/null || true)
    if [[ ${container_state} != running ]]; then
      failures+=("${service} container state is ${container_state:-unknown}")
    elif [[ ${health_state} != healthy ]]; then
      failures+=("${service} container health is ${health_state:-unknown}")
    fi
    if [[ ${restart_count} =~ ^[0-9]+$ ]] && (( restart_count > 0 )); then
      warnings+=("${service} container has restarted ${restart_count} times")
    fi
  done

  long_transactions=$("${compose[@]}" exec -T postgres psql -U "${TASKFLOW_DB_USER:-taskflow}" -d "${TASKFLOW_DB_NAME:-taskflow}" -Atc "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND xact_start IS NOT NULL AND now() - xact_start > make_interval(secs => ${long_transaction_seconds});" 2>/dev/null | tr -d '[:space:]' || true)
  if ! [[ ${long_transactions} =~ ^[0-9]+$ ]]; then
    warnings+=("unable to inspect PostgreSQL long transactions")
  elif (( long_transactions > 0 )); then
    warnings+=("PostgreSQL has ${long_transactions} transactions older than ${long_transaction_seconds} seconds")
  fi

  database_stats=$("${compose[@]}" exec -T postgres psql -U "${TASKFLOW_DB_USER:-taskflow}" -d "${TASKFLOW_DB_NAME:-taskflow}" -AtF ' ' -c "SELECT numbackends, pg_database_size(datname), deadlocks, current_setting('max_connections') FROM pg_stat_database WHERE datname = current_database();" 2>/dev/null || true)
  read -r db_connections db_bytes db_deadlocks db_max_connections <<<"${database_stats}"
  if ! [[ ${db_connections:-} =~ ^[0-9]+$ && ${db_bytes:-} =~ ^[0-9]+$ && ${db_deadlocks:-} =~ ^[0-9]+$ && ${db_max_connections:-} =~ ^[0-9]+$ ]]; then
    warnings+=("unable to inspect PostgreSQL database statistics")
  else
    if (( db_connections * 100 >= db_max_connections * 80 )); then
      warnings+=("PostgreSQL connection usage is at least 80% (${db_connections}/${db_max_connections})")
    fi
    if (( db_bytes >= db_size_warn_mb * 1024 * 1024 )); then
      warnings+=("PostgreSQL database size is at least ${db_size_warn_mb} MiB (${db_bytes} bytes)")
    fi
    if (( db_deadlocks > 0 )); then
      warnings+=("PostgreSQL has recorded ${db_deadlocks} deadlocks since statistics were reset")
    fi
  fi
fi

if ! openssl s_client -servername "${tls_host}" -connect "${tls_host}:443" </dev/null 2>/dev/null \
  | openssl x509 -noout -checkend "$((tls_warn_days * 86400))" >/dev/null 2>&1; then
  warnings+=("TLS certificate expires within ${tls_warn_days} days or could not be checked")
fi

emit_alert() {
  local severity=$1
  local message=$2
  echo "monitor_severity=${severity} message=${message}" >&2
  if [[ -n ${alert_webhook} ]]; then
    local escaped=${message//\\/\\\\}
    escaped=${escaped//\"/\\\"}
    curl --fail --silent --show-error --max-time 10 \
      -H 'Content-Type: application/json' \
      --data "{\"service\":\"taskflow\",\"severity\":\"${severity}\",\"message\":\"${escaped}\"}" \
      "${alert_webhook}" >/dev/null || true
  fi
}

for warning in "${warnings[@]}"; do
  emit_alert warning "${warning}"
done
if (( ${#failures[@]} > 0 )); then
  for failure in "${failures[@]}"; do
    emit_alert critical "${failure}"
  done
  exit 1
fi

echo "monitor_status=ok disk_percent=${disk_percent} backup_age_seconds=${backup_age_seconds:-unknown}"
