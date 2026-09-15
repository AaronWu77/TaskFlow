import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('../backend/node_modules/@prisma/client');
const { runMaintenance } = require('../backend/dist/services/maintenance.js');
const database = new PrismaClient();

const baseUrl = process.env.TASKFLOW_INTEGRATION_API_URL || 'http://127.0.0.1:39001/v1';

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  return { response, data };
}

async function createAccount(label) {
  const email = `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
  const password = 'Integration123!';
  const registration = await request('/auth/register', { method: 'POST', body: JSON.stringify({ email, password }) });
  assert.equal(registration.response.status, 201, JSON.stringify(registration.data));
  assert.match(registration.data.devCode, /^\d{6}$/);
  const verification = await request('/auth/verify-email', {
    method: 'POST',
    headers: { 'X-TaskFlow-Platform': 'native', Origin: 'capacitor://localhost' },
    body: JSON.stringify({ email, code: registration.data.devCode }),
  });
  assert.equal(verification.response.status, 200, JSON.stringify(verification.data));
  return { email, password, user: verification.data.user, token: verification.data.accessToken, refreshToken: verification.data.refreshToken };
}

async function push(account, operations, deviceId = 'shared-device-id') {
  const result = await request('/sync/push', {
    method: 'POST',
    headers: { Authorization: `Bearer ${account.token}` },
    body: JSON.stringify({ deviceId, platform: 'integration', operations }),
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.data));
  return result.data;
}

async function authenticated(account, path, options = {}) {
  return request(path, {
    ...options,
    headers: { Authorization: `Bearer ${account.token}`, ...(options.headers || {}) },
  });
}

function taskPayload(title, sortOrder = 0) {
  return {
    title,
    priority: 'P2',
    estimateMinutes: null,
    progress: 0,
    status: 'todo',
    dueDate: '2026-09-14',
    reminderAt: null,
    repeatRule: 'none',
    repeatUntilDate: null,
    seriesId: null,
    occurrenceDate: null,
    sortOrder,
  };
}

const accountA = await createAccount('sync-a');
const accountB = await createAccount('sync-b');

const initialA = await request('/sync/bootstrap', { headers: { Authorization: `Bearer ${accountA.token}` } });
assert.equal(initialA.response.status, 200);
assert.equal(initialA.data.protocolVersion, 2);
assert.match(initialA.data.snapshotId, /^[0-9a-f-]{36}$/);

const sharedOperationId = `shared-op-${Date.now()}`;
const createA = await push(accountA, [{ operationId: sharedOperationId, type: 'create', clientTaskId: 'a-local', payload: taskPayload('A task') }]);
const createB = await push(accountB, [{ operationId: sharedOperationId, type: 'create', clientTaskId: 'b-local', payload: taskPayload('B task') }]);
assert.equal(createA.accepted.length, 1);
assert.equal(createB.accepted.length, 1);
assert.notEqual(createA.accepted[0].task.id, createB.accepted[0].task.id);
assert.equal(createA.accepted[0].order.taskOrderVersion, 2);

for (let index = 0; index < 10; index += 1) {
  const replay = await push(accountA, [{ operationId: sharedOperationId, type: 'create', clientTaskId: 'a-local', payload: taskPayload('A task') }]);
  assert.equal(replay.accepted[0].replayed, true);
}

// One hundred replays, including concurrent requests, must remain a single write.
const replayResults = await Promise.all(Array.from({ length: 100 }, () => push(accountB, [{
  operationId: sharedOperationId,
  type: 'create',
  clientTaskId: 'b-local',
  payload: taskPayload('B task'),
}])));
assert.equal(replayResults.every(result => result.accepted[0]?.replayed === true), true);
const bootstrapA = await request('/sync/bootstrap', { headers: { Authorization: `Bearer ${accountA.token}` } });
const bootstrapB = await request('/sync/bootstrap', { headers: { Authorization: `Bearer ${accountB.token}` } });
assert.deepEqual(bootstrapA.data.tasks.map(task => task.title), ['A task']);
assert.deepEqual(bootstrapB.data.tasks.map(task => task.title), ['B task']);

// New recurrence protocol stores one authoritative series and materializes only
// the rolling server window instead of accepting hundreds of client-created rows.
const seriesId = `series-${Date.now()}`;
const seriesPayload = {
  ...taskPayload('authoritative series'),
  repeatRule: 'daily',
  repeatUntilDate: '2027-09-14',
  seriesId,
  occurrenceDate: '2026-09-14',
  timezone: 'Asia/Shanghai',
};
const createdSeries = await push(accountB, [{
  operationId: `create-series-${Date.now()}`,
  type: 'create-series',
  clientTaskId: 'series-local',
  payload: seriesPayload,
}], 'series-device');
assert.ok(createdSeries.accepted[0].tasks.length > 1);
assert.ok(createdSeries.accepted[0].tasks.length <= 100);
assert.equal(createdSeries.accepted[0].series.version, 1);
const updatedSeries = await push(accountB, [{
  operationId: `update-series-${Date.now()}`,
  type: 'update-series',
  baseVersion: 1,
  payload: { seriesId, scope: 'future', fromDate: '2026-09-20', title: 'future series title' },
}], 'series-device');
assert.equal(updatedSeries.accepted[0].series.version, 2);
assert.ok(updatedSeries.accepted[0].tasks.every(task => task.occurrenceDate >= '2026-09-20'));
const templateUpdateRows = await database.task.findMany({
  where: { userId: accountB.user.id, seriesId },
  orderBy: { occurrenceDate: 'asc' },
});
assert.ok(templateUpdateRows.every(task => task.seriesVersion === 2));
assert.equal(templateUpdateRows.find(task => task.occurrenceDate < '2026-09-20').title, 'authoritative series');
assert.equal(templateUpdateRows.find(task => task.occurrenceDate >= '2026-09-20').title, 'future series title');
const completedSeriesOccurrence = templateUpdateRows.find(task => task.occurrenceDate === '2026-09-22');
assert.ok(completedSeriesOccurrence);
const completedSeriesResult = await push(accountB, [{
  operationId: `complete-series-occurrence-${Date.now()}`,
  type: 'update',
  taskId: completedSeriesOccurrence.id,
  baseVersion: completedSeriesOccurrence.version,
  payload: { status: 'done', progress: 100 },
}], 'series-device');
assert.equal(completedSeriesResult.accepted[0].task.status, 'done');
const staleSeriesUpdate = await push(accountB, [{
  operationId: `stale-series-${Date.now()}`,
  type: 'update-series',
  baseVersion: 1,
  payload: { seriesId, scope: 'future', fromDate: '2026-09-20', priority: 'P1' },
}], 'other-series-device');
assert.equal(staleSeriesUpdate.conflicts[0].code, 'SERIES_CONFLICT');
assert.equal(staleSeriesUpdate.conflicts[0].serverVersion, 2);
assert.ok(staleSeriesUpdate.conflicts[0].serverTasks.length > 0);
const rescheduledSeries = await push(accountB, [{
  operationId: `reschedule-series-${Date.now()}`,
  type: 'update-series',
  baseVersion: 2,
  payload: {
    seriesId,
    scope: 'future',
    fromDate: '2026-09-20',
    dueDate: '2026-09-20',
    repeatRule: 'weekly',
    repeatUntilDate: '2026-11-30',
  },
}], 'series-device');
assert.equal(rescheduledSeries.accepted[0].series.version, 3);
assert.ok(rescheduledSeries.accepted[0].tasks.every(task => task.seriesVersion === 3));
const rescheduledBootstrap = await request('/sync/bootstrap', { headers: { Authorization: `Bearer ${accountB.token}` } });
const activeRescheduledDates = rescheduledBootstrap.data.tasks
  .filter(task => task.seriesId === seriesId && task.status === 'todo' && task.occurrenceDate >= '2026-09-20')
  .map(task => task.occurrenceDate);
assert.deepEqual(activeRescheduledDates, [
  '2026-09-20', '2026-09-27', '2026-10-04', '2026-10-11', '2026-10-18',
  '2026-10-25', '2026-11-01', '2026-11-08', '2026-11-15', '2026-11-22', '2026-11-29',
]);
const preservedCompletedOccurrence = rescheduledBootstrap.data.tasks.find(task => task.id === completedSeriesOccurrence.id);
assert.equal(preservedCompletedOccurrence.status, 'done');
assert.equal(preservedCompletedOccurrence.occurrenceDate, '2026-09-22');
assert.equal(preservedCompletedOccurrence.title, 'future series title');
assert.equal(preservedCompletedOccurrence.seriesVersion, 3);

const excludedOccurrence = await database.task.findFirstOrThrow({
  where: { userId: accountB.user.id, seriesId, occurrenceDate: '2026-09-21' },
});
assert.ok(excludedOccurrence.deletedAt);
assert.ok(excludedOccurrence.scheduleExcludedAt);
const restoredSchedule = await push(accountB, [{
  operationId: `restore-series-schedule-${Date.now()}`,
  type: 'update-series',
  baseVersion: 3,
  payload: {
    seriesId,
    scope: 'future',
    fromDate: '2026-09-20',
    dueDate: '2026-09-20',
    repeatRule: 'daily',
    repeatUntilDate: '2026-09-25',
  },
}], 'series-device');
assert.equal(restoredSchedule.accepted[0].series.version, 4);
const restoredOccurrence = await database.task.findUniqueOrThrow({ where: { id: excludedOccurrence.id } });
assert.equal(restoredOccurrence.deletedAt, null);
assert.equal(restoredOccurrence.scheduleExcludedAt, null);
const restoredScheduleBootstrap = await request('/sync/bootstrap', { headers: { Authorization: `Bearer ${accountB.token}` } });
assert.deepEqual(restoredScheduleBootstrap.data.tasks
  .filter(task => task.seriesId === seriesId && task.status === 'todo' && task.occurrenceDate >= '2026-09-20')
  .map(task => task.occurrenceDate), ['2026-09-20', '2026-09-21', '2026-09-23', '2026-09-24', '2026-09-25']);
const deletedSeries = await push(accountB, [{
  operationId: `delete-series-${Date.now()}`,
  type: 'delete-series',
  baseVersion: 4,
  payload: { seriesId, scope: 'future', fromDate: '2026-09-23' },
}], 'series-device');
assert.equal(deletedSeries.accepted[0].series.version, 5);
assert.ok(deletedSeries.accepted[0].tasks.every(task => task.deletedAt));
const completedAfterFutureDelete = await database.task.findUniqueOrThrow({ where: { id: completedSeriesOccurrence.id } });
assert.equal(completedAfterFutureDelete.deletedAt, null);
assert.equal(completedAfterFutureDelete.status, 'done');

const concurrentRefreshes = await Promise.all(Array.from({ length: 2 }, () => request('/auth/refresh', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${accountB.refreshToken}`,
    'X-TaskFlow-Platform': 'native',
    Origin: 'capacitor://localhost',
  },
})));
assert.deepEqual(concurrentRefreshes.map(result => result.response.status).sort(), [200, 409]);
const rotatedSession = concurrentRefreshes.find(result => result.response.status === 200);
const rotatedAccessStillWorks = await request('/sync/bootstrap', { headers: { Authorization: `Bearer ${rotatedSession.data.accessToken}` } });
assert.equal(rotatedAccessStillWorks.response.status, 200);

const taskA = createA.accepted[0].task;
const [updateOne, updateTwo] = await Promise.all([
  push(accountA, [{ operationId: `update-1-${Date.now()}`, type: 'update', taskId: taskA.id, baseVersion: taskA.version, payload: { title: 'winner one' } }], 'device-one'),
  push(accountA, [{ operationId: `update-2-${Date.now()}`, type: 'update', taskId: taskA.id, baseVersion: taskA.version, payload: { title: 'winner two' } }], 'device-two'),
]);
assert.equal(updateOne.accepted.length + updateTwo.accepted.length, 1);
assert.equal(updateOne.conflicts.length + updateTwo.conflicts.length, 1);

// Disjoint stale edits are returned as a machine-readable conflict. The client
// can safely rebase it because the untouched field is present in serverTask.
const afterTitleRace = await request('/sync/bootstrap', { headers: { Authorization: `Bearer ${accountA.token}` } });
const disjointBase = afterTitleRace.data.tasks[0];
const priorityEdit = await push(accountA, [{
  operationId: `priority-${Date.now()}`,
  type: 'update',
  taskId: disjointBase.id,
  baseVersion: disjointBase.version,
  payload: { priority: 'P1' },
}], 'device-one');
assert.equal(priorityEdit.accepted.length, 1);
const staleTagEdit = await push(accountA, [{
  operationId: `tag-${Date.now()}`,
  type: 'update',
  taskId: disjointBase.id,
  baseVersion: disjointBase.version,
  payload: { tag: 'independent' },
}], 'device-two');
assert.equal(staleTagEdit.conflicts[0].code, 'TASK_CONFLICT');
assert.equal(staleTagEdit.conflicts[0].serverTask.priority, 'P1');

const beforeCompletion = await request('/sync/bootstrap', { headers: { Authorization: `Bearer ${accountA.token}` } });
const currentTask = beforeCompletion.data.tasks[0];
const completed = await push(accountA, [{ operationId: `complete-${Date.now()}`, type: 'update', taskId: currentTask.id, baseVersion: currentTask.version, payload: { status: 'done' } }]);
assert.equal(completed.accepted[0].order.taskOrderVersion, beforeCompletion.data.taskOrderVersion + 1);
assert.deepEqual(completed.accepted[0].order.order, []);

// A transaction committed before the socket drops must be recoverable by
// replaying the same operation ID.
const disconnectOperation = {
  operationId: `disconnect-${Date.now()}`,
  type: 'create',
  clientTaskId: 'disconnect-local',
  payload: taskPayload('response lost after commit'),
};
await assert.rejects(
  fetch(`${baseUrl}/sync/push`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accountA.token}`,
      'X-TaskFlow-Test-Drop-After-Commit': '1',
    },
    body: JSON.stringify({ deviceId: 'disconnect-device', operations: [disconnectOperation] }),
  }),
);
const disconnectedReplay = await push(accountA, [disconnectOperation], 'disconnect-device');
assert.equal(disconnectedReplay.accepted[0].replayed, true);

const concurrentOperations = Array.from({ length: 12 }, (_, index) => ({
  operationId: `concurrent-${Date.now()}-${index}`,
  type: 'create',
  clientTaskId: `concurrent-local-${index}`,
  payload: taskPayload(`concurrent ${index}`, index),
}));
const bootstrapSamples = [];
await Promise.all([
  ...concurrentOperations.map(operation => push(accountA, [operation]).then(result => result.accepted[0])),
  ...Array.from({ length: 12 }, async () => {
    const snapshot = await request('/sync/bootstrap', { headers: { Authorization: `Bearer ${accountA.token}` } });
    assert.equal(snapshot.response.status, 200);
    bootstrapSamples.push(snapshot.data);
  }),
]);

// Create/reorder and delete/reorder races may yield an explicit order conflict,
// but must never produce a 500 or a non-contiguous authoritative order.
const raceBase = await authenticated(accountA, '/sync/bootstrap?deviceId=race-device');
const raceOrder = raceBase.data.tasks
  .filter(task => task.status === 'todo' && !task.deletedAt)
  .map((task, index) => ({ id: task.id, sortOrder: index }));
const [raceCreate, raceReorder] = await Promise.all([
  push(accountA, [{ operationId: `race-create-${Date.now()}`, type: 'create', clientTaskId: 'race-create-local', payload: taskPayload('racing create') }], 'race-create-device'),
  push(accountA, [{ operationId: `race-reorder-${Date.now()}`, type: 'reorder', baseOrderVersion: raceBase.data.taskOrderVersion, payload: { order: raceOrder } }], 'race-reorder-device'),
]);
assert.equal(raceCreate.accepted.length, 1);
assert.equal(raceReorder.accepted.length + raceReorder.conflicts.length, 1);

const beforeDeleteRace = await authenticated(accountA, '/sync/bootstrap?deviceId=race-device');
const deleteTarget = beforeDeleteRace.data.tasks.find(task => task.status === 'todo');
const reversed = beforeDeleteRace.data.tasks
  .filter(task => task.status === 'todo' && !task.deletedAt)
  .toReversed()
  .map((task, index) => ({ id: task.id, sortOrder: index }));
const [raceDelete, raceDeleteReorder] = await Promise.all([
  push(accountA, [{ operationId: `race-delete-${Date.now()}`, type: 'soft-delete', taskId: deleteTarget.id, baseVersion: deleteTarget.version }], 'race-delete-device'),
  push(accountA, [{ operationId: `race-delete-reorder-${Date.now()}`, type: 'reorder', baseOrderVersion: beforeDeleteRace.data.taskOrderVersion, payload: { order: reversed } }], 'race-reorder-device'),
]);
assert.equal(raceDelete.accepted.length, 1);
assert.equal(raceDeleteReorder.accepted.length + raceDeleteReorder.conflicts.length, 1);

const finalOrderSnapshot = await authenticated(accountA, '/sync/bootstrap?deviceId=race-device');
const finalActive = finalOrderSnapshot.data.tasks.filter(task => task.status === 'todo' && !task.deletedAt);
assert.deepEqual(finalActive.map(task => task.sortOrder), finalActive.map((_, index) => index));

// Typed shadows are the read source and daily stats track completion without a
// full task scan.
const completedSnapshot = finalOrderSnapshot.data.tasks.find(task => task.status === 'done');
const storedCompleted = await database.task.findUniqueOrThrow({ where: { id: completedSnapshot.id } });
assert.equal(storedCompleted.dueDateTyped.toISOString().slice(0, 10), storedCompleted.dueDate);
assert.equal(storedCompleted.completedAtTyped.toISOString(), new Date(storedCompleted.completedAt).toISOString());
const dailyCount = await database.userDailyStats.aggregate({ where: { userId: accountA.user.id }, _sum: { count: true } });
assert.equal(dailyCount._sum.count, 1);

// A revoked session's already-issued access token must stop working immediately.
const secondLogin = await request('/auth/login', {
  method: 'POST',
  body: JSON.stringify({ email: accountA.email, password: accountA.password }),
});
assert.equal(secondLogin.response.status, 200);
const sessions = await authenticated(accountA, '/user/sessions');
const newestSession = sessions.data.sessions[0];
const revoked = await authenticated(accountA, `/user/sessions/${newestSession.id}`, { method: 'DELETE' });
assert.equal(revoked.response.status, 200);
const revokedAccess = await request('/sync/bootstrap', { headers: { Authorization: `Bearer ${secondLogin.data.accessToken}` } });
assert.equal(revokedAccess.response.status, 401);
const allChanges = await request('/sync?cursor=0&limit=1000', { headers: { Authorization: `Bearer ${accountA.token}` } });
assert.equal(allChanges.response.status, 200);
const createSeqByTask = new Map(allChanges.data.changes.filter(change => change.type === 'create').map(change => [change.taskId, change.seq]));
for (const snapshot of bootstrapSamples) {
  for (const task of snapshot.tasks) assert.ok((createSeqByTask.get(task.id) || 0) <= snapshot.currentCursor);
  for (const [taskId, seq] of createSeqByTask) {
    if (seq > snapshot.currentCursor) assert.equal(snapshot.tasks.some(task => task.id === taskId), false);
  }
}

// Cleanup is bounded by the minimum active-device acknowledgement. Changes
// beyond the watermark survive while older acknowledged rows may be compacted.
await database.device.updateMany({
  where: { userId: accountA.user.id },
  data: { requiresBootstrap: true },
});
const cleanupBootstrap = await authenticated(accountA, '/sync/bootstrap?deviceId=cleanup-device');
const midpoint = Math.max(1, Math.floor(cleanupBootstrap.data.currentCursor / 2));
await database.device.update({
  where: { id: `${accountA.user.id}:cleanup-device` },
  data: { lastAcknowledgedCursor: midpoint, requiresBootstrap: false, lastSeenAt: new Date() },
});
await database.taskChange.updateMany({
  where: { userId: accountA.user.id },
  data: { createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) },
});
await runMaintenance(new Date());
const retainedAfterWatermark = await database.taskChange.findFirst({
  where: { userId: accountA.user.id, seq: { gt: midpoint } },
});
assert.ok(retainedAfterWatermark);
const [, cleanupPull] = await Promise.all([
  runMaintenance(new Date()),
  authenticated(accountA, `/sync?cursor=${midpoint}&limit=1000&deviceId=cleanup-device`),
]);
assert.equal(cleanupPull.response.status, 200);
assert.ok(cleanupPull.data.changes.some(change => change.seq > midpoint));

// Production-scale smoke budget: Bootstrap 10,000 real PostgreSQL rows through
// the HTTP/serialization path, not an in-memory fixture.
const performanceAccount = await createAccount('sync-performance');
await database.task.createMany({
  data: Array.from({ length: 10_000 }, (_, index) => ({
    id: `performance-task-${index}`,
    userId: performanceAccount.user.id,
    title: `Performance task ${index}`,
    priority: index % 3 === 0 ? 'P1' : index % 3 === 1 ? 'P2' : 'P3',
    status: 'todo',
    progress: 0,
    dueDate: '2026-09-14',
    sortOrder: index,
  })),
});
const bootstrapStartedAt = performance.now();
const performanceBootstrap = await authenticated(performanceAccount, '/sync/bootstrap?deviceId=performance-device');
const bootstrapElapsedMs = performance.now() - bootstrapStartedAt;
assert.equal(performanceBootstrap.response.status, 200);
assert.equal(performanceBootstrap.data.tasks.length, 10_000);
assert.deepEqual(performanceBootstrap.data.tasks.map(task => task.sortOrder), Array.from({ length: 10_000 }, (_, index) => index));
assert.ok(bootstrapElapsedMs < 5_000, `10,000-task bootstrap took ${bootstrapElapsedMs.toFixed(1)}ms`);

await database.$disconnect();

console.log(JSON.stringify({ status: 'ok', accounts: 3, changes: allChanges.data.changes.length, snapshots: bootstrapSamples.length, replays: 100, bootstrap10kMs: Math.round(bootstrapElapsedMs) }));
