import { prisma } from '../prisma-client';
import crypto from 'node:crypto';

const DAY_MS = 24 * 60 * 60 * 1000;

export async function runMaintenance(now = new Date()): Promise<void> {
  const nowMs = now.getTime();
  const offlineBoundary = new Date(nowMs - 180 * DAY_MS);
  const compactBefore = new Date(nowMs - 30 * DAY_MS);
  await prisma.device.updateMany({
    where: { lastSeenAt: { lt: offlineBoundary }, requiresBootstrap: false },
    data: { requiresBootstrap: true },
  });

  // Cursor through every account. A fixed `take` without a cursor would keep
  // selecting the same first 1,000 users forever once the service grows.
  const syncStateBatchSize = 200;
  let syncStateCursor: string | undefined;
  for (;;) {
    const syncStates = await prisma.userSyncState.findMany({
      select: { id: true, userId: true },
      orderBy: { id: 'asc' },
      take: syncStateBatchSize,
      ...(syncStateCursor ? { cursor: { id: syncStateCursor }, skip: 1 } : {}),
    });
    if (syncStates.length === 0) break;
    for (const state of syncStates) {
      const watermark = await prisma.device.aggregate({
        where: { userId: state.userId, requiresBootstrap: false, lastSeenAt: { gte: offlineBoundary } },
        _min: { lastAcknowledgedCursor: true },
        _count: { id: true },
      });
      if (watermark._count.id > 0 && watermark._min.lastAcknowledgedCursor !== null) {
        await prisma.taskChange.deleteMany({
          where: {
            userId: state.userId,
            seq: { lte: watermark._min.lastAcknowledgedCursor },
            createdAt: { lt: compactBefore },
          },
        });
      } else {
        await prisma.taskChange.deleteMany({
          where: { userId: state.userId, createdAt: { lt: offlineBoundary } },
        });
      }
    }
    syncStateCursor = syncStates[syncStates.length - 1].id;
    if (syncStates.length < syncStateBatchSize) break;
  }

  await Promise.all([
    prisma.taskOperation.deleteMany({ where: { createdAt: { lt: new Date(nowMs - 365 * DAY_MS) } } }),
    prisma.rateLimitBucket.deleteMany({ where: { resetAt: { lt: new Date(nowMs - DAY_MS) } } }),
    prisma.emailVerification.deleteMany({ where: { expiresAt: { lt: new Date(nowMs - DAY_MS) } } }),
    prisma.passwordReset.deleteMany({ where: { expiresAt: { lt: new Date(nowMs - DAY_MS) } } }),
    prisma.refreshSession.deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: new Date(nowMs - 30 * DAY_MS) } },
          { revokedAt: { lt: new Date(nowMs - 30 * DAY_MS) } },
        ],
      },
    }),
  ]);

  const usersToPurge = await prisma.user.findMany({
    where: { deletedAt: { not: null }, deleteScheduledFor: { lte: now } },
    select: { id: true, email: true, deleteScheduledFor: true },
    take: 100,
  });
  for (const user of usersToPurge) {
    await prisma.$transaction(async tx => {
      await tx.accountDeletionAudit.create({
        data: {
          userId: user.id,
          emailHash: crypto.createHash('sha256').update(user.email).digest('hex'),
          action: 'permanently-deleted',
          scheduledFor: user.deleteScheduledFor,
        },
      });
      await tx.user.delete({ where: { id: user.id } });
    });
  }
}
