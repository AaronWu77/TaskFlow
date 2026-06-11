import { Router, Response, NextFunction, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { recomputeUserStats } from '../services/stats';

const router = Router();
const prisma = new PrismaClient();

router.use(authMiddleware);

function asyncHandler(fn: (req: AuthRequest, res: Response, next: NextFunction) => Promise<void>): RequestHandler {
  return (req, res, next) => fn(req as AuthRequest, res, next).catch(next);
}

// GET /user/export — export current user's data as JSON
router.get('/export', asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.userId! },
    select: {
      id: true,
      email: true,
      emailVerifiedAt: true,
      displayName: true,
      timezone: true,
      locale: true,
      createdAt: true,
      updatedAt: true,
      lastLoginAt: true,
      deletedAt: true,
    },
  });
  if (!user || user.deletedAt) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const [tasks, stats] = await Promise.all([
    prisma.task.findMany({
      where: { userId: req.userId! },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.userStats.findUnique({ where: { userId: req.userId! } }),
  ]);

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="taskflow-export-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({
    exportedAt: new Date().toISOString(),
    user,
    stats,
    tasks,
  });
}));

// DELETE /user/account — delete current account and all related data
router.delete('/account', asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId! } });
  if (!user || user.deletedAt) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.refreshSession.updateMany({
      where: { userId: req.userId!, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await tx.user.delete({ where: { id: req.userId! } });
  });

  res.clearCookie('taskflow_refresh', {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE === 'true',
    sameSite: 'lax',
  });
  res.status(204).send();
}));

// GET /user/stats — get current user's streak and completion stats
router.get('/stats', asyncHandler(async (req, res) => {
  const stats = await recomputeUserStats(prisma, req.userId!);

  res.json({
    streak: stats.streak,
    streakDate: stats.streakDate,
    completedToday: stats.completedToday,
    todayCount: stats.todayCount,
  });
}));

// PATCH /user/stats — recompute completion stats from server-owned task completion records.
router.patch('/stats', asyncHandler(async (req, res) => {
  const stats = await recomputeUserStats(prisma, req.userId!);

  res.json({
    streak: stats.streak,
    streakDate: stats.streakDate,
    completedToday: stats.completedToday,
    todayCount: stats.todayCount,
  });
}));

export default router;
