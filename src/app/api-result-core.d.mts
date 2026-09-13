export type RefreshFailureKind = 'unauthorized' | 'incompatible' | 'rate-limited' | 'service-unavailable';
export type TransportFailureKind = 'timeout' | 'transport' | 'offline';
export type RefreshConnectionIssue = 'offline' | 'network' | 'timeout' | 'serviceUnavailable' | 'incompatible' | 'rateLimited' | null;
export function refreshHttpFailureKind(status: number): RefreshFailureKind;
export function transportFailureKind(error: unknown, online: boolean): TransportFailureKind;
export function refreshConnectionIssue(kind: 'ok' | RefreshFailureKind | TransportFailureKind): RefreshConnectionIssue;
