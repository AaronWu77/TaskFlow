export function createAuthSessionManager() {
  let generation = 0;
  let context = null;
  const controllers = new Map();

  const abortAll = () => {
    for (const active of controllers.values()) {
      for (const controller of active) controller.abort();
    }
    controllers.clear();
  };

  const replace = (userId, accessToken) => {
    generation += 1;
    abortAll();
    context = userId ? Object.freeze({ generation, userId, accessToken }) : null;
    return context;
  };

  const isCurrent = captured => {
    if (!captured) return context === null;
    return context?.generation === captured.generation && context.userId === captured.userId;
  };

  return {
    get generation() { return generation; },
    current() { return context; },
    prepare(userId) {
      if (!userId || context?.userId === userId) return context;
      return replace(userId, null);
    },
    activate(userId, accessToken) { return replace(userId, accessToken); },
    clear() { replace(null, null); },
    isCurrent,
    updateToken(captured, accessToken) {
      if (!captured || !isCurrent(captured)) return false;
      context = Object.freeze({ ...context, accessToken });
      return true;
    },
    track(captured, controller) {
      if (!captured) return () => {};
      if (!isCurrent(captured)) {
        controller.abort();
        return () => {};
      }
      const active = controllers.get(captured.generation) ?? new Set();
      active.add(controller);
      controllers.set(captured.generation, active);
      return () => {
        active.delete(controller);
        if (active.size === 0) controllers.delete(captured.generation);
      };
    },
  };
}
