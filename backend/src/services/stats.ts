import { PrismaClient } from '@prisma/client';
import { addCalendarDays, dateInTimeZone, isValidTimeZone } from '../date-utils';

export async function recomputeUserStats(prisma: PrismaClient, userId: string, now = new Date()) {
  const [user, completedTasks] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } }),
    prisma.task.findMany({
      where: { userId, status: 'done', deletedAt: null, completedAt: { not: null } },
      select: { completedAt: true },
    }),
  ]);
  const timeZone = user?.timezone && isValidTimeZone(user.timezone) ? user.timezone : 'UTC';

  const countsByDay = new Map<string, number>();
  for (const task of completedTasks) {
    if (!task.completedAt) continue;
    const completedDate = dateInTimeZone(task.completedAt, timeZone);
    if (!completedDate) continue;
    countsByDay.set(completedDate, (countsByDay.get(completedDate) ?? 0) + 1);
  }

  const today = dateInTimeZone(now, timeZone)!;
  const yesterday = addCalendarDays(today, -1);
  const streakStart = countsByDay.has(today) ? today : countsByDay.has(yesterday) ? yesterday : null;
  let streak = 0;
  let cursor = streakStart;
  while (cursor && countsByDay.has(cursor)) {
    streak += 1;
    cursor = addCalendarDays(cursor, -1);
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
