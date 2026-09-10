import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { addCalendarDays, dateInTimeZone, isValidTimeZone } = require('../backend/dist/date-utils.js');

test('server calendar dates respect the configured user timezone', () => {
  const instant = '2025-01-01T16:30:00.000Z';
  assert.equal(dateInTimeZone(instant, 'Asia/Shanghai'), '2025-01-02');
  assert.equal(dateInTimeZone(instant, 'America/Los_Angeles'), '2025-01-01');
});

test('timezone validation rejects unknown zones and calendar arithmetic is DST-safe', () => {
  assert.equal(isValidTimeZone('Asia/Shanghai'), true);
  assert.equal(isValidTimeZone('Not/A_Timezone'), false);
  assert.equal(addCalendarDays('2025-03-09', 1), '2025-03-10');
  assert.equal(addCalendarDays('2024-03-01', -1), '2024-02-29');
});
