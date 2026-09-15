#!/usr/bin/env bash
set -Eeuo pipefail

backup_dir=${TASKFLOW_BACKUP_DIR:-/opt/taskflow-backups}
latest_backup=
while IFS= read -r candidate; do
  if [[ -f ${candidate}.success ]]; then
    latest_backup=${candidate}
    break
  fi
done < <(find "${backup_dir}" -maxdepth 1 -type f -name 'taskflow-*.dump' -print 2>/dev/null | sort -r)

if [[ -z ${latest_backup} ]]; then
  echo "No TaskFlow backup is available in ${backup_dir}" >&2
  exit 1
fi

"$(dirname "$0")/verify-backup.sh" "${latest_backup}" "${latest_backup}.sha256"
echo "backup_verification_status=success file=${latest_backup}"
