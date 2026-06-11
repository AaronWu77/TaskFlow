import { PrismaClient } from '@prisma/client';

function dateOnly(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return dateOnly(next);
}

export async function recomputeUserStats(prisma: PrismaClient, userId: string) {
  const completedTasks = await prisma.task.findMany({
    where: {
      userId,
      completedAt: { not: null },
    },
    select: { completedAt: true },
  });

  const countsByDay = new Map<string, number>();
  for (const task of completedTasks) {
    if (!task.completedAt) continue;
    const completedDate = task.completedAt.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(completedDate)) continue;
    countsByDay.set(completedDate, (countsByDay.get(completedDate) ?? 0) + 1);
  }

  const today = dateOnly();
  const yesterday = addDays(today, -1);
  const streakStart = countsByDay.has(today) ? today : countsByDay.has(yesterday) ? yesterday : null;
  let streak = 0;
  let cursor = streakStart;
  while (cursor && countsByDay.has(cursor)) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }

  return prisma.userStats.upsert({
    where: { userId },
    create: {
      userId,
      streak,
      streakDate: streakStart,
      completedToday: today,
      todayCount: countsByDay.get(today) ?? 0,
    },
    update: {
      streak,
      streakDate: streakStart,
      completedToday: today,
      todayCount: countsByDay.get(today) ?? 0,
    },
  });
}
