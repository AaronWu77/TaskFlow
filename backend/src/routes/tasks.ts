import { Router, Response, NextFunction, RequestHandler } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { prisma } from '../prisma-client';

const router = Router();
router.use(authMiddleware);

function asyncHandler(fn: (req: AuthRequest, res: Response, next: NextFunction) => Promise<void>): RequestHandler {
  return (req, res, next) => fn(req as AuthRequest, res, next).catch(next);
}

// Mutations intentionally live only in /sync/push so every write advances the
// sync log and is visible to the user's other devices.
router.get('/', asyncHandler(async (req, res) => {
  const tasks = await prisma.task.findMany({
    where: { userId: req.userId!, deletedAt: null },
    orderBy: { sortOrder: 'asc' },
  });
  res.json(tasks);
}));

router.get('/deleted', asyncHandler(async (req, res) => {
  const tasks = await prisma.task.findMany({
    where: { userId: req.userId!, deletedAt: { not: null } },
    orderBy: { deletedAt: 'desc' },
  });
  res.json(tasks);
}));

router.all('*', (_req, res) => {
  res.status(410).json({
    code: 'SYNC_PROTOCOL_REQUIRED',
    error: 'Task mutations must be submitted through /sync/push',
  });
});

export default router;
