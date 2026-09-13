export type RepeatRule = 'none' | 'daily' | 'weekly' | 'monthly' | null | undefined;

export const MAX_REPEAT_INSTANCES: number;
export function normalizeTodoSortOrder<T extends { status: string; deletedAt?: string | null; sortOrder: number }>(tasks: T[]): T[];
export function applyTodoOrder<T extends { id: string; status: string; deletedAt?: string | null; sortOrder: number }>(tasks: T[], order: Array<{ id: string; sortOrder: number }>): T[];
export function dateOnlyKey(date?: Date): string;
export function nextRepeatDate(dueDate: string | null | undefined, rule: RepeatRule): string | null;
export function repeatDatesAfterStart(dueDate: string, repeatUntilDate: string, rule: RepeatRule): string[];
export function repeatInstanceCount(dueDate: string, repeatUntilDate: string, rule: RepeatRule): number;
