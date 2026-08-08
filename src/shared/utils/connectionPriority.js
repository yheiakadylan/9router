const MODEL_LOCK_PREFIX = "modelLock_";

function hasActiveLock(connection, model, now) {
  if (model) {
    const expiry = connection[`${MODEL_LOCK_PREFIX}${model}`] || connection.modelLock___all;
    return !!expiry && new Date(expiry).getTime() > now;
  }

  return Object.entries(connection).some(([key, expiry]) => (
    key.startsWith(MODEL_LOCK_PREFIX)
    && expiry
    && new Date(expiry).getTime() > now
  ));
}

export function isConnectionPriorityAvailable(connection, { model = null, now = Date.now() } = {}) {
  if (connection.isActive === false || connection.antigravityValidationRequired === true) return false;
  if (hasActiveLock(connection, model, now)) return false;

  const legacyCooldown = connection.rateLimitedUntil;
  return !legacyCooldown || new Date(legacyCooldown).getTime() <= now;
}

export function sortConnectionsForPriority(connections, options = {}) {
  const sortOptions = options.now === undefined
    ? { ...options, now: Date.now() }
    : options;

  return connections
    .map((connection, index) => ({ connection, index }))
    .sort((a, b) => {
      const availableA = isConnectionPriorityAvailable(a.connection, sortOptions);
      const availableB = isConnectionPriorityAvailable(b.connection, sortOptions);
      if (availableA !== availableB) return availableA ? -1 : 1;

      const priorityA = a.connection.priority ?? Number.MAX_SAFE_INTEGER;
      const priorityB = b.connection.priority ?? Number.MAX_SAFE_INTEGER;
      if (priorityA !== priorityB) return priorityA - priorityB;
      return a.index - b.index;
    })
    .map(({ connection }) => connection);
}
