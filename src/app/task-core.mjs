export const MAX_REPEAT_INSTANCES = 366;

export function dateOnlyKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function nextRepeatDate(dueDate, rule) {
  if (!dueDate || !rule || rule === 'none') return null;
  const next = new Date(`${dueDate}T12:00:00`);
  if (Number.isNaN(next.getTime())) return null;
  if (rule === 'daily') next.setDate(next.getDate() + 1);
  if (rule === 'weekly') next.setDate(next.getDate() + 7);
  if (rule === 'monthly') {
    const originalDay = next.getDate();
    next.setDate(1);
    next.setMonth(next.getMonth() + 1);
    const daysInTargetMonth = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
    next.setDate(Math.min(originalDay, daysInTargetMonth));
  }
  return dateOnlyKey(next);
}

export function repeatDatesAfterStart(dueDate, repeatUntilDate, rule) {
  const dates = [];
  if (rule === 'monthly') {
    const start = new Date(`${dueDate}T12:00:00`);
    if (Number.isNaN(start.getTime())) return dates;
    const anchorDay = start.getDate();
    for (let offset = 1; dates.length < MAX_REPEAT_INSTANCES; offset += 1) {
      const candidate = new Date(start.getFullYear(), start.getMonth() + offset, 1, 12);
      const daysInTargetMonth = new Date(candidate.getFullYear(), candidate.getMonth() + 1, 0).getDate();
      candidate.setDate(Math.min(anchorDay, daysInTargetMonth));
      const value = dateOnlyKey(candidate);
      if (value > repeatUntilDate) break;
      dates.push(value);
    }
    return dates;
  }
  let next = nextRepeatDate(dueDate, rule);
  while (next && next <= repeatUntilDate && dates.length < MAX_REPEAT_INSTANCES) {
    dates.push(next);
    next = nextRepeatDate(next, rule);
  }
  return dates;
}

export function repeatInstanceCount(dueDate, repeatUntilDate, rule) {
  if (!dueDate || !repeatUntilDate || !rule || rule === 'none' || repeatUntilDate <= dueDate) return 0;
  return repeatDatesAfterStart(dueDate, repeatUntilDate, rule).length + 1;
}
