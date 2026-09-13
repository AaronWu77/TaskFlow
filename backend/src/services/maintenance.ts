import { prisma } from '../prisma-client';

const DAY_MS = 24 * 60 * 60 * 1000;

export async function runMaintenance(now = new Date()): Promise<void> {
  const nowMs = now.getTime();
  await Promise.all([
    prisma.taskChange.deleteMany({ where: { createdAt: { lt: new Date(nowMs - 180 * DAY_MS) } } }),
    prisma.taskOperation.deleteMany({ where: { createdAt: { lt: new Date(nowMs - 365 * DAY_MS) } } }),
    prisma.rateLimitBucket.deleteMany({ where: { resetAt: { lt: new Date(nowMs - DAY_MS) } } }),
    prisma.emailVerification.deleteMany({ where: { expiresAt: { lt: new Date(nowMs - DAY_MS) } } }),
  ]);
}
