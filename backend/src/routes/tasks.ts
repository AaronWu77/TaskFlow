import { Router, Response, NextFunction, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';

const router = Router();
const prisma = new PrismaClient();

router.use(authMiddleware);

/** Wraps an async route handler so unhandled rejections propagate to Express error middleware */
function asyncHandler(fn: (req: AuthRequest, res: Response, next: NextFunction) => Promise<void>): RequestHandler {
  return (req, res, next) => fn(req as AuthRequest, res, next).catch(next);
}

// GET /tasks — list all tasks for the current user, ordered by sortOrder
router.get('/', asyncHandler(async (req, res) => {
  const tasks = await prisma.task.findMany({
    where: { userId: req.userId! },
    orderBy: { sortOrder: 'asc' },
  });
  res.json(tasks);
}));

// POST /tasks — create a new task
router.post('/', asyncHandler(async (req, res) => {
  const { title, priority, estimateMinutes, status, tag, progress, dueDate, reminderAt, repeatRule, deletedAt, sortOrder } = req.body as {
    title?: string;
    priority?: string;
    estimateMinutes?: number;
    status?: string;
    tag?: string;
    progress?: number;
    dueDate?: string | null;
    reminderAt?: string | null;
    repeatRule?: string | null;
    deletedAt?: string | null;
    sortOrder?: number;
  };
  if (!title || !priority || estimateMinutes === undefined) {
    res.status(400).json({ error: 'title, priority, and estimateMinutes are required' });
    return;
  }
  const task = await prisma.task.create({
    data: {
      userId: req.userId!,
      title,
      priority,
      estimateMinutes,
      status: status || 'todo',
      tag,
      progress: progress ?? 0,
      dueDate: dueDate ?? null,
      reminderAt: reminderAt ?? null,
      repeatRule: repeatRule ?? null,
      deletedAt: deletedAt ?? null,
      sortOrder: sortOrder ?? 0,
    },
  });
  res.status(201).json(task);
}));

// PATCH /tasks/:id — update task fields (status, progress, sortOrder, etc.)
router.patch('/:id', asyncHandler(async (req, res) => {
  const id = String(req.params.id);
  const existing = await prisma.task.findFirst({ where: { id, userId: req.userId! } });
  if (!existing) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  const { title, priority, estimateMinutes, status, tag, progress, dueDate, reminderAt, repeatRule, deletedAt, sortOrder } = req.body as Partial<{
    title: string;
    priority: string;
    estimateMinutes: number;
    status: string;
    tag: string;
    progress: number;
    dueDate: string | null;
    reminderAt: string | null;
    repeatRule: string | null;
    deletedAt: string | null;
    sortOrder: number;
  }>;
  const updated = await prisma.task.update({
    where: { id },
    data: {
      ...(title !== undefined && { title }),
      ...(priority !== undefined && { priority }),
      ...(estimateMinutes !== undefined && { estimateMinutes }),
      ...(status !== undefined && { status }),
      ...(tag !== undefined && { tag }),
      ...(progress !== undefined && { progress }),
      ...(dueDate !== undefined && { dueDate }),
      ...(reminderAt !== undefined && { reminderAt }),
      ...(repeatRule !== undefined && { repeatRule }),
      ...(deletedAt !== undefined && { deletedAt }),
      ...(sortOrder !== undefined && { sortOrder }),
    },
  });
  res.json(updated);
}));

// DELETE /tasks/:id
router.delete('/:id', asyncHandler(async (req, res) => {
  const id = String(req.params.id);
  const existing = await prisma.task.findFirst({ where: { id, userId: req.userId! } });
  if (!existing) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  await prisma.task.delete({ where: { id } });
  res.status(204).send();
}));

// PUT /tasks/reorder — bulk update sortOrder for drag-and-drop reordering
router.put('/reorder', asyncHandler(async (req, res) => {
  const { order } = req.body as { order?: Array<{ id: string; sortOrder: number }> };
  if (!Array.isArray(order)) {
    res.status(400).json({ error: 'order must be an array of { id, sortOrder }' });
    return;
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

export default router;
