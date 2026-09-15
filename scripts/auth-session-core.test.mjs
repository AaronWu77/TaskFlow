import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAuthSessionManager } from '../src/app/auth-session-core.mjs';

test('switching accounts invalidates and aborts every request from the old generation', () => {
  const sessions = createAuthSessionManager();
  const accountA = sessions.activate('user-a', 'token-a');
  const first = new AbortController();
  const second = new AbortController();
  sessions.track(accountA, first);
  sessions.track(accountA, second);

  const accountB = sessions.activate('user-b', 'token-b');
  assert.equal(first.signal.aborted, true);
  assert.equal(second.signal.aborted, true);
  assert.equal(sessions.isCurrent(accountA), false);
  assert.equal(sessions.isCurrent(accountB), true);
});

test('a refresh may update only the session generation that started it', () => {
  const sessions = createAuthSessionManager();
  const firstA = sessions.activate('user-a', 'old-a');
  sessions.activate('user-b', 'token-b');
  const secondA = sessions.activate('user-a', 'new-a');

  assert.equal(sessions.updateToken(firstA, 'stale-refresh-token'), false);
  assert.equal(sessions.current().accessToken, 'new-a');
  assert.equal(sessions.updateToken(secondA, 'fresh-refresh-token'), true);
  assert.equal(sessions.current().accessToken, 'fresh-refresh-token');
});

test('logout invalidates a tracked request even when the user id would later be reused', () => {
  const sessions = createAuthSessionManager();
  const beforeLogout = sessions.activate('user-a', 'token-a');
  const request = new AbortController();
  sessions.track(beforeLogout, request);
  sessions.clear();
  const afterLogin = sessions.activate('user-a', 'token-a2');

  assert.equal(request.signal.aborted, true);
  assert.equal(sessions.isCurrent(beforeLogout), false);
  assert.equal(sessions.isCurrent(afterLogin), true);
  assert.notEqual(beforeLogout.generation, afterLogin.generation);
});
