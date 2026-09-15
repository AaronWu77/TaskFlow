import { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { addCalendarDays, dateInTimeZone, isValidTimeZone } from '../date-utils';

type StatsClient = PrismaClient | Prisma.TransactionClient;
type CompletionSnapshot = {
  status: string;
  deletedAt?: string | null;
  deletedAtTyped?: Date | null;
  completedAt?: string | null;
  completedAtTyped?: Date | null;
};

async function lockUserStats(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  // Transaction-scoped and deterministic across API processes. This prevents a
  // timezone rebuild from deleting an increment committed by a concurrent task
  // completion for the same account.
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`taskflow-stats:${userId}`}))`);
}

function effectiveTimeZone(timezone: string | null | undefined): string {
  return timezone && isValidTimeZone(timezone) ? timezone : 'UTC';
}

function completionDay(task: CompletionSnapshot | null, timezone: string): string | null {
  if (!task || task.status !== 'done' || task.deletedAtTyped || task.deletedAt) return null;
  const completedAt = task.completedAtTyped ?? task.completedAt;
  return completedAt ? dateInTimeZone(completedAt, timezone) : null;
}

async function incrementDay(tx: Prisma.TransactionClient, userId: string, date: string): Promise<void> {
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "UserDailyStats" ("id", "userId", "date", "count", "createdAt", "updatedAt")
    VALUES (${randomUUID()}, ${userId}, ${date}, 1, NOW(), NOW())
    ON CONFLICT ("userId", "date") DO UPDATE
    SET "count" = "UserDailyStats"."count" + 1, "updatedAt" = NOW()
  `);
}

async function decrementDay(tx: Prisma.TransactionClient, userId: string, date: string): Promise<void> {
  const decremented = await tx.userDailyStats.updateMany({
    where: { userId, date, count: { gt: 1 } },
    data: { count: { decrement: 1 } },
  });
  if (decremented.count === 0) {
    await tx.userDailyStats.deleteMany({ where: { userId, date, count: { lte: 1 } } });
  }
}

export async function applyTaskStatsDelta(
  tx: Prisma.TransactionClient,
  userId: string,
  before: CompletionSnapshot | null,
  after: CompletionSnapshot | null,
): Promise<void> {
  await lockUserStats(tx, userId);
  const user = await tx.user.findUnique({ where: { id: userId }, select: { timezone: true } });
  const timezone = effectiveTimeZone(user?.timezone);
  const beforeDay = completionDay(before, timezone);
  const afterDay = completionDay(after, timezone);
  if (beforeDay === afterDay) return;
  if (beforeDay) await decrementDay(tx, userId, beforeDay);
  if (afterDay) await incrementDay(tx, userId, afterDay);
}

async function refreshSummary(prisma: StatsClient, userId: string, now = new Date()) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } });
  const timezone = effectiveTimeZone(user?.timezone);
  const today = dateInTimeZone(now, timezone)!;
  const rows = await prisma.userDailyStats.findMany({
    where: { userId, count: { gt: 0 }, date: { lte: today } },
    orderBy: { date: 'desc' },
    select: { date: true, count: true },
  });
  const countByDay = new Map(rows.map(row => [row.date, row.count]));
  const yesterday = addCalendarDays(today, -1);
  const streakStart = countByDay.has(today) ? today : countByDay.has(yesterday) ? yesterday : null;
  let cursor = streakStart;
  let streak = 0;
  while (cursor && countByDay.has(cursor)) {
    streak += 1;
    cursor = addCalendarDays(cursor, -1);
  }
  return prisma.userStats.upsert({
    where: { userId },
    create: { userId, streak, streakDate: streakStart, completedToday: today, todayCount: countByDay.get(today) ?? 0 },
    update: { streak, streakDate: streakStart, completedToday: today, todayCount: countByDay.get(today) ?? 0 },
  });
}

// Normal writes update UserDailyStats incrementally. This reads that compact
// aggregate rather than scanning every completed task.
export async function recomputeUserStats(prisma: StatsClient, userId: string, now = new Date()) {
  return refreshSummary(prisma, userId, now);
}

// A timezone change is the exceptional case that re-buckets history once.
export async function rebuildUserStats(prisma: PrismaClient, userId: string, now = new Date()) {
  return prisma.$transaction(async tx => {
    await lockUserStats(tx, userId);
    const user = await tx.user.findUnique({ where: { id: userId }, select: { timezone: true } });
    const timezone = effectiveTimeZone(user?.timezone);
    const tasks = await tx.task.findMany({
      where: { userId, status: 'done', deletedAtTyped: null, completedAtTyped: { not: null } },
      select: { completedAtTyped: true },
    });
    const counts = new Map<string, number>();
    for (const task of tasks) {
      const date = task.completedAtTyped ? dateInTimeZone(task.completedAtTyped, timezone) : null;
      if (date) counts.set(date, (counts.get(date) ?? 0) + 1);
    }
    await tx.userDailyStats.deleteMany({ where: { userId } });
    if (counts.size > 0) {
      await tx.userDailyStats.createMany({ data: [...counts].map(([date, count]) => ({ userId, date, count })) });
    }
    return refreshSummary(tx, userId, now);
  });
}
