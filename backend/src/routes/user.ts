import { Router, Response, NextFunction, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';

const router = Router();
const prisma = new PrismaClient();

router.use(authMiddleware);

function asyncHandler(fn: (req: AuthRequest, res: Response, next: NextFunction) => Promise<void>): RequestHandler {
  return (req, res, next) => fn(req as AuthRequest, res, next).catch(next);
}

// GET /user/stats — get current user's streak and completion stats
router.get('/stats', asyncHandler(async (req, res) => {
  let stats = await prisma.userStats.findUnique({
    where: { userId: req.userId! },
  });
  if (!stats) {
    stats = await prisma.userStats.create({
      data: { userId: req.userId!, streak: 0, todayCount: 0 },
    });
  }

  // Reset todayCount if the stored date is not today
  const today = new Date().toISOString().split('T')[0];
  if (stats.completedToday !== today) {
    stats = await prisma.userStats.update({
      where: { userId: req.userId! },
      data: { completedToday: today, todayCount: 0 },
    });
  }

  res.json({
    streak: stats.streak,
    streakDate: stats.streakDate,
    completedToday: stats.completedToday,
    todayCount: stats.todayCount,
  });
}));

// PATCH /user/stats — update completion stats. Client computes streak, server stores it.
router.patch('/stats', asyncHandler(async (req, res) => {
  const { todayCount, streak: clientStreak } = req.body as { todayCount?: number; streak?: number };

  const today = new Date().toISOString().split('T')[0];
  let stats = await prisma.userStats.findUnique({ where: { userId: req.userId! } });

  if (!stats) {
    stats = await prisma.userStats.create({
      data: { userId: req.userId!, streak: 0, todayCount: 0 },
    });
  }

  // If client sent a streak value, use it directly; otherwise keep current
  const newStreak = clientStreak !== undefined ? clientStreak : stats.streak;
  const streakDate = clientStreak !== undefined ? today : stats.streakDate;

  const newCount = todayCount ?? (stats.todayCount + 1);
  stats = await prisma.userStats.update({
    where: { userId: req.userId! },
    data: {
      streak: newStreak,
      streakDate,
      completedToday: today,
      todayCount: newCount,
    },
  });

  res.json({
    streak: stats.streak,
    streakDate: stats.streakDate,
    completedToday: stats.completedToday,
    todayCount: stats.todayCount,
  });
}));

export default router;
