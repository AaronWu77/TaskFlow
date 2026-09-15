import { expect, test, type Page, type Route } from '@playwright/test';

const user = {
  id: 'e2e-user',
  email: 'e2e@example.com',
  emailVerifiedAt: '2026-09-14T00:00:00.000Z',
  emailVerified: true,
  timezone: 'Asia/Shanghai',
  locale: 'zh',
};

function taskFromPayload(id: string, payload: Record<string, unknown>) {
  const now = new Date().toISOString();
  return {
    id,
    userId: user.id,
    title: payload.title,
    priority: payload.priority,
    estimateMinutes: payload.estimateMinutes ?? null,
    progress: payload.progress ?? 0,
    status: payload.status ?? 'todo',
    tag: payload.tag ?? null,
    dueDate: payload.dueDate,
    reminderAt: payload.reminderAt ?? null,
    repeatRule: payload.repeatRule ?? 'none',
    repeatUntilDate: payload.repeatUntilDate ?? null,
    seriesId: payload.seriesId ?? null,
    occurrenceDate: payload.occurrenceDate ?? null,
    completedAt: null,
    deletedAt: null,
    sortOrder: payload.sortOrder ?? 0,
    version: 1,
    lastChangedByDeviceId: 'e2e-device',
    createdAt: now,
    updatedAt: now,
  };
}

async function mockApi(page: Page) {
  const tasks: ReturnType<typeof taskFromPayload>[] = [];
  let orderVersion = 1;
  let cursor = 0;
  await page.route('https://taskflow.top/api/v1/**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/v1', '');
    const json = (body: unknown, status = 200) => route.fulfill({
      status,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': 'http://127.0.0.1:4173', 'Access-Control-Allow-Credentials': 'true' },
      body: JSON.stringify(body),
    });
    if (request.method() === 'OPTIONS') return json({});
    if (path === '/auth/refresh') return json({ accessToken: 'e2e-access', user });
    if (path === '/user/preferences') return json(user);
    if (path === '/user/stats') return json({ streak: 0, streakDate: null, completedToday: '2026-09-14', todayCount: 0 });
    if (path === '/sync/bootstrap') {
      return json({
        tasks,
        deletedTasks: [],
        userStats: { streak: 0, streakDate: null, completedToday: '2026-09-14', todayCount: 0 },
        currentCursor: cursor,
        taskOrderVersion: orderVersion,
        serverTime: new Date().toISOString(),
        protocolVersion: 2,
        snapshotId: crypto.randomUUID(),
      });
    }
    if (path === '/sync/push') {
      const body = request.postDataJSON() as { operations: Array<{ operationId: string; clientTaskId?: string; payload?: Record<string, unknown> }> };
      const accepted = body.operations.map(operation => {
        const task = taskFromPayload(`server-${tasks.length + 1}`, operation.payload ?? {});
        tasks.push(task);
        cursor += 1;
        orderVersion += 1;
        return {
          operationId: operation.operationId,
          clientTaskId: operation.clientTaskId,
          task,
          order: { order: tasks.map((item, index) => ({ id: item.id, sortOrder: index })), taskOrderVersion: orderVersion },
        };
      });
      return json({ accepted, conflicts: [], rejected: [], nextCursorHint: cursor });
    }
    if (path === '/sync') {
      return json({ changes: [], nextCursor: cursor, hasMore: false, serverTime: new Date().toISOString(), protocolVersion: 2 });
    }
    return json({ code: 'NOT_FOUND' }, 404);
  });
}

test('title entered before priority remains submittable and survives reload', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: '添加任务', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('#quick-task-title').fill('先写标题再改优先级');
  await dialog.getByRole('button', { name: '高优先级', exact: true }).click();
  await dialog.getByRole('button', { name: '添加任务', exact: true }).click();
  const taskCard = page.getByRole('group', { name: '先写标题再改优先级' });
  await expect(taskCard).toHaveCount(1);
  await expect(taskCard.first()).toBeVisible();
  await page.reload();
  const restoredTaskCard = page.getByRole('group', { name: '先写标题再改优先级' });
  await expect(restoredTaskCard).toHaveCount(1);
  await expect(restoredTaskCard).toBeVisible();
  await expect(page.getByText('离线待同步')).toHaveCount(0);
});
