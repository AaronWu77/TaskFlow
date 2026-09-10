export type RepeatRule = 'none' | 'daily' | 'weekly' | 'monthly' | null | undefined;

export const MAX_REPEAT_INSTANCES: number;
export function dateOnlyKey(date?: Date): string;
export function nextRepeatDate(dueDate: string | null | undefined, rule: RepeatRule): string | null;
export function repeatDatesAfterStart(dueDate: string, repeatUntilDate: string, rule: RepeatRule): string[];
export function repeatInstanceCount(dueDate: string, repeatUntilDate: string, rule: RepeatRule): number;
