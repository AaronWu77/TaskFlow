const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format();
    return timeZone.length <= 100;
  } catch {
    return false;
  }
}

export function dateInTimeZone(value: Date | string, timeZone: string): string | null {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime()) || !isValidTimeZone(timeZone)) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value;
  const result = `${part('year')}-${part('month')}-${part('day')}`;
  return DATE_RE.test(result) ? result : null;
}

export function addCalendarDays(dateOnly: string, days: number): string {
  const date = new Date(`${dateOnly}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export type RepeatRule = 'daily' | 'weekly' | 'monthly';

export function nextOccurrenceDate(dateOnly: string, rule: RepeatRule, anchorDay: number): string {
  if (rule === 'daily') return addCalendarDays(dateOnly, 1);
  if (rule === 'weekly') return addCalendarDays(dateOnly, 7);
  const current = new Date(`${dateOnly}T12:00:00.000Z`);
  const nextMonth = current.getUTCMonth() + 1;
  const year = current.getUTCFullYear() + Math.floor(nextMonth / 12);
  const month = nextMonth % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0, 12)).getUTCDate();
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(Math.min(anchorDay, lastDay)).padStart(2, '0')}`;
}

export function occurrenceDates(
  startDate: string,
  untilDate: string,
  rule: RepeatRule,
  horizonDate: string,
  afterDate?: string | null,
  limit = 100,
): string[] {
  const target = untilDate < horizonDate ? untilDate : horizonDate;
  const anchorDay = Number.parseInt(startDate.slice(8, 10), 10);
  const dates: string[] = [];
  let cursor = startDate;
  while (cursor <= target && dates.length < limit) {
    if (!afterDate || cursor > afterDate) dates.push(cursor);
    const next = nextOccurrenceDate(cursor, rule, anchorDay);
    if (next <= cursor) break;
    cursor = next;
  }
  return dates;
}
