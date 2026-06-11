import { Router, Response, NextFunction, RequestHandler } from 'express';
import { Prisma, PrismaClient } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { recomputeUserStats } from '../services/stats';

const router = Router();
const prisma = new PrismaClient();
const PRIORITIES = new Set(['P1', 'P2', 'P3']);
const STATUSES = new Set(['todo', 'doing', 'done', 'snoozed', 'skipped']);
const REPEAT_RULES = new Set(['none', 'daily', 'weekly', 'monthly']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

router.use(authMiddleware);

/** Wraps an async route handler so unhandled rejections propagate to Express error middleware */
function asyncHandler(fn: (req: AuthRequest, res: Response, next: NextFunction) => Promise<void>): RequestHandler {
  return (req, res, next) => fn(req as AuthRequest, res, next).catch(next);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
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

function validationError(res: Response, field: string, message: string): void {
  res.status(400).json({ code: 'VALIDATION_ERROR', field, error: message });
}

function normalizeOperationId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 120 ? trimmed : null;
}

function normalizeLastKnownUpdatedAt(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return isValidIsoDateTime(value) ? value : null;
}

async function findRecordedOperation(userId: string, operationId: string) {
  return prisma.taskOperation.findFirst({
    where: { userId, operationId },
  });
}

function toJsonResponse(response: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(response)) as Prisma.InputJsonValue;
}

function isUniqueOperationError(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const target = error.meta?.target;
  return target === 'TaskOperation_operationId_key'
    || (Array.isArray(target) && target.includes('operationId'));
}

async function claimOperation(tx: Prisma.TransactionClient, userId: string, operationId: string | null, type: string): Promise<void> {
  if (!operationId) return;
  await tx.taskOperation.create({
    data: {
      userId,
      operationId,
      type,
    },
  });
}

async function completeOperation(tx: Prisma.TransactionClient, operationId: string | null, taskId: string | null, response: unknown): Promise<void> {
  if (!operationId) return;
  await tx.taskOperation.update({
    where: { operationId },
    data: {
      taskId,
      response: toJsonResponse(response),
    },
  });
}

async function sendRecordedOperation(res: Response, userId: string, operationId: string, status = 200): Promise<boolean> {
  const recorded = await findRecordedOperation(userId, operationId);
  if (recorded?.response) {
    res.status(status).json(recorded.response);
    return true;
  }
  res.status(409).json({
    code: 'OPERATION_IN_PROGRESS',
    error: 'Operation is already being processed',
  });
  return true;
}

function conflictResponse(res: Response, serverTask: unknown): void {
  res.status(409).json({
    code: 'TASK_CONFLICT',
    error: 'Task was changed on another device',
    serverTask,
  });
}

function parseInteger(value: unknown, field: string, res: Response, min: number, max: number): number | undefined {
  if (!Number.isInteger(value)) {
    validationError(res, field, `${field} must be an integer`);
    return undefined;
  }
  const next = value as number;
  if (next < min || next > max) {
    validationError(res, field, `${field} must be between ${min} and ${max}`);
    return undefined;
  }
  return next;
}

function normalizeNullableString(value: unknown, field: string, res: Response, max = 120): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string') {
    validationError(res, field, `${field} must be a string`);
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    validationError(res, field, `${field} is too long`);
    return undefined;
  }
  return trimmed || null;
}

function parseTaskPayload(input: unknown, res: Response, partial: boolean) {
  if (!isObject(input)) {
    validationError(res, 'body', 'Request body must be an object');
    return null;
  }

  const data: Record<string, string | number | null> = {};

  if (!partial || input.title !== undefined) {
    if (typeof input.title !== 'string' || input.title.trim().length === 0) {
      validationError(res, 'title', 'title is required');
      return null;
    }
    const title = input.title.trim();
    if (title.length > 200) {
      validationError(res, 'title', 'title is too long');
      return null;
    }
    data.title = title;
  }

  if (!partial || input.priority !== undefined) {
    if (typeof input.priority !== 'string' || !PRIORITIES.has(input.priority)) {
      validationError(res, 'priority', 'priority must be P1, P2, or P3');
      return null;
    }
    data.priority = input.priority;
  }

  if (!partial || input.estimateMinutes !== undefined) {
    const estimateMinutes = parseInteger(input.estimateMinutes, 'estimateMinutes', res, 1, 1440);
    if (estimateMinutes === undefined) return null;
    data.estimateMinutes = estimateMinutes;
  }

  if (input.status !== undefined) {
    if (typeof input.status !== 'string' || !STATUSES.has(input.status)) {
      validationError(res, 'status', 'status must be a valid task status');
      return null;
    }
    data.status = input.status;
  } else if (!partial) {
    data.status = 'todo';
  }

  if (input.progress !== undefined) {
    const progress = parseInteger(input.progress, 'progress', res, 0, 100);
    if (progress === undefined) return null;
    data.progress = progress;
  } else if (!partial) {
    data.progress = 0;
  }

  if (input.sortOrder !== undefined) {
    const sortOrder = parseInteger(input.sortOrder, 'sortOrder', res, 0, 1_000_000);
    if (sortOrder === undefined) return null;
    data.sortOrder = sortOrder;
  } else if (!partial) {
    data.sortOrder = 0;
  }

  const tag = normalizeNullableString(input.tag, 'tag', res, 80);
  if (input.tag !== undefined) {
    if (tag === undefined) return null;
    data.tag = tag;
  }

  const dueDate = normalizeNullableString(input.dueDate, 'dueDate', res, 10);
  if (input.dueDate !== undefined) {
    if (dueDate !== null && dueDate !== undefined && !isValidDateOnly(dueDate)) {
      validationError(res, 'dueDate', 'dueDate must be YYYY-MM-DD');
      return null;
    }
    data.dueDate = dueDate ?? null;
  }

  const reminderAt = normalizeNullableString(input.reminderAt, 'reminderAt', res, 64);
  if (input.reminderAt !== undefined) {
    if (reminderAt !== null && reminderAt !== undefined && !isValidIsoDateTime(reminderAt)) {
      validationError(res, 'reminderAt', 'reminderAt must be an ISO datetime');
      return null;
    }
    data.reminderAt = reminderAt ?? null;
  }

  const repeatRule = normalizeNullableString(input.repeatRule, 'repeatRule', res, 16);
  if (input.repeatRule !== undefined) {
    if (repeatRule !== null && repeatRule !== undefined && !REPEAT_RULES.has(repeatRule)) {
      validationError(res, 'repeatRule', 'repeatRule must be none, daily, weekly, or monthly');
      return null;
    }
    data.repeatRule = repeatRule ?? null;
  } else if (!partial) {
    data.repeatRule = null;
  }

  const deletedAt = normalizeNullableString(input.deletedAt, 'deletedAt', res, 64);
  if (input.deletedAt !== undefined) {
    if (deletedAt !== null && deletedAt !== undefined && !isValidIsoDateTime(deletedAt)) {
      validationError(res, 'deletedAt', 'deletedAt must be an ISO datetime');
      return null;
    }
    data.deletedAt = deletedAt ?? null;
  } else if (!partial) {
    data.deletedAt = null;
  }

  return data;
}

// GET /tasks — list all tasks for the current user, ordered by sortOrder
router.get('/', asyncHandler(async (req, res) => {
  const tasks = await prisma.task.findMany({
    where: { userId: req.userId!, deletedAt: null },
    orderBy: { sortOrder: 'asc' },
  });
  res.json(tasks);
}));

// GET /tasks/deleted — list soft-deleted tasks for the current user
router.get('/deleted', asyncHandler(async (req, res) => {
  const tasks = await prisma.task.findMany({
    where: { userId: req.userId!, deletedAt: { not: null } },
    orderBy: { deletedAt: 'desc' },
  });
  res.json(tasks);
}));

// POST /tasks — create a new task
router.post('/', asyncHandler(async (req, res) => {
  const operationId = isObject(req.body) ? normalizeOperationId(req.body.operationId) : null;
  const data = parseTaskPayload(req.body, res, false);
  if (!data) return;
  let task;
  try {
    task = await prisma.$transaction(async (tx) => {
      await claimOperation(tx, req.userId!, operationId, 'create');
      const created = await tx.task.create({
        data: {
          userId: req.userId!,
          title: data.title as string,
          priority: data.priority as string,
          estimateMinutes: data.estimateMinutes as number,
          status: data.status as string,
          tag: data.tag as string | null | undefined,
          progress: data.progress as number,
          dueDate: data.dueDate as string | null | undefined,
          reminderAt: data.reminderAt as string | null | undefined,
          repeatRule: data.repeatRule as string | null | undefined,
          completedAt: data.status === 'done' ? new Date().toISOString() : null,
          deletedAt: data.deletedAt as string | null | undefined,
          sortOrder: data.sortOrder as number,
        },
      });
      await completeOperation(tx, operationId, created.id, created);
      return created;
    });
  } catch (error) {
    if (operationId && isUniqueOperationError(error)) {
      await sendRecordedOperation(res, req.userId!, operationId, 201);
      return;
    }
    throw error;
  }
  if (task.completedAt) {
    await recomputeUserStats(prisma, req.userId!);
  }
  res.status(201).json(task);
}));

// PUT /tasks/reorder — bulk update sortOrder for drag-and-drop reordering
router.put('/reorder', asyncHandler(async (req, res) => {
  const { order } = req.body as { order?: Array<{ id: string; sortOrder: number }> };
  if (!Array.isArray(order)) {
    res.status(400).json({ error: 'order must be an array of { id, sortOrder }' });
    return;
  }
  for (const item of order) {
    if (!item || typeof item.id !== 'string' || !Number.isInteger(item.sortOrder) || item.sortOrder < 0 || item.sortOrder > 1_000_000) {
      res.status(400).json({ code: 'VALIDATION_ERROR', error: 'order must contain valid id and sortOrder values' });
      return;
    }
  }
  await prisma.$transaction(
    order.map(({ id, sortOrder }) =>
      prisma.task.updateMany({
        where: { id, userId: req.userId! },
        data: { sortOrder },
      })
    )
  );
  res.json({ ok: true });
}));

// PATCH /tasks/:id — update task fields (status, progress, sortOrder, etc.)
router.patch('/:id', asyncHandler(async (req, res) => {
  const id = String(req.params.id);
  const operationId = isObject(req.body) ? normalizeOperationId(req.body.operationId) : null;
  if (operationId) {
    const recorded = await findRecordedOperation(req.userId!, operationId);
    if (recorded?.response) {
      res.json(recorded.response);
      return;
    }
  }
  const lastKnownUpdatedAt = isObject(req.body) ? normalizeLastKnownUpdatedAt(req.body.lastKnownUpdatedAt) : null;
  const data = parseTaskPayload(req.body, res, true);
  if (!data) return;
  let statsChanged = false;
  let updated;
  try {
    updated = await prisma.$transaction(async (tx) => {
      const existing = await tx.task.findFirst({ where: { id, userId: req.userId! } });
      if (!existing) return null;
      if (lastKnownUpdatedAt && existing.updatedAt.toISOString() !== lastKnownUpdatedAt) {
        return { conflict: existing };
      }
      await claimOperation(tx, req.userId!, operationId, 'update');
      if (data.status === 'done' && existing.status !== 'done' && !existing.completedAt) {
        data.completedAt = new Date().toISOString();
      } else if (data.status !== undefined && data.status !== 'done' && existing.completedAt) {
        data.completedAt = null;
      }
      const saved = await tx.task.update({
        where: { id },
        data,
      });
      statsChanged = saved.completedAt !== existing.completedAt;
      await completeOperation(tx, operationId, saved.id, saved);
      return saved;
    });
  } catch (error) {
    if (operationId && isUniqueOperationError(error)) {
      await sendRecordedOperation(res, req.userId!, operationId);
      return;
    }
    throw error;
  }
  if (!updated) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  if ('conflict' in updated) {
    conflictResponse(res, updated.conflict);
    return;
  }
  if (statsChanged) {
    await recomputeUserStats(prisma, req.userId!);
  }
  res.json(updated);
}));

// POST /tasks/:id/restore — restore a soft-deleted task
router.post('/:id/restore', asyncHandler(async (req, res) => {
  const id = String(req.params.id);
  const operationId = isObject(req.body) ? normalizeOperationId(req.body.operationId) : null;
  if (operationId) {
    const recorded = await findRecordedOperation(req.userId!, operationId);
    if (recorded?.response) {
      res.json(recorded.response);
      return;
    }
  }
  const existing = await prisma.task.findFirst({ where: { id, userId: req.userId! } });
  if (!existing) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  const lastKnownUpdatedAt = isObject(req.body) ? normalizeLastKnownUpdatedAt(req.body.lastKnownUpdatedAt) : null;
  if (lastKnownUpdatedAt && existing.updatedAt.toISOString() !== lastKnownUpdatedAt) {
    conflictResponse(res, existing);
    return;
  }
  let restored;
  try {
    restored = await prisma.$transaction(async (tx) => {
      await claimOperation(tx, req.userId!, operationId, 'restore');
      const saved = await tx.task.update({
        where: { id },
        data: { deletedAt: null },
      });
      await completeOperation(tx, operationId, saved.id, saved);
      return saved;
    });
  } catch (error) {
    if (operationId && isUniqueOperationError(error)) {
      await sendRecordedOperation(res, req.userId!, operationId);
      return;
    }
    throw error;
  }
  res.json(restored);
}));

// DELETE /tasks/:id/permanent — permanently delete a soft-deleted task
router.delete('/:id/permanent', asyncHandler(async (req, res) => {
  const id = String(req.params.id);
  const existing = await prisma.task.findFirst({ where: { id, userId: req.userId! } });
  if (!existing) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  if (!existing.deletedAt) {
    res.status(409).json({ code: 'TASK_NOT_DELETED', error: 'Task must be soft-deleted before permanent deletion' });
    return;
  }
  await prisma.task.delete({ where: { id } });
  if (existing.completedAt) {
    await recomputeUserStats(prisma, req.userId!);
  }
  res.status(204).send();
}));

// DELETE /tasks/:id — soft delete a task
router.delete('/:id', asyncHandler(async (req, res) => {
  const id = String(req.params.id);
  const operationId = isObject(req.body) ? normalizeOperationId(req.body.operationId) : null;
  if (operationId) {
    const recorded = await findRecordedOperation(req.userId!, operationId);
    if (recorded?.response) {
      res.json(recorded.response);
      return;
    }
  }
  const existing = await prisma.task.findFirst({ where: { id, userId: req.userId! } });
  if (!existing) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  const lastKnownUpdatedAt = isObject(req.body) ? normalizeLastKnownUpdatedAt(req.body.lastKnownUpdatedAt) : null;
  if (lastKnownUpdatedAt && existing.updatedAt.toISOString() !== lastKnownUpdatedAt) {
    conflictResponse(res, existing);
    return;
  }
  let deleted;
  try {
    deleted = await prisma.$transaction(async (tx) => {
      await claimOperation(tx, req.userId!, operationId, 'delete');
      const saved = await tx.task.update({
        where: { id },
        data: { deletedAt: existing.deletedAt || new Date().toISOString() },
      });
      await completeOperation(tx, operationId, saved.id, saved);
      return saved;
    });
  } catch (error) {
    if (operationId && isUniqueOperationError(error)) {
      await sendRecordedOperation(res, req.userId!, operationId);
      return;
    }
    throw error;
  }
  res.json(deleted);
}));

export default router;
