export function reorderIndexChange(previousOrder, nextOrder, draggedId) {
  const previousIndex = draggedId ? previousOrder.indexOf(draggedId) : -1;
  const nextIndex = draggedId ? nextOrder.indexOf(draggedId) : -1;
  return {
    previousIndex,
    nextIndex,
    changed: previousIndex >= 0 && nextIndex >= 0 && previousIndex !== nextIndex,
  };
}

export function createReorderFeedback(adapter) {
  let active = false;
  let draggedId = null;
  let order = [];

  const end = () => {
    if (!active) return;
    active = false;
    draggedId = null;
    adapter.end();
  };

  return {
    start(id, currentOrder) {
      end();
      active = true;
      draggedId = id;
      order = [...currentOrder];
      adapter.start();
    },
    change(nextOrder) {
      const transition = reorderIndexChange(order, nextOrder, draggedId);
      order = [...nextOrder];
      if (active && transition.changed) adapter.change();
      return transition;
    },
    end,
    reset(nextOrder = []) {
      end();
      order = [...nextOrder];
    },
    isActive() {
      return active;
    },
  };
}
