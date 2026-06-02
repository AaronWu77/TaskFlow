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

// PATCH /user/stats — update streak and completion stats
router.patch('/stats', asyncHandler(async (req, res) => {
  const { streak, streakDate, completedToday, todayCount } = req.body as {
    streak?: number;
    streakDate?: string;
    completedToday?: string;
    todayCount?: number;
  };

  let stats = await prisma.userStats.findUnique({
    where: { userId: req.userId! },
  });

  const data: Record<string, unknown> = {};
  if (streak !== undefined) data.streak = streak;
  if (streakDate !== undefined) data.streakDate = streakDate;
  if (completedToday !== undefined) data.completedToday = completedToday;
  if (todayCount !== undefined) data.todayCount = todayCount;

  if (stats) {
    stats = await prisma.userStats.update({
      where: { userId: req.userId! },
      data,
    });
  } else {
    stats = await prisma.userStats.create({
      data: { userId: req.userId!, ...data } as any,
    });
  }

  res.json({
    streak: stats.streak,
    streakDate: stats.streakDate,
    completedToday: stats.completedToday,
    todayCount: stats.todayCount,
  });
}));

export default router;
