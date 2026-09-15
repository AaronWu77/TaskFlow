import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = new URL('../', import.meta.url).pathname;
const backupScript = path.join(root, 'ops/backup/backup-postgres.sh');
const verifyScript = path.join(root, 'ops/backup/verify-backup.sh');
const verifyLatestScript = path.join(root, 'ops/backup/verify-latest-backup.sh');
const restoreScript = path.join(root, 'ops/restore/restore-postgres.sh');
const restoreDrillScript = path.join(root, 'ops/restore/run-restore-drill.sh');
const monitorScript = path.join(root, 'ops/monitor/check-taskflow.sh');
const deployScript = path.join(root, 'ops/deploy/deploy-production.sh');
const opsIntegrationScript = path.join(root, 'scripts/run-ops-integration.sh');

for (const script of [backupScript, verifyScript, verifyLatestScript, restoreScript, restoreDrillScript, monitorScript, deployScript, opsIntegrationScript]) {
  test(`${path.basename(script)} has valid bash syntax`, () => {
    const result = spawnSync('bash', ['-n', script], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  });
}

test('backup script creates a checked, private custom archive and prunes only older archives', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'taskflow-backup-test-'));
  const fakeBin = path.join(work, 'bin');
  const composeDir = path.join(work, 'compose');
  const backupDir = path.join(work, 'backups');
  await mkdir(fakeBin);
  await mkdir(composeDir);
  await mkdir(backupDir);
  await writeFile(path.join(composeDir, 'docker-compose.yml'), 'services: {}\n');

  const dockerStub = `#!/usr/bin/env bash
case "$*" in
  *'_prisma_migrations'*) printf '15\\n' ;;
  *'pg_dump'*) printf 'PGDMP-taskflow-test-archive\\n' ;;
  *'pg_restore --list'*) cat >/dev/null ;;
  *) exit 1 ;;
esac
`;
  await writeFile(path.join(fakeBin, 'docker'), dockerStub);
  await chmod(path.join(fakeBin, 'docker'), 0o755);
  await writeFile(path.join(fakeBin, 'flock'), '#!/usr/bin/env bash\nexit 0\n');
  await chmod(path.join(fakeBin, 'flock'), 0o755);
  await writeFile(path.join(fakeBin, 'stat'), '#!/usr/bin/env bash\nwc -c <"${@: -1}" | tr -d " "\n');
  await chmod(path.join(fakeBin, 'stat'), 0o755);

  const baseEnv = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    TASKFLOW_COMPOSE_DIR: composeDir,
    TASKFLOW_BACKUP_DIR: backupDir,
    TASKFLOW_LOCK_FILE: path.join(work, 'backup.lock'),
    TASKFLOW_BACKUP_RETENTION_LOCAL_COUNT: '1',
    TASKFLOW_GIT_SHA: 'abc123',
  };

  for (const timestamp of ['20260914T010000Z', '20260914T020000Z']) {
    const result = spawnSync('bash', [backupScript], {
      env: { ...baseEnv, TASKFLOW_BACKUP_TIMESTAMP: timestamp },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /backup_status=success/);
  }

  const latest = path.join(backupDir, 'taskflow-20260914T020000Z-abc123-migration15.dump');
  assert.equal(await readFile(latest, 'utf8'), 'PGDMP-taskflow-test-archive\n');
  assert.equal((await stat(latest)).mode & 0o777, 0o600);
  assert.equal((await stat(`${latest}.sha256`)).mode & 0o777, 0o600);
  assert.equal((await stat(`${latest}.meta`)).mode & 0o777, 0o600);
  assert.equal((await stat(`${latest}.success`)).mode & 0o777, 0o600);
  assert.match(await readFile(`${latest}.sha256`, 'utf8'), /  taskflow-20260914T020000Z-abc123-migration15\.dump\n$/);
  assert.doesNotMatch(await readFile(`${latest}.sha256`, 'utf8'), new RegExp(work.replaceAll('\\', '\\\\')));
  await assert.rejects(readFile(path.join(backupDir, 'taskflow-20260914T010000Z-abc123-migration15.dump')));
  await assert.rejects(readFile(path.join(backupDir, 'taskflow-20260914T010000Z-abc123-migration15.dump.success')));
});

test('backup script uploads every artifact privately with server-side encryption and verifies it', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'taskflow-oss-test-'));
  const fakeBin = path.join(work, 'bin');
  const composeDir = path.join(work, 'compose');
  const backupDir = path.join(work, 'backups');
  const ossLog = path.join(work, 'oss-calls.log');
  await mkdir(fakeBin);
  await mkdir(composeDir);
  await mkdir(backupDir);
  await writeFile(path.join(composeDir, 'docker-compose.yml'), 'services: {}\n');
  await writeFile(path.join(work, 'ossutil.config'), 'test-only\n');

  await writeFile(path.join(fakeBin, 'docker'), `#!/usr/bin/env bash
case "$*" in
  *'_prisma_migrations'*) printf '15\\n' ;;
  *'pg_dump'*) printf 'PGDMP-taskflow-test-archive\\n' ;;
  *'pg_restore --list'*) cat >/dev/null ;;
  *) exit 1 ;;
esac
`);
  await writeFile(path.join(fakeBin, 'flock'), '#!/usr/bin/env bash\nexit 0\n');
  await writeFile(path.join(fakeBin, 'stat'), '#!/usr/bin/env bash\nwc -c <"${@: -1}" | tr -d " "\n');
  await writeFile(path.join(fakeBin, 'ossutil'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >>"$OSS_TEST_LOG"
if [[ $1 == stat ]]; then
  object_name=\${2##*/}
  printf 'Size(B): %s\\n' "$(wc -c <"$OSS_TEST_BACKUP_DIR/$object_name" | tr -d ' ')"
  printf 'SSE: %s\\n' "$TASKFLOW_OSS_SSE_ALGORITHM"
fi
`);
  for (const command of ['docker', 'flock', 'stat', 'ossutil']) {
    await chmod(path.join(fakeBin, command), 0o755);
  }

  const result = spawnSync('bash', [backupScript], {
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      OSS_TEST_LOG: ossLog,
      OSS_TEST_BACKUP_DIR: backupDir,
      TASKFLOW_COMPOSE_DIR: composeDir,
      TASKFLOW_BACKUP_DIR: backupDir,
      TASKFLOW_LOCK_FILE: path.join(work, 'backup.lock'),
      TASKFLOW_BACKUP_TIMESTAMP: '20260914T030000Z',
      TASKFLOW_GIT_SHA: 'abc123',
      TASKFLOW_OSS_URI: 'oss://private-taskflow/backups',
      TASKFLOW_OSS_SSE_ALGORITHM: 'AES256',
      TASKFLOW_OSSUTIL_CONFIG: path.join(work, 'ossutil.config'),
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /oss_uploaded=true/);
  await stat(path.join(backupDir, 'taskflow-20260914T030000Z-abc123-migration15.dump.success'));
  const calls = (await readFile(ossLog, 'utf8')).trim().split('\n');
  assert.equal(calls.length, 6);
  assert.equal(calls.filter((line) => line.startsWith('cp ')).length, 3);
  assert.equal(calls.filter((line) => line.startsWith('stat ')).length, 3);
  for (const call of calls.filter((line) => line.startsWith('cp '))) {
    assert.match(call, /--acl private/);
    assert.match(call, /--sse-algorithm AES256/);
    assert.match(call, /--config-file /);
  }
});

test('backup script rejects OSS metadata that does not match the uploaded artifact', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'taskflow-oss-mismatch-test-'));
  const fakeBin = path.join(work, 'bin');
  const composeDir = path.join(work, 'compose');
  const backupDir = path.join(work, 'backups');
  await mkdir(fakeBin);
  await mkdir(composeDir);
  await mkdir(backupDir);
  await writeFile(path.join(composeDir, 'docker-compose.yml'), 'services: {}\n');
  await writeFile(path.join(fakeBin, 'docker'), `#!/usr/bin/env bash
case "$*" in
  *'_prisma_migrations'*) printf '15\\n' ;;
  *'pg_dump'*) printf 'PGDMP-taskflow-test-archive\\n' ;;
  *'pg_restore --list'*) cat >/dev/null ;;
  *) exit 1 ;;
esac
`);
  await writeFile(path.join(fakeBin, 'flock'), '#!/usr/bin/env bash\nexit 0\n');
  await writeFile(path.join(fakeBin, 'stat'), '#!/usr/bin/env bash\nwc -c <"${@: -1}" | tr -d " "\n');
  await writeFile(path.join(fakeBin, 'ossutil'), `#!/usr/bin/env bash
if [[ $1 == stat ]]; then
  printf 'Content-Length: 1\\n'
  printf 'X-Oss-Server-Side-Encryption: AES256\\n'
fi
`);
  for (const command of ['docker', 'flock', 'stat', 'ossutil']) {
    await chmod(path.join(fakeBin, command), 0o755);
  }

  const result = spawnSync('bash', [backupScript], {
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      TASKFLOW_COMPOSE_DIR: composeDir,
      TASKFLOW_BACKUP_DIR: backupDir,
      TASKFLOW_LOCK_FILE: path.join(work, 'backup.lock'),
      TASKFLOW_BACKUP_TIMESTAMP: '20260914T031000Z',
      TASKFLOW_GIT_SHA: 'abc123',
      TASKFLOW_OSS_URI: 'oss://private-taskflow/backups',
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /OSS object size verification failed/);
  await assert.rejects(stat(path.join(backupDir, 'taskflow-20260914T031000Z-abc123-migration15.dump.success')));
});

test('backup script rejects an unsupported OSS encryption algorithm', async () => {
  const result = spawnSync('bash', [backupScript], {
    env: { ...process.env, TASKFLOW_OSS_SSE_ALGORITHM: 'none' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /must be AES256 or KMS/);
});

test('restore script refuses the configured production directory before touching the database', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'taskflow-restore-test-'));
  const target = path.join(work, 'production');
  await mkdir(target);
  await writeFile(path.join(target, 'docker-compose.yml'), 'services: {}\n');
  const backup = path.join(work, 'backup.dump');
  const checksum = `${backup}.sha256`;
  await writeFile(backup, 'archive');
  const hash = spawnSync('sha256sum', [backup], { encoding: 'utf8' }).stdout;
  await writeFile(checksum, hash);

  const result = spawnSync('bash', [restoreScript,
    '--backup', backup,
    '--checksum', checksum,
    '--target-compose-dir', target,
    '--confirm-non-production',
  ], {
    env: { ...process.env, TASKFLOW_PRODUCTION_COMPOSE_DIR: target },
    encoding: 'utf8',
  });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /Refusing to restore into the production Compose directory/);
});

test('restore script validates and restores a custom archive into an empty isolated database', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'taskflow-restore-success-test-'));
  const fakeBin = path.join(work, 'bin');
  const target = path.join(work, 'isolated');
  await mkdir(fakeBin);
  await mkdir(target);
  await writeFile(path.join(target, 'docker-compose.yml'), 'services: {}\n');
  const backup = path.join(work, 'taskflow-test.dump');
  const checksum = `${backup}.sha256`;
  await writeFile(backup, 'PGDMP-test-archive\n');
  const hash = spawnSync('sha256sum', [path.basename(backup)], {
    cwd: work,
    encoding: 'utf8',
  }).stdout;
  await writeFile(checksum, hash);
  await writeFile(path.join(fakeBin, 'docker'), `#!/usr/bin/env bash
case "$*" in
  *'pg_restore --list'*) cat >/dev/null ;;
  *'pg_tables'*) printf '0\\n' ;;
  *'pg_restore -U'*) cat >/dev/null ;;
  *'json_build_object'*) printf '{"users":2,"tasks":134,"taskChanges":100,"maxSyncSeq":100,"migrations":15}\\n' ;;
  *) exit 1 ;;
esac
`);
  await chmod(path.join(fakeBin, 'docker'), 0o755);

  const result = spawnSync('bash', [restoreScript,
    '--backup', backup,
    '--checksum', checksum,
    '--target-compose-dir', target,
    '--confirm-non-production',
  ], {
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      TASKFLOW_PRODUCTION_COMPOSE_DIR: path.join(work, 'production'),
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /restore_status=success/);
  assert.match(result.stdout, /"tasks":134/);
});

test('monitor rejects invalid thresholds before running external checks', () => {
  const result = spawnSync('bash', [monitorScript], {
    env: { ...process.env, TASKFLOW_LONG_TRANSACTION_SECONDS: '1); DROP TABLE x; --' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /must be a positive integer/);
});

test('compose and systemd templates retain health, logging, persistence, and hardening controls', async () => {
  const compose = await readFile(path.join(root, 'docker-compose.yml'), 'utf8');
  const nginx = await readFile(path.join(root, 'nginx.conf'), 'utf8');
  const backupTimer = await readFile(path.join(root, 'ops/systemd/taskflow-backup.timer'), 'utf8');
  const backupService = await readFile(path.join(root, 'ops/systemd/taskflow-backup.service'), 'utf8');
  const restoreDrillTimer = await readFile(path.join(root, 'ops/systemd/taskflow-restore-drill.timer'), 'utf8');
  const restoreDrillCompose = await readFile(path.join(root, 'ops/restore/drill/docker-compose.yml'), 'utf8');
  const externalHealth = await readFile(path.join(root, '.github/workflows/production-health.yml'), 'utf8');
  const deployWorkflow = await readFile(path.join(root, '.github/workflows/deploy-production.yml'), 'utf8');
  const deploy = await readFile(deployScript, 'utf8');
  const backendDockerignore = await readFile(path.join(root, 'backend/.dockerignore'), 'utf8');
  assert.match(compose, /max-size:/);
  assert.match(compose, /POSTGRES_PASSWORD:\?POSTGRES_PASSWORD must be set/);
  assert.match(compose, /condition: service_healthy/);
  assert.match(compose, /http:\/\/127\.0\.0\.1:3000\/ready/);
  assert.match(nginx, /gzip on;/);
  assert.match(nginx, /gzip_types[^;]*application\/json/);
  assert.match(backupTimer, /Persistent=true/);
  assert.match(backupService, /ProtectSystem=strict/);
  assert.match(backupService, /ReadWritePaths=\/opt\/taskflow-backups \/run\/lock/);
  assert.match(restoreDrillTimer, /OnCalendar=.*01\.\.07/);
  assert.match(restoreDrillCompose, /prisma migrate deploy --schema=prisma\/schema\.prisma/);
  assert.match(restoreDrillCompose, /TASKFLOW_RESTORE_API_IMAGE/);
  assert.match(externalHealth, /https:\/\/taskflow\.top\/api\/v1\/health/);
  assert.match(externalHealth, /checkend 1209600/);
  assert.match(externalHealth, /if: failure\(\) && env\.ALERT_WEBHOOK_URL != ''/);
  assert.doesNotMatch(externalHealth, /if: failure\(\) && secrets\./);
  assert.match(deployWorkflow, /PROD_KNOWN_HOSTS/);
  assert.doesNotMatch(deployWorkflow, /ssh-keyscan/);
  assert.match(deployWorkflow, /api-image:/);
  assert.match(deployWorkflow, /web-image:/);
  assert.match(deploy, /TASKFLOW_API_IMAGE/);
  assert.match(deploy, /TASKFLOW_WEB_IMAGE/);
  assert.match(deploy, /TASKFLOW_ALLOW_DEPLOY_WITHOUT_ROLLBACK/);
  assert.match(deploy, /rollback_services/);
  assert.match(deploy, /https:\/\/127\.0\.0\.1\//);
  assert.match(deploy, /web_ready/);
  assert.match(await readFile(backupScript, 'utf8'), /\.success/);
  assert.match(await readFile(monitorScript, 'utf8'), /TASKFLOW_OSS_URI is not configured/);
  assert.match(await readFile(monitorScript, 'utf8'), /sync rejection ratio is above/);
  assert.match(await readFile(monitorScript, 'utf8'), /no restore drill report found/);
  assert.match(await readFile(monitorScript, 'utf8'), /PostgreSQL database size is at least/);
  assert.match(await readFile(monitorScript, 'utf8'), /PostgreSQL has recorded .* deadlocks/);
  assert.match(backendDockerignore, /^node_modules\/$/m);
  assert.match(backendDockerignore, /^\.env$/m);
  assert.match(backendDockerignore, /^\.env\.\*$/m);
});

test('deployment rolls both immutable images back when final web checks fail', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'taskflow-deploy-rollback-test-'));
  const fakeBin = path.join(work, 'bin');
  const calls = path.join(work, 'docker-calls.log');
  await mkdir(fakeBin);
  await writeFile(path.join(fakeBin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
  await writeFile(path.join(fakeBin, 'systemctl'), `#!/usr/bin/env bash
if [[ $1 == is-failed ]]; then exit 1; fi
exit 0
`);
  await writeFile(path.join(fakeBin, 'docker'), `#!/usr/bin/env bash
printf '%s|api=%s|web=%s\\n' "$*" "$TASKFLOW_API_IMAGE" "$TASKFLOW_WEB_IMAGE" >>"$DEPLOY_TEST_LOG"
if [[ $1 == inspect && $* == *api-container* ]]; then printf 'registry/api:previous\\n'; exit 0; fi
if [[ $1 == inspect && $* == *web-container* ]]; then printf 'registry/web:previous\\n'; exit 0; fi
if [[ $* == *'ps -q api'* ]]; then printf 'api-container\\n'; exit 0; fi
if [[ $* == *'ps -q nginx'* ]]; then printf 'web-container\\n'; exit 0; fi
if [[ $* == *"fetch('http://127.0.0.1:3000/ready')"* ]]; then exit 0; fi
if [[ $* == *'exec -T nginx wget'* ]]; then exit 1; fi
exit 0
`);
  await chmod(path.join(fakeBin, 'docker'), 0o755);
  await chmod(path.join(fakeBin, 'sleep'), 0o755);
  await chmod(path.join(fakeBin, 'systemctl'), 0o755);

  const result = spawnSync('bash', [deployScript, 'registry/api:new-sha', 'registry/web:new-sha'], {
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      DEPLOY_TEST_LOG: calls,
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Rolling back API and web services/);
  const log = await readFile(calls, 'utf8');
  assert.match(log, /up -d --no-deps api nginx\|api=registry\/api:previous\|web=registry\/web:previous/);
});
