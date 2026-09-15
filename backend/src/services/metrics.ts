const MAX_SAMPLES = 2000;
const requestSamples: Array<{ status: number; durationMs: number }> = [];
let syncAccepted = 0;
let syncConflicts = 0;
let syncRejected = 0;
const startedAt = new Date();

export function recordHttpMetric(status: number, durationMs: number): void {
  requestSamples.push({ status, durationMs });
  if (requestSamples.length > MAX_SAMPLES) requestSamples.splice(0, requestSamples.length - MAX_SAMPLES);
}

export function recordSyncMetric(accepted: number, conflicts: number, rejected: number): void {
  syncAccepted += accepted;
  syncConflicts += conflicts;
  syncRejected += rejected;
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

export function metricsSnapshot() {
  const requests = requestSamples.length;
  const serverErrors = requestSamples.filter(sample => sample.status >= 500).length;
  const syncTotal = syncAccepted + syncConflicts + syncRejected;
  const durations = requestSamples.map(sample => sample.durationMs);
  return {
    startedAt: startedAt.toISOString(),
    sampleSize: requests,
    requests: {
      serverErrors,
      serverErrorRatio: requests ? serverErrors / requests : 0,
      p95DurationMs: Math.round(percentile(durations, 0.95) * 10) / 10,
      p99DurationMs: Math.round(percentile(durations, 0.99) * 10) / 10,
    },
    sync: {
      accepted: syncAccepted,
      conflicts: syncConflicts,
      rejected: syncRejected,
      conflictRatio: syncTotal ? syncConflicts / syncTotal : 0,
      rejectionRatio: syncTotal ? syncRejected / syncTotal : 0,
    },
  };
}
