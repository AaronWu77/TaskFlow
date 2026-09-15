import { Router, Response, NextFunction, RequestHandler } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { rebuildUserStats, recomputeUserStats } from '../services/stats';
import { prisma } from '../prisma-client';
import { isValidTimeZone } from '../date-utils';
import { sensitiveAuthMiddleware } from '../middleware/sensitive-auth';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';

const router = Router();

router.use(authMiddleware);

function asyncHandler(fn: (req: AuthRequest, res: Response, next: NextFunction) => Promise<void>): RequestHandler {
  return (req, res, next) => fn(req as AuthRequest, res, next).catch(next);
}

// PATCH /user/preferences — persist locale and timezone used by server-side stats.
router.patch('/preferences', asyncHandler(async (req, res) => {
  const timezone = req.body?.timezone;
  const locale = req.body?.locale;
  const displayName = req.body?.displayName;
  if (timezone !== undefined && (typeof timezone !== 'string' || !isValidTimeZone(timezone))) {
    res.status(400).json({ code: 'INVALID_TIMEZONE', error: 'Invalid timezone' });
    return;
  }
  if (locale !== undefined && (typeof locale !== 'string' || !['zh', 'en'].includes(locale))) {
    res.status(400).json({ code: 'INVALID_LOCALE', error: 'Unsupported locale' });
    return;
  }
  if (displayName !== undefined && (typeof displayName !== 'string' || displayName.trim().length > 80)) {
    res.status(400).json({ code: 'INVALID_DISPLAY_NAME', error: 'Display name is too long' });
    return;
  }
  const user = await prisma.user.update({
    where: { id: req.userId! },
    data: {
      timezone,
      locale,
      displayName: displayName === undefined ? undefined : displayName.trim() || null,
    },
    select: { id: true, email: true, emailVerifiedAt: true, displayName: true, timezone: true, locale: true },
  });
  if (timezone !== undefined) await rebuildUserStats(prisma, req.userId!);
  res.json(user);
}));

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

  const [tasks, taskSeries, stats, dailyStats, devices, sessions, syncState] = await Promise.all([
    prisma.task.findMany({
      where: { userId: req.userId! },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.taskSeries.findMany({
      where: { userId: req.userId! },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.userStats.findUnique({ where: { userId: req.userId! } }),
    prisma.userDailyStats.findMany({
      where: { userId: req.userId! },
      orderBy: { date: 'asc' },
      select: { date: true, count: true },
    }),
    prisma.device.findMany({
      where: { userId: req.userId! },
      orderBy: { lastSeenAt: 'desc' },
      select: { id: true, name: true, platform: true, createdAt: true, lastSeenAt: true },
    }),
    prisma.refreshSession.findMany({
      where: { userId: req.userId! },
      orderBy: { createdAt: 'desc' },
      select: { id: true, familyId: true, deviceName: true, platform: true, createdAt: true, lastSeenAt: true, expiresAt: true, revokedAt: true },
    }),
    prisma.userSyncState.findUnique({
      where: { userId: req.userId! },
      select: { nextSeq: true, taskOrderVersion: true },
    }),
  ]);

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="taskflow-export-${new Date().toISOString().slice(0, 10)}.json"`);
  const exportedAt = new Date().toISOString();
  const exportData = {
    exportSchemaVersion: 2,
    appVersion: process.env.APP_VERSION || 'unknown',
    exportedAt,
    timezone: user.timezone || 'UTC',
    user,
    stats,
    dailyStats,
    tasks,
    taskSeries,
    devices,
    sessions,
    sync: syncState ? { currentCursor: syncState.nextSeq - 1, taskOrderVersion: syncState.taskOrderVersion } : null,
  };
  const checksum = crypto.createHash('sha256').update(JSON.stringify(exportData)).digest('hex');
  res.json({
    ...exportData,
    checksum: { algorithm: 'sha256', value: checksum, covers: 'all top-level fields except checksum and jsonSchema' },
    jsonSchema: 'https://taskflow.top/schemas/export-v2.json',
  });
}));

// DELETE /user/account — schedule deletion after a recovery grace period.
router.delete('/account', sensitiveAuthMiddleware, asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId! } });
  if (!user || user.deletedAt) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const now = new Date();
  const deleteScheduledFor = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
  await prisma.$transaction(async (tx) => {
    await tx.refreshSession.updateMany({
      where: { userId: req.userId!, revokedAt: null },
      data: { revokedAt: now },
    });
    await tx.user.update({
      where: { id: req.userId! },
      data: { deletedAt: now, deleteScheduledFor, authVersion: { increment: 1 } },
    });
    await tx.accountDeletionAudit.create({
      data: {
        userId: user.id,
        emailHash: crypto.createHash('sha256').update(user.email).digest('hex'),
        action: 'scheduled',
        scheduledFor: deleteScheduledFor,
      },
    });
  });

  res.clearCookie('taskflow_refresh', {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE === 'true',
    sameSite: 'lax',
  });
  res.json({ deletedAt: now.toISOString(), deleteScheduledFor: deleteScheduledFor.toISOString() });
}));

router.patch('/password', sensitiveAuthMiddleware, asyncHandler(async (req, res) => {
  const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
  if (newPassword.length < 8 || newPassword.length > 128 || !/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) {
    res.status(400).json({ code: 'WEAK_PASSWORD', error: 'Password must be 8-128 characters and include a letter and a number' });
    return;
  }
  const now = new Date();
  const password = await bcrypt.hash(newPassword, 12);
  await prisma.$transaction([
    prisma.user.update({ where: { id: req.userId! }, data: { password, passwordChangedAt: now, authVersion: { increment: 1 } } }),
    prisma.refreshSession.updateMany({ where: { userId: req.userId!, revokedAt: null }, data: { revokedAt: now } }),
  ]);
  res.json({ ok: true });
}));

router.get('/sessions', asyncHandler(async (req, res) => {
  const now = new Date();
  const sessions = await prisma.refreshSession.findMany({
    where: { userId: req.userId!, revokedAt: null, expiresAt: { gt: now } },
    orderBy: { lastSeenAt: 'desc' },
    select: { id: true, familyId: true, deviceName: true, platform: true, createdAt: true, lastSeenAt: true, expiresAt: true },
  });
  res.json({ sessions });
}));

router.delete('/sessions/:id', asyncHandler(async (req, res) => {
  const sessionId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const revoked = await prisma.refreshSession.updateMany({
    where: { id: sessionId, userId: req.userId!, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (revoked.count === 0) {
    res.status(404).json({ code: 'SESSION_NOT_FOUND', error: 'Session not found' });
    return;
  }
  res.json({ ok: true });
}));

router.delete('/sessions', sensitiveAuthMiddleware, asyncHandler(async (req, res) => {
  const now = new Date();
  const result = await prisma.$transaction(async tx => {
    const revoked = await tx.refreshSession.updateMany({
      where: { userId: req.userId!, revokedAt: null },
      data: { revokedAt: now },
    });
    await tx.user.update({ where: { id: req.userId! }, data: { authVersion: { increment: 1 } } });
    return revoked;
  });
  res.json({ ok: true, revokedCount: result.count });
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
