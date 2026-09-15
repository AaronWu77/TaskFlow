const SCHEMA_VERSION = 1;

function checksum(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function encodeSyncState(payload, revision) {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new TypeError('revision must be a positive safe integer');
  const serializedPayload = JSON.stringify(payload);
  return JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    revision,
    checksum: checksum(serializedPayload),
    payload,
  });
}

export function decodeSyncState(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const envelope = JSON.parse(raw);
    if (!envelope || typeof envelope !== 'object'
      || envelope.schemaVersion !== SCHEMA_VERSION
      || !Number.isSafeInteger(envelope.revision)
      || envelope.revision < 1
      || typeof envelope.checksum !== 'string'
      || !envelope.payload
      || typeof envelope.payload !== 'object') return null;
    const serializedPayload = JSON.stringify(envelope.payload);
    if (checksum(serializedPayload) !== envelope.checksum) return null;
    return { revision: envelope.revision, payload: envelope.payload };
  } catch {
    return null;
  }
}

export function selectNewestSyncState(firstRaw, secondRaw) {
  const states = [decodeSyncState(firstRaw), decodeSyncState(secondRaw)].filter(Boolean);
  if (states.length === 0) return null;
  states.sort((left, right) => right.revision - left.revision);
  return states[0];
}
