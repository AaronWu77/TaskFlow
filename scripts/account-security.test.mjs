import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const read = (relative) => readFileSync(new URL(relative, root), 'utf8');

test('account deletion is recoverable, recently authenticated, and eventually purged', () => {
  const userRoute = read('backend/src/routes/user.ts');
  const maintenance = read('backend/src/services/maintenance.ts');
  assert.match(userRoute, /router\.delete\('\/account', sensitiveAuthMiddleware/);
  assert.match(userRoute, /deleteScheduledFor = new Date\(now\.getTime\(\) \+ 14/);
  assert.match(userRoute, /action: 'scheduled'/);
  assert.doesNotMatch(userRoute, /router\.delete\('\/account'[\s\S]{0,1000}tx\.user\.delete/);
  assert.match(maintenance, /deleteScheduledFor: \{ lte: now \}/);
  assert.match(maintenance, /action: 'permanently-deleted'/);
});

test('refresh sessions detect rotated-token reuse and expose no token hashes', () => {
  const authRoute = read('backend/src/routes/auth.ts');
  const userRoute = read('backend/src/routes/user.ts');
  assert.match(authRoute, /session\?\.revokedAt && session\.rotatedAt/);
  assert.match(authRoute, /familyId: session\.familyId/);
  assert.match(authRoute, /REFRESH_REUSE_DETECTED/);
  assert.match(authRoute, /REFRESH_ROTATION_IN_PROGRESS/);
  assert.match(authRoute, /REFRESH_ROTATION_GRACE_MS/);
  assert.match(userRoute, /router\.get\('\/sessions'/);
  assert.doesNotMatch(userRoute, /select: \{[^}]*tokenHash/);
});

test('account exports are versioned, checksummed, and omit authentication secrets', () => {
  const userRoute = read('backend/src/routes/user.ts');
  const schema = JSON.parse(read('public/schemas/export-v2.json'));
  assert.equal(schema.properties.exportSchemaVersion.const, 2);
  assert.match(userRoute, /exportSchemaVersion: 2/);
  assert.match(userRoute, /createHash\('sha256'\)/);
  const exportBlock = userRoute.slice(userRoute.indexOf("router.get('/export'"), userRoute.indexOf("router.delete('/account'"));
  assert.doesNotMatch(exportBlock, /tokenHash|codeHash|password:/);
});

test('the client exposes password reset, account recovery, and session management flows', () => {
  const authPage = read('src/app/AuthPage.tsx');
  const app = read('src/app/App.tsx');
  const api = read('src/app/api.ts');
  assert.match(authPage, /apiRequestPasswordReset/);
  assert.match(authPage, /apiConfirmAccountRestore/);
  assert.match(app, /function SecurityDialog/);
  assert.match(app, /apiRevokeAllSessions/);
  assert.match(api, /export async function apiChangePassword/);
});
