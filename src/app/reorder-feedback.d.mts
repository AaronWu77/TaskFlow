export function reorderIndexChange(
  previousOrder: string[],
  nextOrder: string[],
  draggedId: string | null,
): { previousIndex: number; nextIndex: number; changed: boolean };

export function createReorderFeedback(adapter: {
  start(): void;
  change(): void;
  end(): void;
}): {
  start(id: string, currentOrder: string[]): void;
  change(nextOrder: string[]): { previousIndex: number; nextIndex: number; changed: boolean };
  end(): void;
  reset(nextOrder?: string[]): void;
  isActive(): boolean;
};
