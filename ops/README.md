# TaskFlow production operations

This directory contains versioned templates and scripts. Production credentials and generated backups must remain outside the repository.

## Install

1. Copy `ops/taskflow-ops.env.example` to `/etc/taskflow/ops.env`, set owner `root:root`, mode `0600`, and fill in the private OSS URI and ossutil configuration path.
   Set one identical random value as `OPS_METRICS_TOKEN` in `/opt/TaskFlow/.env` and `TASKFLOW_OPS_METRICS_TOKEN` in `/etc/taskflow/ops.env`; the protected metrics endpoint is disabled when the application value is empty.
2. Install and configure ossutil v2 with a least-privilege RAM role or RAM user. The identity needs only the target prefix permissions required to upload and inspect backup objects.
3. Copy all unit files from `ops/systemd/` to `/etc/systemd/system/`.
4. Run one manual backup and verify it before enabling the timer.
5. Restore that backup into an isolated empty PostgreSQL Compose environment.
6. Enable the backup, archive verification, restore drill, and monitoring timers only after both checks pass.

Example commands are intentionally split so a failed verification cannot silently enable scheduling:

```bash
sudo install -d -m 0700 /etc/taskflow /opt/taskflow-backups /opt/taskflow-restore-reports
sudo install -m 0600 ops/taskflow-ops.env.example /etc/taskflow/ops.env
sudo install -m 0644 ops/systemd/taskflow-*.service ops/systemd/taskflow-*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl start taskflow-backup.service
sudo systemctl status taskflow-backup.service
sudo systemctl enable --now taskflow-backup.timer taskflow-backup-verify.timer
sudo systemctl enable --now taskflow-restore-drill.timer taskflow-monitor.timer
```

Do not run the restore script against `/opt/TaskFlow`. It refuses the configured production directory and refuses any target database with existing public tables.

```bash
ops/restore/restore-postgres.sh \
  --backup /secure/path/taskflow-example.dump \
  --checksum /secure/path/taskflow-example.dump.sha256 \
  --target-compose-dir /opt/taskflow-restore-drill \
  --confirm-non-production
```

Inspect operations with:

```bash
systemctl list-timers 'taskflow-*'
journalctl -u taskflow-backup.service --since today
journalctl -u taskflow-monitor.service --since today
journalctl -u taskflow-backup-verify.service --since '7 days ago'
journalctl -u taskflow-restore-drill.service --since '35 days ago'
```

The weekly verification rereads the newest archive and checksum. The monthly drill creates an isolated Compose project and volume, restores the newest backup, checks orphaned records and duplicate operation IDs, starts a temporary API, calls an authenticated Bootstrap request when an active user exists, writes a private report, and always removes the temporary containers and volume. It never publishes a database or API port.

`.github/workflows/production-health.yml` checks the public endpoint and TLS from outside the production host every ten minutes. Configure the repository secret `TASKFLOW_ALERT_WEBHOOK_URL` for an additional failure notification; GitHub's failed-workflow notification remains the fallback.

OSS must use a private bucket, server-side encryption, versioning, and lifecycle retention for 7 daily, 4 weekly, and 12 monthly copies. The backup identity should have only upload and object-inspection permissions for the configured prefix. Apply and verify these controls in the Alibaba Cloud console before enabling production uploads.

The first production target is a 24-hour RPO and a 2-hour RTO. WAL archiving and point-in-time recovery are a later step after custom-format backup and restore drills are proven reliable. A timer or workflow file being present is not proof of recovery: phase one is accepted only after three scheduled production backups and one successful restore from an OSS-downloaded archive.
