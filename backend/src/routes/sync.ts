import { Router, Response, NextFunction, RequestHandler } from 'express';
import { Prisma } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { recomputeUserStats } from '../services/stats';
import { prisma } from '../prisma-client';

const router = Router();
const PRIORITIES = new Set(['P1', 'P2', 'P3']);
const STATUSES = new Set(['todo', 'done', 'skipped']);
const REPEAT_RULES = new Set(['none', 'daily', 'weekly', 'monthly']);
const OP_TYPES = new Set(['create', 'update', 'soft-delete', 'restore', 'permanent-delete', 'reorder', 'resolve-conflict']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATS_MUTATION_TYPES = new Set(['create', 'update', 'soft-delete', 'restore', 'permanent-delete', 'resolve-conflict']);

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
  reminderAt: string | null;
  repeatRule: string | null;
  repeatUntilDate: string | null;
  seriesId: string | null;
  occurrenceDate: string | null;
  completedAt: string | null;
  deletedAt: string | null;
  sortOrder: number;
  version: number;
  lastChangedByDeviceId: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    ...task,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
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

async function bootstrap(userId: string) {
  return prisma.$transaction(async (tx) => {
    const state = await tx.userSyncState.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });
    const [tasks, deletedTasks, stats] = await Promise.all([
      tx.task.findMany({ where: { userId, deletedAt: null }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] }),
      tx.task.findMany({ where: { userId, deletedAt: { not: null } }, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }] }),
      tx.userStats.findUnique({ where: { userId } }),
    ]);
    return {
      tasks: tasks.map(taskSnapshot),
      deletedTasks: deletedTasks.map(taskSnapshot),
      userStats: stats,
      currentCursor: state.nextSeq - 1,
      taskOrderVersion: state.taskOrderVersion,
      serverTime: new Date().toISOString(),
    };
  });
}

router.get('/bootstrap', asyncHandler(async (req, res) => {
  res.json(await bootstrap(req.userId!));
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
  const [syncState, earliest] = await Promise.all([
    prisma.userSyncState.upsert({ where: { userId: req.userId! }, create: { userId: req.userId! }, update: {} }),
    prisma.taskChange.findFirst({ where: { userId: req.userId! }, orderBy: { seq: 'asc' }, select: { seq: true } }),
  ]);
  const earliestRecoverableCursor = earliest ? earliest.seq - 1 : syncState.nextSeq - 1;
  if (cursor > 0 && cursor < earliestRecoverableCursor) {
    res.status(409).json({ code: 'CURSOR_EXPIRED', error: 'Sync history expired; bootstrap is required' });
    return;
  }
  const changes = await prisma.taskChange.findMany({
    where: { userId: req.userId!, seq: { gt: cursor } },
    orderBy: { seq: 'asc' },
    take: limit + 1,
  });
  const visible = changes.slice(0, limit);
  const nextCursor = visible.length > 0 ? visible[visible.length - 1].seq : cursor;
  res.json({
    changes: visible,
    nextCursor,
    hasMore: changes.length > limit,
    serverTime: new Date().toISOString(),
  });
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
              reminderAt: data.reminderAt as string | null | undefined,
              repeatRule: data.repeatRule as string | null | undefined,
              repeatUntilDate: data.repeatUntilDate as string | null | undefined,
              seriesId: data.seriesId as string | null | undefined,
              occurrenceDate: data.occurrenceDate as string | null | undefined,
              completedAt: data.status === 'done' ? new Date().toISOString() : null,
              sortOrder: data.sortOrder as number,
              lastChangedByDeviceId: deviceId,
            },
          });
          const snapshot = taskSnapshot(created);
          const change = await recordChange(tx, req.userId!, { taskId: created.id, operationId, deviceId, type: 'create', snapshot });
          const response = { operationId, change, task: snapshot, clientTaskId: operation.clientTaskId };
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
            data: { ...data, version: { increment: 1 }, lastChangedByDeviceId: deviceId },
          });
          if (changed.count !== 1) return taskCasFailure(tx, req.userId!, taskId, operationId, operation);
          const saved = await tx.task.findUniqueOrThrow({ where: { id: taskId } });
          const snapshot = taskSnapshot(saved);
          const change = await recordChange(tx, req.userId!, { taskId, operationId, deviceId, type: 'update', snapshot });
          const response = { operationId, change, task: snapshot };
          return { accepted: await recordOperation(tx, req.userId!, operationId, taskId, type, response) };
        }

        if (type === 'soft-delete' || type === 'restore') {
          const deletedAt = type === 'soft-delete' ? existing.deletedAt || new Date().toISOString() : null;
          const changed = await tx.task.updateMany({
            where: { id: taskId, userId: req.userId!, version: baseVersion },
            data: { deletedAt, version: { increment: 1 }, lastChangedByDeviceId: deviceId },
          });
          if (changed.count !== 1) return taskCasFailure(tx, req.userId!, taskId, operationId, operation);
          const saved = await tx.task.findUniqueOrThrow({ where: { id: taskId } });
          const snapshot = taskSnapshot(saved);
          const tombstone = type === 'soft-delete' ? { taskId, deletedAt, version: saved.version } : undefined;
          const change = await recordChange(tx, req.userId!, { taskId, operationId, deviceId, type, snapshot, tombstone });
          const response = { operationId, change, task: snapshot };
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
  res.json({ accepted, conflicts, rejected, nextCursorHint: state.nextSeq - 1, userStats });
}));

export default router;
