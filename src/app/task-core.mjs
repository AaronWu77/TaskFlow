export const MAX_REPEAT_INSTANCES = 366;

export function normalizeTodoSortOrder(tasks) {
  let sortOrder = 0;
  return tasks.map(task => task.status === 'todo' && !task.deletedAt
    ? { ...task, sortOrder: sortOrder++ }
    : task);
}

export function applyTodoOrder(tasks, order) {
  const orderMap = new Map(order.map(item => [item.id, item.sortOrder]));
  const activeTodo = tasks
    .filter(task => task.status === 'todo' && !task.deletedAt)
    .map(task => orderMap.has(task.id) ? { ...task, sortOrder: orderMap.get(task.id) } : task)
    .sort((left, right) => {
      const leftRank = orderMap.get(left.id);
      const rightRank = orderMap.get(right.id);
      if (leftRank !== undefined || rightRank !== undefined) {
        if (leftRank === undefined) return 1;
        if (rightRank === undefined) return -1;
        if (leftRank !== rightRank) return leftRank - rightRank;
      }
      if (left.sortOrder !== right.sortOrder) return left.sortOrder - right.sortOrder;
      return String(left.id).localeCompare(String(right.id));
    });
  const activeIds = new Set(activeTodo.map(task => task.id));
  return [...activeTodo, ...tasks.filter(task => !activeIds.has(task.id))];
}

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
