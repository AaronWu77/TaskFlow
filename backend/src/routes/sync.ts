import { Router, Response, NextFunction, RequestHandler } from 'express';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { applyTaskStatsDelta, recomputeUserStats } from '../services/stats';
import { prisma } from '../prisma-client';
import { recordSyncMetric } from '../services/metrics';
import { addCalendarDays, isValidTimeZone, occurrenceDates, RepeatRule } from '../date-utils';

const router = Router();
const PRIORITIES = new Set(['P1', 'P2', 'P3']);
const STATUSES = new Set(['todo', 'done', 'skipped']);
const REPEAT_RULES = new Set(['none', 'daily', 'weekly', 'monthly']);
const OP_TYPES = new Set(['create', 'update', 'soft-delete', 'restore', 'permanent-delete', 'reorder', 'resolve-conflict', 'create-series', 'update-series', 'delete-series']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATS_MUTATION_TYPES = new Set(['create', 'update', 'soft-delete', 'restore', 'permanent-delete', 'resolve-conflict', 'update-series', 'delete-series']);
const SYNC_PROTOCOL_VERSION = 2;

router.use(authMiddleware);

type SyncOperation = {
  operationId?: unknown;
  type?: unknown;
  taskId?: unknown;
  clientTaskId?: unknown;
  baseVersion?: unknown;
  baseOrderVersion?: unknown;
  payload?: unknown;
};

function asyncHandler(fn: (req: AuthRequest, res: Response, next: NextFunction) => Promise<void>): RequestHandler {
  return (req, res, next) => fn(req as AuthRequest, res, next).catch(next);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value: unknown, max = 120): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}

function normalizeNullableString(value: unknown, max = 120): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed || null : undefined;
}

function isValidIsoDateTime(value: string): boolean {
  const time = Date.parse(value);
  return !Number.isNaN(time) && value.length <= 64;
}

function isValidDateOnly(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function parseInteger(value: unknown, min: number, max: number): number | undefined {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max ? value as number : undefined;
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function taskSnapshot(task: {
  id: string;
  userId: string;
  title: string;
  priority: string;
  estimateMinutes: number | null;
  status: string;
  tag: string | null;
  progress: number;
  dueDate: string | null;
  dueDateTyped: Date | null;
  reminderAt: string | null;
  reminderAtTyped: Date | null;
  repeatRule: string | null;
  repeatUntilDate: string | null;
  repeatUntilDateTyped: Date | null;
  seriesId: string | null;
  seriesVersion: number | null;
  occurrenceDate: string | null;
  occurrenceDateTyped: Date | null;
  completedAt: string | null;
  completedAtTyped: Date | null;
  deletedAt: string | null;
  deletedAtTyped: Date | null;
  scheduleExcludedAt: Date | null;
  sortOrder: number;
  version: number;
  lastChangedByDeviceId: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  const {
    dueDateTyped,
    reminderAtTyped,
    repeatUntilDateTyped,
    occurrenceDateTyped,
    completedAtTyped,
    deletedAtTyped,
    scheduleExcludedAt: _scheduleExcludedAt,
    ...legacyTask
  } = task;
  return {
    ...legacyTask,
    dueDate: dueDateTyped?.toISOString().slice(0, 10) ?? task.dueDate,
    reminderAt: reminderAtTyped?.toISOString() ?? task.reminderAt,
    repeatUntilDate: repeatUntilDateTyped?.toISOString().slice(0, 10) ?? task.repeatUntilDate,
    occurrenceDate: occurrenceDateTyped?.toISOString().slice(0, 10) ?? task.occurrenceDate,
    completedAt: completedAtTyped?.toISOString() ?? task.completedAt,
    deletedAt: deletedAtTyped?.toISOString() ?? task.deletedAt,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}

function dateOnlyValue(value: string | number | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? new Date(`${value}T00:00:00.000Z`) : null;
}

function dateTimeValue(value: string | number | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? new Date(value) : null;
}

function typedTaskFields(data: Record<string, string | number | null>): Prisma.TaskUpdateManyMutationInput {
  return {
    ...data,
    dueDateTyped: dateOnlyValue(data.dueDate),
    reminderAtTyped: dateTimeValue(data.reminderAt),
    repeatUntilDateTyped: dateOnlyValue(data.repeatUntilDate),
    occurrenceDateTyped: dateOnlyValue(data.occurrenceDate),
    completedAtTyped: dateTimeValue(data.completedAt),
    deletedAtTyped: dateTimeValue(data.deletedAt),
  };
}

function seriesSnapshot(series: {
  id: string;
  userId: string;
  title: string;
  priority: string;
  estimateMinutes: number | null;
  tag: string | null;
  repeatRule: string;
  startDate: Date;
  untilDate: Date;
  timezone: string;
  reminderAt: Date | null;
  generatedThrough: Date | null;
  version: number;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    ...series,
    startDate: series.startDate.toISOString().slice(0, 10),
    untilDate: series.untilDate.toISOString().slice(0, 10),
    reminderAt: series.reminderAt?.toISOString() ?? null,
    generatedThrough: series.generatedThrough?.toISOString().slice(0, 10) ?? null,
    deletedAt: series.deletedAt?.toISOString() ?? null,
    createdAt: series.createdAt.toISOString(),
    updatedAt: series.updatedAt.toISOString(),
  };
}

function generationHorizon(startDate: string): string {
  const rolling = addCalendarDays(new Date().toISOString().slice(0, 10), 90);
  return startDate > rolling ? startDate : rolling;
}

async function createSeriesTask(
  tx: Prisma.TransactionClient,
  userId: string,
  series: {
    id: string;
    title: string;
    priority: string;
    estimateMinutes: number | null;
    tag: string | null;
    repeatRule: string;
    untilDate: Date;
    reminderAt: Date | null;
    version: number;
  },
  dueDate: string,
  sortOrder: number,
  deviceId: string | null,
  includeReminder: boolean,
) {
  const untilDate = series.untilDate.toISOString().slice(0, 10);
  return tx.task.create({
    data: {
      userId,
      title: series.title,
      priority: series.priority,
      estimateMinutes: series.estimateMinutes,
      progress: 0,
      status: 'todo',
      tag: series.tag,
      dueDate,
      dueDateTyped: dateOnlyValue(dueDate),
      reminderAt: includeReminder ? series.reminderAt?.toISOString() ?? null : null,
      reminderAtTyped: includeReminder ? series.reminderAt : null,
      repeatRule: series.repeatRule,
      repeatUntilDate: untilDate,
      repeatUntilDateTyped: dateOnlyValue(untilDate),
      seriesId: series.id,
      seriesVersion: series.version,
      occurrenceDate: dueDate,
      occurrenceDateTyped: dateOnlyValue(dueDate),
      completedAt: null,
      completedAtTyped: null,
      deletedAt: null,
      deletedAtTyped: null,
      sortOrder,
      lastChangedByDeviceId: deviceId,
    },
  });
}

async function materializeSeries(userId: string): Promise<void> {
  await prisma.$transaction(async tx => {
    await lockTaskOrderState(tx, userId);
    const seriesRows = await tx.taskSeries.findMany({
      where: { userId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    if (seriesRows.length === 0) return;
    let nextOrder = await tx.task.count({ where: { userId, status: 'todo', deletedAt: null } });
    let createdAny = false;
    for (const series of seriesRows) {
      const startDate = series.startDate.toISOString().slice(0, 10);
      const untilDate = series.untilDate.toISOString().slice(0, 10);
      const generatedThrough = series.generatedThrough?.toISOString().slice(0, 10) ?? null;
      const dates = occurrenceDates(startDate, untilDate, series.repeatRule as RepeatRule, generationHorizon(startDate), generatedThrough);
      for (const dueDate of dates) {
        const task = await createSeriesTask(tx, userId, series, dueDate, nextOrder, null, !generatedThrough && dueDate === startDate);
        nextOrder += 1;
        createdAny = true;
        await recordChange(tx, userId, { taskId: task.id, type: 'create', snapshot: taskSnapshot(task) });
      }
      if (dates.length > 0) {
        await tx.taskSeries.update({
          where: { id: series.id },
          data: { generatedThrough: dateOnlyValue(dates[dates.length - 1]) },
        });
      }
    }
    if (createdAny) await normalizeAndRecordTodoOrder(tx, userId, null);
  });
}

async function upsertDevice(tx: Prisma.TransactionClient, userId: string, deviceId: string | null, body: Record<string, unknown>): Promise<void> {
  if (!deviceId) return;
  const scopedDeviceId = `${userId}:${deviceId}`;
  await tx.device.upsert({
    where: { id: scopedDeviceId },
    create: {
      id: scopedDeviceId,
      userId,
      name: normalizeNullableString(body.deviceName, 80) ?? null,
      platform: normalizeNullableString(body.platform, 40) ?? null,
      lastSeenAt: new Date(),
    },
    update: {
      name: normalizeNullableString(body.deviceName, 80) ?? undefined,
      platform: normalizeNullableString(body.platform, 40) ?? undefined,
      lastSeenAt: new Date(),
    },
  });
}

async function nextSeq(tx: Prisma.TransactionClient, userId: string): Promise<number> {
  const state = await tx.userSyncState.upsert({
    where: { userId },
    create: { userId, nextSeq: 2, taskOrderVersion: 1 },
    update: { nextSeq: { increment: 1 } },
  });
  return state.nextSeq - 1;
}

async function lockTaskOrderState(tx: Prisma.TransactionClient, userId: string): Promise<number> {
  await tx.userSyncState.upsert({
    where: { userId },
    create: { userId },
    update: {},
  });
  const rows = await tx.$queryRaw<Array<{ taskOrderVersion: number }>>(Prisma.sql`
    SELECT "taskOrderVersion"
    FROM "UserSyncState"
    WHERE "userId" = ${userId}
    FOR UPDATE
  `);
  return rows[0]?.taskOrderVersion ?? 1;
}

async function taskCasFailure(
  tx: Prisma.TransactionClient,
  userId: string,
  taskId: string,
  operationId: string,
  operation: SyncOperation,
) {
  const latest = await tx.task.findFirst({ where: { id: taskId, userId } });
  if (latest) {
    return {
      conflict: {
        operationId,
        code: 'TASK_CONFLICT',
        serverTask: taskSnapshot(latest),
        serverVersion: latest.version,
        clientOperation: operation,
      },
    };
  }
  const permanentDelete = await tx.taskChange.findFirst({
    where: { userId, taskId, type: 'permanent-delete' },
    orderBy: { createdAt: 'desc' },
  });
  if (permanentDelete) {
    return {
      conflict: {
        operationId,
        code: 'TASK_NOT_FOUND',
        clientOperation: operation,
        tombstone: permanentDelete.tombstone,
      },
    };
  }
  return { rejected: { operationId, code: 'TASK_NOT_FOUND', error: 'Task not found' } };
}

async function recordChange(tx: Prisma.TransactionClient, userId: string, data: {
  taskId?: string | null;
  operationId?: string | null;
  deviceId?: string | null;
  type: string;
  snapshot?: unknown;
  tombstone?: unknown;
}) {
  const seq = await nextSeq(tx, userId);
  return tx.taskChange.create({
    data: {
      userId,
      seq,
      taskId: data.taskId ?? null,
      operationId: data.operationId ?? null,
      deviceId: data.deviceId ?? null,
      type: data.type,
      snapshot: data.snapshot === undefined ? undefined : jsonValue(data.snapshot),
      tombstone: data.tombstone === undefined ? undefined : jsonValue(data.tombstone),
    },
  });
}

async function recordOperation(
  tx: Prisma.TransactionClient,
  userId: string,
  operationId: string,
  taskId: string | null,
  type: string,
  response: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  await tx.taskOperation.create({
    data: { userId, operationId, taskId, type, response: jsonValue(response) },
  });
  return response;
}

async function normalizeAndRecordTodoOrder(
  tx: Prisma.TransactionClient,
  userId: string,
  deviceId: string | null,
): Promise<{ order: Array<{ id: string; sortOrder: number }>; taskOrderVersion: number }> {
  const tasks = await tx.task.findMany({
    where: { userId, status: 'todo', deletedAt: null },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, sortOrder: true },
  });
  const order = tasks.map((task, sortOrder) => ({ id: task.id, sortOrder }));
  const changed = order.filter((item, index) => tasks[index].sortOrder !== item.sortOrder);
  if (changed.length > 0) {
    const rows = Prisma.join(changed.map(item => Prisma.sql`(${item.id}, ${item.sortOrder})`));
    await tx.$executeRaw(Prisma.sql`
      UPDATE "Task" AS task
      SET "sortOrder" = ordering."sortOrder",
          "updatedAt" = NOW()
      FROM (VALUES ${rows}) AS ordering("id", "sortOrder")
      WHERE task."id" = ordering."id" AND task."userId" = ${userId}
    `);
  }
  const state = await tx.userSyncState.update({
    where: { userId },
    data: { taskOrderVersion: { increment: 1 } },
  });
  const snapshot = { order, taskOrderVersion: state.taskOrderVersion };
  await recordChange(tx, userId, { deviceId, type: 'reorder', snapshot });
  return snapshot;
}

function parseTaskPayload(payload: unknown, partial: boolean): Record<string, string | number | null> | null {
  if (!isObject(payload)) return null;
  const data: Record<string, string | number | null> = {};

  if (!partial || payload.title !== undefined) {
    const title = normalizeString(payload.title, 200);
    if (!title) return null;
    data.title = title;
  }
  if (!partial || payload.priority !== undefined) {
    if (typeof payload.priority !== 'string' || !PRIORITIES.has(payload.priority)) return null;
    data.priority = payload.priority;
  }
  if (payload.estimateMinutes !== undefined) {
    if (payload.estimateMinutes === null || payload.estimateMinutes === '') data.estimateMinutes = null;
    else {
      const estimateMinutes = parseInteger(payload.estimateMinutes, 1, 1440);
      if (estimateMinutes === undefined) return null;
      data.estimateMinutes = estimateMinutes;
    }
  } else if (!partial) {
    data.estimateMinutes = null;
  }
  if (payload.progress !== undefined) {
    const progress = parseInteger(payload.progress, 0, 100);
    if (progress === undefined) return null;
    data.progress = progress;
  } else if (!partial) {
    data.progress = 0;
  }
  if (payload.status !== undefined) {
    if (typeof payload.status !== 'string' || !STATUSES.has(payload.status)) return null;
    data.status = payload.status;
  } else if (!partial) {
    data.status = 'todo';
  }
  if (partial && payload.sortOrder !== undefined) return null;
  if (!partial && payload.sortOrder !== undefined) {
    const sortOrder = parseInteger(payload.sortOrder, 0, 1_000_000);
    if (sortOrder === undefined) return null;
    data.sortOrder = sortOrder;
  } else if (!partial) {
    data.sortOrder = 0;
  }
  const tag = normalizeNullableString(payload.tag, 80);
  if (payload.tag !== undefined) {
    if (tag === undefined) return null;
    data.tag = tag;
  }
  const dueDate = normalizeNullableString(payload.dueDate, 10);
  if (payload.dueDate !== undefined) {
    if (!dueDate || !isValidDateOnly(dueDate)) return null;
    data.dueDate = dueDate;
  } else if (!partial) {
    return null;
  }
  const reminderAt = normalizeNullableString(payload.reminderAt, 64);
  if (payload.reminderAt !== undefined) {
    if (reminderAt !== null && reminderAt !== undefined && !isValidIsoDateTime(reminderAt)) return null;
    data.reminderAt = reminderAt ?? null;
  }
  const repeatRule = normalizeNullableString(payload.repeatRule, 16);
  if (payload.repeatRule !== undefined) {
    if (repeatRule !== null && repeatRule !== undefined && !REPEAT_RULES.has(repeatRule)) return null;
    data.repeatRule = repeatRule ?? null;
  } else if (!partial) {
    data.repeatRule = null;
  }
  const repeatUntilDate = normalizeNullableString(payload.repeatUntilDate, 10);
  if (payload.repeatUntilDate !== undefined) {
    if (repeatUntilDate !== null && repeatUntilDate !== undefined && !isValidDateOnly(repeatUntilDate)) return null;
    data.repeatUntilDate = repeatUntilDate ?? null;
  } else if (!partial) {
    data.repeatUntilDate = null;
  }
  if (partial && (payload.seriesId !== undefined || payload.occurrenceDate !== undefined)) return null;
  const seriesId = normalizeNullableString(payload.seriesId, 120);
  if (payload.seriesId !== undefined) {
    if (seriesId === undefined) return null;
    data.seriesId = seriesId ?? null;
  } else if (!partial) {
    data.seriesId = null;
  }
  const occurrenceDate = normalizeNullableString(payload.occurrenceDate, 10);
  if (payload.occurrenceDate !== undefined) {
    if (occurrenceDate !== null && occurrenceDate !== undefined && !isValidDateOnly(occurrenceDate)) return null;
    data.occurrenceDate = occurrenceDate ?? null;
  } else if (!partial) {
    data.occurrenceDate = null;
  }
  if (!partial && Boolean(data.seriesId) !== Boolean(data.occurrenceDate)) return null;
  if (payload.deletedAt !== undefined) {
    if (partial || payload.deletedAt !== null) return null;
    data.deletedAt = null;
  }
  return data;
}

async function bootstrap(userId: string, deviceId: string | null) {
  await prisma.userSyncState.upsert({ where: { userId }, create: { userId }, update: {} });
  await materializeSeries(userId);
  return prisma.$transaction(async (tx) => {
    const [tasks, deletedTasks, stats] = await Promise.all([
      tx.task.findMany({ where: { userId, deletedAt: null }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] }),
      tx.task.findMany({ where: { userId, deletedAt: { not: null } }, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }] }),
      tx.userStats.findUnique({ where: { userId } }),
    ]);
    const state = await tx.userSyncState.findUniqueOrThrow({ where: { userId } });
    if (deviceId) {
      await tx.device.upsert({
        where: { id: `${userId}:${deviceId}` },
        create: {
          id: `${userId}:${deviceId}`,
          userId,
          lastAcknowledgedCursor: state.nextSeq - 1,
          requiresBootstrap: false,
        },
        update: {
          lastSeenAt: new Date(),
          lastAcknowledgedCursor: state.nextSeq - 1,
          requiresBootstrap: false,
        },
      });
    }
    return {
      tasks: tasks.map(taskSnapshot),
      deletedTasks: deletedTasks.map(taskSnapshot),
      userStats: stats,
      currentCursor: state.nextSeq - 1,
      taskOrderVersion: state.taskOrderVersion,
      serverTime: new Date().toISOString(),
      protocolVersion: SYNC_PROTOCOL_VERSION,
      snapshotId: randomUUID(),
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

router.get('/bootstrap', asyncHandler(async (req, res) => {
  const deviceId = normalizeNullableString(req.query.deviceId, 120) ?? null;
  res.json(await bootstrap(req.userId!, deviceId));
}));

router.get('/', asyncHandler(async (req, res) => {
  const cursor = Number.parseInt(String(req.query.cursor ?? '0'), 10);
  const requestedLimit = Number.parseInt(String(req.query.limit ?? '500'), 10);
  const limit = Math.min(requestedLimit || 500, 1000);
  if (!Number.isInteger(cursor) || cursor < 0) {
    res.status(400).json({ code: 'VALIDATION_ERROR', error: 'cursor must be a non-negative integer' });
    return;
  }
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
    res.status(400).json({ code: 'VALIDATION_ERROR', error: 'limit must be a positive integer' });
    return;
  }
  await prisma.userSyncState.upsert({ where: { userId: req.userId! }, create: { userId: req.userId! }, update: {} });
  const deviceId = normalizeNullableString(req.query.deviceId, 120) ?? null;
  const page = await prisma.$transaction(async (tx) => {
    const [syncState, earliest, device] = await Promise.all([
      tx.userSyncState.findUniqueOrThrow({ where: { userId: req.userId! } }),
      tx.taskChange.findFirst({ where: { userId: req.userId! }, orderBy: { seq: 'asc' }, select: { seq: true } }),
      deviceId
        ? tx.device.findUnique({ where: { id: `${req.userId!}:${deviceId}` } })
        : Promise.resolve(null),
    ]);
    const earliestRecoverableCursor = earliest ? earliest.seq - 1 : syncState.nextSeq - 1;
    if (cursor > 0 && (device?.requiresBootstrap || cursor < earliestRecoverableCursor)) return { expired: true as const };
    const changes = await tx.taskChange.findMany({
      where: { userId: req.userId!, seq: { gt: cursor } },
      orderBy: { seq: 'asc' },
      take: limit + 1,
    });
    const visible = changes.slice(0, limit);
    const nextCursor = visible.length > 0 ? visible[visible.length - 1].seq : cursor;
    if (deviceId) {
      await tx.device.upsert({
        where: { id: `${req.userId!}:${deviceId}` },
        create: { id: `${req.userId!}:${deviceId}`, userId: req.userId!, lastAcknowledgedCursor: nextCursor },
        update: {
          lastSeenAt: new Date(),
          lastAcknowledgedCursor: { set: Math.max(device?.lastAcknowledgedCursor ?? 0, nextCursor) },
        },
      });
    }
    return {
      expired: false as const,
      changes: visible,
      nextCursor,
      hasMore: changes.length > limit,
      serverTime: new Date().toISOString(),
      protocolVersion: SYNC_PROTOCOL_VERSION,
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  if (page.expired) {
    res.status(409).json({ code: 'CURSOR_EXPIRED', error: 'Sync history expired; bootstrap is required' });
    return;
  }
  res.json(page);
}));

router.post('/push', asyncHandler(async (req, res) => {
  if (!isObject(req.body) || !Array.isArray(req.body.operations)) {
    res.status(400).json({ code: 'VALIDATION_ERROR', error: 'operations must be an array' });
    return;
  }
  if (req.body.operations.length > 100) {
    res.status(400).json({ code: 'VALIDATION_ERROR', error: 'A sync batch can contain at most 100 operations' });
    return;
  }
  const deviceId = normalizeString(req.body.deviceId, 120);
  const accepted: unknown[] = [];
  const conflicts: unknown[] = [];
  const rejected: unknown[] = [];
  let statsMayHaveChanged = false;

  if (deviceId) {
    await prisma.$transaction(tx => upsertDevice(tx, req.userId!, deviceId, req.body as Record<string, unknown>));
  }

  for (const rawOperation of req.body.operations as unknown[]) {
    if (!isObject(rawOperation)) {
      rejected.push({ code: 'VALIDATION_ERROR', error: 'Invalid operation' });
      continue;
    }
    const operation = rawOperation as SyncOperation;
    const operationId = normalizeString(operation.operationId, 120);
    const type = typeof operation.type === 'string' && OP_TYPES.has(operation.type) ? operation.type : null;
    if (!operationId || !type) {
      rejected.push({ operationId: operation.operationId, code: 'VALIDATION_ERROR', error: 'Invalid operation' });
      continue;
    }

    const recorded = await prisma.taskOperation.findUnique({
      where: { userId_operationId: { userId: req.userId!, operationId } },
    });
    if (recorded) {
      accepted.push({
        ...(isObject(recorded.response) ? recorded.response : { operationId }),
        ...(operation.clientTaskId ? { clientTaskId: operation.clientTaskId } : {}),
        replayed: true,
      });
      if (STATS_MUTATION_TYPES.has(type)) statsMayHaveChanged = true;
      continue;
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        if (type === 'create-series') {
          const payload = isObject(operation.payload) ? operation.payload : null;
          const data = parseTaskPayload(operation.payload, false);
          const seriesId = data ? normalizeString(data.seriesId, 120) : null;
          const startDate = data && typeof data.dueDate === 'string' ? data.dueDate : null;
          const untilDate = data && typeof data.repeatUntilDate === 'string' ? data.repeatUntilDate : null;
          const repeatRule = data && typeof data.repeatRule === 'string' && data.repeatRule !== 'none'
            ? data.repeatRule as RepeatRule
            : null;
          const timezone = payload && typeof payload.timezone === 'string' && isValidTimeZone(payload.timezone)
            ? payload.timezone
            : 'UTC';
          if (!data || !seriesId || !startDate || !untilDate || !repeatRule
            || data.occurrenceDate !== startDate || untilDate < startDate) {
            return { rejected: { operationId, code: 'VALIDATION_ERROR', error: 'Invalid task series payload' } };
          }
          await lockTaskOrderState(tx, req.userId!);
          const series = await tx.taskSeries.create({
            data: {
              id: seriesId,
              userId: req.userId!,
              title: data.title as string,
              priority: data.priority as string,
              estimateMinutes: data.estimateMinutes as number | null,
              tag: data.tag as string | null | undefined,
              repeatRule,
              startDate: dateOnlyValue(startDate)!,
              untilDate: dateOnlyValue(untilDate)!,
              timezone,
              reminderAt: dateTimeValue(data.reminderAt) ?? null,
            },
          });
          const activeCount = await tx.task.count({ where: { userId: req.userId!, status: 'todo', deletedAt: null } });
          const dates = occurrenceDates(startDate, untilDate, repeatRule, generationHorizon(startDate));
          const createdTasks = [];
          let firstChange: unknown;
          for (const [index, dueDate] of dates.entries()) {
            const task = await createSeriesTask(tx, req.userId!, series, dueDate, activeCount + index, deviceId, index === 0);
            createdTasks.push(task);
            const change = await recordChange(tx, req.userId!, {
              taskId: task.id,
              operationId: index === 0 ? operationId : null,
              deviceId,
              type: 'create',
              snapshot: taskSnapshot(task),
            });
            if (index === 0) firstChange = change;
          }
          const savedSeries = await tx.taskSeries.update({
            where: { id: series.id },
            data: { generatedThrough: dateOnlyValue(dates[dates.length - 1]) },
          });
          const order = await normalizeAndRecordTodoOrder(tx, req.userId!, deviceId);
          const taskSnapshots = createdTasks.map(taskSnapshot);
          const response = {
            operationId,
            change: firstChange,
            task: taskSnapshots[0],
            tasks: taskSnapshots,
            clientTaskId: operation.clientTaskId,
            series: seriesSnapshot(savedSeries),
            order,
          };
          return { accepted: await recordOperation(tx, req.userId!, operationId, null, type, response) };
        }

        if (type === 'update-series' || type === 'delete-series') {
          const payload = isObject(operation.payload) ? operation.payload : {};
          const seriesId = normalizeString(payload.seriesId ?? operation.taskId, 120);
          const baseVersion = Number.isInteger(operation.baseVersion) ? operation.baseVersion as number : null;
          const scope = payload.scope === 'all' || payload.scope === 'future' ? payload.scope : null;
          const fromDate = scope === 'all' ? null : normalizeString(payload.fromDate, 10);
          if (!seriesId || baseVersion === null || !scope || (scope === 'future' && (!fromDate || !isValidDateOnly(fromDate)))) {
            return { rejected: { operationId, code: 'VALIDATION_ERROR', error: 'Invalid task series operation' } };
          }
          await lockTaskOrderState(tx, req.userId!);
          const existingSeries = await tx.taskSeries.findFirst({ where: { id: seriesId, userId: req.userId! } });
          if (!existingSeries || existingSeries.deletedAt) {
            return { rejected: { operationId, code: 'SERIES_NOT_FOUND', error: 'Task series not found' } };
          }
          if (existingSeries.version !== baseVersion) {
            const serverTasks = await tx.task.findMany({
              where: { userId: req.userId!, seriesId },
              orderBy: [{ occurrenceDate: 'asc' }, { id: 'asc' }],
            });
            return {
              conflict: {
                operationId,
                code: 'SERIES_CONFLICT',
                serverSeries: seriesSnapshot(existingSeries),
                serverTasks: serverTasks.map(taskSnapshot),
                serverVersion: existingSeries.version,
                clientOperation: operation,
              },
            };
          }
          const occurrenceFilter = fromDate ? { gte: fromDate } : undefined;
          const affected = await tx.task.findMany({
            where: { userId: req.userId!, seriesId, occurrenceDate: occurrenceFilter },
            orderBy: [{ occurrenceDate: 'asc' }, { id: 'asc' }],
          });
          if (scope === 'future' && affected.length === 0) {
            return { rejected: { operationId, code: 'SERIES_OCCURRENCE_NOT_FOUND', error: 'Series occurrence not found' } };
          }
          const changedTasks = [];
          let seriesMembershipChanged = false;
          if (type === 'update-series') {
            const title = payload.title === undefined ? undefined : normalizeString(payload.title, 200);
            const priority = payload.priority === undefined ? undefined
              : typeof payload.priority === 'string' && PRIORITIES.has(payload.priority) ? payload.priority : null;
            const estimateMinutes = payload.estimateMinutes === undefined ? undefined
              : payload.estimateMinutes === null ? null : parseInteger(payload.estimateMinutes, 1, 1440);
            const tag = normalizeNullableString(payload.tag, 80);
            const repeatRule = payload.repeatRule === undefined
              ? existingSeries.repeatRule as RepeatRule
              : typeof payload.repeatRule === 'string' && payload.repeatRule !== 'none' && REPEAT_RULES.has(payload.repeatRule)
                ? payload.repeatRule as RepeatRule
                : null;
            const submittedStartDate = payload.dueDate === undefined ? undefined : normalizeString(payload.dueDate, 10);
            const submittedUntilDate = payload.repeatUntilDate === undefined ? undefined : normalizeString(payload.repeatUntilDate, 10);
            const existingStartDate = existingSeries.startDate.toISOString().slice(0, 10);
            const existingUntilDate = existingSeries.untilDate.toISOString().slice(0, 10);
            const nextStartDate = submittedStartDate ?? (scope === 'future' ? fromDate! : existingStartDate);
            const nextUntilDate = submittedUntilDate ?? existingUntilDate;
            const previousOccurrence = scope === 'future'
              ? await tx.task.findFirst({
                where: { userId: req.userId!, seriesId, occurrenceDate: { lt: fromDate! } },
                orderBy: { occurrenceDate: 'desc' },
                select: { occurrenceDate: true },
              })
              : null;
            const scheduleChanged = payload.repeatRule !== undefined
              || payload.dueDate !== undefined
              || payload.repeatUntilDate !== undefined;
            if (title === null || priority === null || (payload.estimateMinutes !== undefined && estimateMinutes === undefined)
              || (payload.tag !== undefined && tag === undefined) || repeatRule === null
              || !isValidDateOnly(nextStartDate) || !isValidDateOnly(nextUntilDate)
              || nextUntilDate < nextStartDate
              || (scope === 'future' && previousOccurrence?.occurrenceDate
                && nextStartDate <= previousOccurrence.occurrenceDate)) {
              return { rejected: { operationId, code: 'VALIDATION_ERROR', error: 'Invalid series update payload' } };
            }
            const nextSeriesVersion = baseVersion + 1;
            const updatedSeries = await tx.taskSeries.updateMany({
              where: { id: seriesId, userId: req.userId!, version: baseVersion },
              data: {
                title,
                priority: priority ?? undefined,
                estimateMinutes,
                tag: payload.tag === undefined ? undefined : tag,
                repeatRule,
                startDate: scheduleChanged ? dateOnlyValue(nextStartDate)! : undefined,
                untilDate: scheduleChanged ? dateOnlyValue(nextUntilDate)! : undefined,
                generatedThrough: scheduleChanged ? null : undefined,
                version: { increment: 1 },
              },
            });
            if (updatedSeries.count !== 1) {
              const latest = await tx.taskSeries.findUniqueOrThrow({ where: { id: seriesId } });
              const serverTasks = await tx.task.findMany({
                where: { userId: req.userId!, seriesId },
                orderBy: [{ occurrenceDate: 'asc' }, { id: 'asc' }],
              });
              return { conflict: { operationId, code: 'SERIES_CONFLICT', serverSeries: seriesSnapshot(latest), serverTasks: serverTasks.map(taskSnapshot), serverVersion: latest.version, clientOperation: operation } };
            }
            const savedSeries = await tx.taskSeries.findUniqueOrThrow({ where: { id: seriesId } });
            const targetDates = scheduleChanged
              ? occurrenceDates(nextStartDate, nextUntilDate, repeatRule, generationHorizon(nextStartDate))
              : [];
            const targetDateSet = new Set(targetDates);
            let operationChangeRecorded = false;
            for (const task of affected) {
              const occurrenceDate = task.occurrenceDate ?? task.dueDate;
              // Completed/skipped work is immutable history. A manually deleted
              // occurrence is also left alone; only a prior schedule exclusion
              // may be brought back when the new schedule includes its identity.
              if (task.status !== 'todo' || (task.deletedAt && !task.scheduleExcludedAt)) continue;
              const restoreToSchedule = scheduleChanged
                && !!task.deletedAt
                && !!task.scheduleExcludedAt
                && !!occurrenceDate
                && targetDateSet.has(occurrenceDate);
              if (task.deletedAt && !restoreToSchedule) continue;
              const removeFromSchedule = scheduleChanged
                && task.status === 'todo'
                && !task.deletedAt
                && (!occurrenceDate || !targetDateSet.has(occurrenceDate));
              const deletedAt = removeFromSchedule ? new Date() : restoreToSchedule ? null : undefined;
              if (removeFromSchedule || restoreToSchedule) seriesMembershipChanged = true;
              const saved = await tx.task.update({
                where: { id: task.id },
                data: {
                  title,
                  priority: priority ?? undefined,
                  estimateMinutes,
                  tag: payload.tag === undefined ? undefined : tag,
                  repeatRule,
                  repeatUntilDate: nextUntilDate,
                  repeatUntilDateTyped: dateOnlyValue(nextUntilDate),
                  seriesVersion: nextSeriesVersion,
                  deletedAt: deletedAt instanceof Date ? deletedAt.toISOString() : deletedAt,
                  deletedAtTyped: deletedAt,
                  scheduleExcludedAt: removeFromSchedule ? deletedAt : restoreToSchedule ? null : undefined,
                  version: { increment: 1 },
                  lastChangedByDeviceId: deviceId,
                },
              });
              if (removeFromSchedule || restoreToSchedule) await applyTaskStatsDelta(tx, req.userId!, task, saved);
              changedTasks.push(saved);
              await recordChange(tx, req.userId!, {
                taskId: saved.id,
                operationId: operationChangeRecorded ? null : operationId,
                deviceId,
                type: removeFromSchedule ? 'soft-delete' : restoreToSchedule ? 'restore' : 'update',
                snapshot: taskSnapshot(saved),
                tombstone: removeFromSchedule ? { taskId: saved.id, deletedAt: saved.deletedAt, version: saved.version } : undefined,
              });
              operationChangeRecorded = true;
            }
            if (scheduleChanged) {
              const allSeriesTasks = await tx.task.findMany({
                where: { userId: req.userId!, seriesId },
                select: { occurrenceDate: true },
              });
              const existingDates = new Set(allSeriesTasks.map(task => task.occurrenceDate).filter((date): date is string => !!date));
              let nextOrder = await tx.task.count({ where: { userId: req.userId!, status: 'todo', deletedAt: null } });
              for (const dueDate of targetDates) {
                if (existingDates.has(dueDate)) continue;
                const created = await createSeriesTask(tx, req.userId!, savedSeries, dueDate, nextOrder, deviceId, false);
                seriesMembershipChanged = true;
                nextOrder += 1;
                changedTasks.push(created);
                await recordChange(tx, req.userId!, {
                  taskId: created.id,
                  operationId: operationChangeRecorded ? null : operationId,
                  deviceId,
                  type: 'create',
                  snapshot: taskSnapshot(created),
                });
                operationChangeRecorded = true;
              }
              await tx.taskSeries.update({
                where: { id: seriesId },
                data: { generatedThrough: dateOnlyValue(targetDates[targetDates.length - 1] ?? nextStartDate) },
              });
            }
            // A series version is global, even when only future occurrences are
            // materially changed. Keep every occurrence on the authoritative
            // version so a later edit opened from historical data cannot submit
            // an apparently-current but actually stale baseVersion.
            await tx.task.updateMany({
              where: { userId: req.userId!, seriesId },
              data: { seriesVersion: nextSeriesVersion },
            });
          } else {
            const deletedAt = new Date();
            for (const [index, task] of affected.entries()) {
              if (task.deletedAt) continue;
              if (scope === 'future' && task.status !== 'todo') continue;
              seriesMembershipChanged = task.status === 'todo' || seriesMembershipChanged;
              const saved = await tx.task.update({
                where: { id: task.id },
                data: {
                  deletedAt: deletedAt.toISOString(),
                  deletedAtTyped: deletedAt,
                  scheduleExcludedAt: null,
                  seriesVersion: baseVersion + 1,
                  version: { increment: 1 },
                  lastChangedByDeviceId: deviceId,
                },
              });
              await applyTaskStatsDelta(tx, req.userId!, task, saved);
              changedTasks.push(saved);
              await recordChange(tx, req.userId!, {
                taskId: saved.id,
                operationId: index === 0 ? operationId : null,
                deviceId,
                type: 'soft-delete',
                snapshot: taskSnapshot(saved),
                tombstone: { taskId: saved.id, deletedAt: saved.deletedAt, version: saved.version },
              });
            }
            const deletesWholeSeries = scope === 'all'
              || (fromDate !== null && fromDate <= existingSeries.startDate.toISOString().slice(0, 10));
            await tx.taskSeries.update({
              where: { id: seriesId },
              data: deletesWholeSeries
                ? { deletedAt, version: { increment: 1 } }
                : { untilDate: dateOnlyValue(addCalendarDays(fromDate!, -1))!, version: { increment: 1 } },
            });
            await tx.task.updateMany({
              where: { userId: req.userId!, seriesId },
              data: { seriesVersion: baseVersion + 1 },
            });
          }
          const savedSeries = await tx.taskSeries.findUniqueOrThrow({ where: { id: seriesId } });
          const order = seriesMembershipChanged
            ? await normalizeAndRecordTodoOrder(tx, req.userId!, deviceId)
            : undefined;
          const response = { operationId, series: seriesSnapshot(savedSeries), tasks: changedTasks.map(taskSnapshot), order };
          return { accepted: await recordOperation(tx, req.userId!, operationId, null, type, response) };
        }

        if (type === 'create') {
          const data = parseTaskPayload(operation.payload, false);
          if (!data) return { rejected: { operationId, code: 'VALIDATION_ERROR', error: 'Invalid task payload' } };
          await lockTaskOrderState(tx, req.userId!);
          const created = await tx.task.create({
            data: {
              userId: req.userId!,
              title: data.title as string,
              priority: data.priority as string,
              estimateMinutes: data.estimateMinutes as number | null,
              progress: data.progress as number,
              status: data.status as string,
              tag: data.tag as string | null | undefined,
              dueDate: data.dueDate as string | null | undefined,
              dueDateTyped: dateOnlyValue(data.dueDate),
              reminderAt: data.reminderAt as string | null | undefined,
              reminderAtTyped: dateTimeValue(data.reminderAt),
              repeatRule: data.repeatRule as string | null | undefined,
              repeatUntilDate: data.repeatUntilDate as string | null | undefined,
              repeatUntilDateTyped: dateOnlyValue(data.repeatUntilDate),
              seriesId: data.seriesId as string | null | undefined,
              occurrenceDate: data.occurrenceDate as string | null | undefined,
              occurrenceDateTyped: dateOnlyValue(data.occurrenceDate),
              completedAt: data.status === 'done' ? new Date().toISOString() : null,
              completedAtTyped: data.status === 'done' ? new Date() : null,
              sortOrder: data.sortOrder as number,
              lastChangedByDeviceId: deviceId,
            },
          });
          await applyTaskStatsDelta(tx, req.userId!, null, created);
          const snapshot = taskSnapshot(created);
          const change = await recordChange(tx, req.userId!, { taskId: created.id, operationId, deviceId, type: 'create', snapshot });
          const order = created.status === 'todo' && !created.deletedAt
            ? await normalizeAndRecordTodoOrder(tx, req.userId!, deviceId)
            : undefined;
          const response = { operationId, change, task: snapshot, clientTaskId: operation.clientTaskId, order };
          return { accepted: await recordOperation(tx, req.userId!, operationId, created.id, type, response) };
        }

        if (type === 'reorder') {
          const payload = isObject(operation.payload) ? operation.payload : {};
          const order = Array.isArray(payload.order) ? payload.order : null;
          const baseOrderVersion = Number.isInteger(operation.baseOrderVersion) ? operation.baseOrderVersion as number : null;
          if (!order || baseOrderVersion === null) {
            return { rejected: { operationId, code: 'VALIDATION_ERROR', error: 'order and baseOrderVersion are required' } };
          }
          const currentOrderVersion = await lockTaskOrderState(tx, req.userId!);
          const activeTodoTasks = await tx.task.findMany({
            where: { userId: req.userId!, status: 'todo', deletedAt: null },
            orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
            select: { id: true, sortOrder: true },
          });
          const serverOrder = activeTodoTasks.map((task, index) => ({ id: task.id, sortOrder: index }));
          if (currentOrderVersion !== baseOrderVersion) {
            return { conflict: { operationId, code: 'ORDER_CONFLICT', clientOperation: operation, serverOrderVersion: currentOrderVersion, serverOrder } };
          }
          const normalizedOrder: Array<{ id: string; sortOrder: number }> = [];
          const seenTaskIds = new Set<string>();
          for (const [index, item] of order.entries()) {
            if (!isObject(item) || typeof item.id !== 'string' || !Number.isInteger(item.sortOrder)
              || (item.sortOrder as number) < 0 || (item.sortOrder as number) > 1_000_000
              || item.sortOrder !== index
              || seenTaskIds.has(item.id)) {
              return { rejected: { operationId, code: 'VALIDATION_ERROR', error: 'Invalid order payload' } };
            }
            seenTaskIds.add(item.id);
            normalizedOrder.push({ id: item.id, sortOrder: item.sortOrder as number });
          }
          const activeTodoIds = new Set(activeTodoTasks.map(task => task.id));
          if (activeTodoIds.size !== normalizedOrder.length || normalizedOrder.some(item => !activeTodoIds.has(item.id))) {
            return { conflict: { operationId, code: 'ORDER_CONFLICT', clientOperation: operation, serverOrderVersion: currentOrderVersion, serverOrder } };
          }
          if (normalizedOrder.length > 0) {
            const rows = Prisma.join(normalizedOrder.map(item => Prisma.sql`(${item.id}, ${item.sortOrder})`));
            await tx.$executeRaw(Prisma.sql`
              UPDATE "Task" AS task
              SET "sortOrder" = ordering."sortOrder",
                  "lastChangedByDeviceId" = ${deviceId},
                  "updatedAt" = NOW()
              FROM (VALUES ${rows}) AS ordering("id", "sortOrder")
              WHERE task."id" = ordering."id"
                AND task."userId" = ${req.userId!}
                AND task."status" = 'todo'
                AND task."deletedAt" IS NULL
            `);
          }
          const updatedState = await tx.userSyncState.update({
            where: { userId: req.userId! },
            data: { taskOrderVersion: { increment: 1 } },
          });
          const snapshot = { order: normalizedOrder, taskOrderVersion: updatedState.taskOrderVersion };
          const change = await recordChange(tx, req.userId!, { operationId, deviceId, type: 'reorder', snapshot });
          const response = { operationId, change, order: snapshot };
          return { accepted: await recordOperation(tx, req.userId!, operationId, null, type, response) };
        }

        // All mutations acquire the per-user state lock before touching task rows.
        // This keeps task CAS writes, order writes, and change-sequence allocation
        // in one lock order and prevents reorder/update deadlocks.
        await lockTaskOrderState(tx, req.userId!);
        const taskId = normalizeString(operation.taskId, 120);
        if (!taskId) return { rejected: { operationId, code: 'VALIDATION_ERROR', error: 'taskId is required' } };
        const existing = await tx.task.findFirst({ where: { id: taskId, userId: req.userId! } });
        if (!existing) {
          const permanentDelete = await tx.taskChange.findFirst({
            where: { userId: req.userId!, taskId, type: 'permanent-delete' },
            orderBy: { createdAt: 'desc' },
          });
          if (permanentDelete) {
            return { conflict: { operationId, code: 'TASK_NOT_FOUND', clientOperation: operation, tombstone: permanentDelete.tombstone } };
          }
          return { rejected: { operationId, code: 'TASK_NOT_FOUND', error: 'Task not found' } };
        }
        const baseVersion = Number.isInteger(operation.baseVersion) ? operation.baseVersion as number : null;
        if (baseVersion === null) {
          return { rejected: { operationId, code: 'VALIDATION_ERROR', error: 'baseVersion is required' } };
        }
        if (existing.version !== baseVersion) {
          return { conflict: { operationId, code: 'TASK_CONFLICT', serverTask: taskSnapshot(existing), serverVersion: existing.version, clientOperation: operation } };
        }

        if (type === 'update' || type === 'resolve-conflict') {
          const data = parseTaskPayload(operation.payload, true);
          if (!data) return { rejected: { operationId, code: 'VALIDATION_ERROR', error: 'Invalid task payload' } };
          if (data.status === 'done' && existing.status !== 'done' && !existing.completedAt) data.completedAt = new Date().toISOString();
          else if (data.status !== undefined && data.status !== 'done' && existing.completedAt) data.completedAt = null;
          const changed = await tx.task.updateMany({
            where: { id: taskId, userId: req.userId!, version: baseVersion },
            data: { ...typedTaskFields(data), version: { increment: 1 }, lastChangedByDeviceId: deviceId },
          });
          if (changed.count !== 1) return taskCasFailure(tx, req.userId!, taskId, operationId, operation);
          const saved = await tx.task.findUniqueOrThrow({ where: { id: taskId } });
          await applyTaskStatsDelta(tx, req.userId!, existing, saved);
          const snapshot = taskSnapshot(saved);
          const change = await recordChange(tx, req.userId!, { taskId, operationId, deviceId, type: 'update', snapshot });
          const membershipChanged = (existing.status === 'todo' && !existing.deletedAt) !== (saved.status === 'todo' && !saved.deletedAt);
          const order = membershipChanged ? await normalizeAndRecordTodoOrder(tx, req.userId!, deviceId) : undefined;
          const response = { operationId, change, task: snapshot, order };
          return { accepted: await recordOperation(tx, req.userId!, operationId, taskId, type, response) };
        }

        if (type === 'soft-delete' || type === 'restore') {
          const deletedAt = type === 'soft-delete' ? existing.deletedAt || new Date().toISOString() : null;
          const changed = await tx.task.updateMany({
            where: { id: taskId, userId: req.userId!, version: baseVersion },
            data: { deletedAt, deletedAtTyped: dateTimeValue(deletedAt), version: { increment: 1 }, lastChangedByDeviceId: deviceId },
          });
          if (changed.count !== 1) return taskCasFailure(tx, req.userId!, taskId, operationId, operation);
          const saved = await tx.task.findUniqueOrThrow({ where: { id: taskId } });
          await applyTaskStatsDelta(tx, req.userId!, existing, saved);
          const snapshot = taskSnapshot(saved);
          const tombstone = type === 'soft-delete' ? { taskId, deletedAt, version: saved.version } : undefined;
          const change = await recordChange(tx, req.userId!, { taskId, operationId, deviceId, type, snapshot, tombstone });
          const membershipChanged = existing.status === 'todo'
            && ((type === 'soft-delete' && !existing.deletedAt) || (type === 'restore' && !!existing.deletedAt));
          const order = membershipChanged ? await normalizeAndRecordTodoOrder(tx, req.userId!, deviceId) : undefined;
          const response = { operationId, change, task: snapshot, order };
          return { accepted: await recordOperation(tx, req.userId!, operationId, taskId, type, response) };
        }

        if (type === 'permanent-delete') {
          if (!existing.deletedAt) {
            return { rejected: { operationId, code: 'TASK_NOT_DELETED', error: 'Task must be soft-deleted before permanent deletion' } };
          }
          const deleted = await tx.task.deleteMany({
            where: { id: taskId, userId: req.userId!, version: baseVersion, deletedAt: { not: null } },
          });
          if (deleted.count !== 1) return taskCasFailure(tx, req.userId!, taskId, operationId, operation);
          await applyTaskStatsDelta(tx, req.userId!, existing, null);
          const tombstone = { taskId, deletedAt: existing.deletedAt, permanentlyDeletedAt: new Date().toISOString(), version: existing.version + 1 };
          const change = await recordChange(tx, req.userId!, { taskId, operationId, deviceId, type, tombstone });
          const response = { operationId, change, tombstone };
          return { accepted: await recordOperation(tx, req.userId!, operationId, taskId, type, response) };
        }

        return { rejected: { operationId, code: 'VALIDATION_ERROR', error: 'Unsupported operation type' } };
      });

      if ('accepted' in result) {
        accepted.push(result.accepted);
        if (STATS_MUTATION_TYPES.has(type)) statsMayHaveChanged = true;
      }
      else if ('conflict' in result) conflicts.push(result.conflict);
      else rejected.push(result.rejected);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const recorded = await prisma.taskOperation.findUnique({
          where: { userId_operationId: { userId: req.userId!, operationId } },
        });
        if (recorded) accepted.push({
          ...(isObject(recorded.response) ? recorded.response : { operationId }),
          ...(operation.clientTaskId ? { clientTaskId: operation.clientTaskId } : {}),
          replayed: true,
        });
        else rejected.push({ operationId, code: 'DUPLICATE_OPERATION', error: 'Operation already exists' });
        continue;
      }
      throw error;
    }
  }

  const userStats = statsMayHaveChanged ? await recomputeUserStats(prisma, req.userId!) : undefined;
  const state = await prisma.userSyncState.upsert({ where: { userId: req.userId! }, create: { userId: req.userId! }, update: {} });
  recordSyncMetric(accepted.length, conflicts.length, rejected.length);
  if (process.env.NODE_ENV !== 'production' && req.get('X-TaskFlow-Test-Drop-After-Commit') === '1') {
    req.socket.destroy();
    return;
  }
  res.json({ accepted, conflicts, rejected, nextCursorHint: state.nextSeq - 1, userStats });
}));

export default router;
