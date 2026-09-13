export function patchTaskDraft(current, patch) {
  return { ...current, ...patch };
}

export function snapshotTaskDraft(current) {
  return { ...current };
}

export function taskDraftFromFieldValues(current, values) {
  const read = (name) => typeof values?.get === 'function' ? values.get(name) : values?.[name];
  const next = { ...current };
  for (const field of ['title', 'minutes', 'dueDate', 'reminderAt', 'repeatUntilDate', 'tag']) {
    const value = read(field);
    if (typeof value === 'string') next[field] = value;
  }
  const priority = read('priority');
  if (priority === 'P1' || priority === 'P2' || priority === 'P3') next.priority = priority;
  const repeatRule = read('repeatRule');
  if (repeatRule === 'none' || repeatRule === 'daily' || repeatRule === 'weekly' || repeatRule === 'monthly') {
    next.repeatRule = repeatRule;
  }
  return next;
}
