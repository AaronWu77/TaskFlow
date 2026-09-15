export type AuthSessionContext = Readonly<{
  generation: number;
  userId: string;
  accessToken: string | null;
}>;

export interface AuthSessionManager {
  readonly generation: number;
  current(): AuthSessionContext | null;
  prepare(userId: string): AuthSessionContext | null;
  activate(userId: string, accessToken: string | null): AuthSessionContext;
  clear(): void;
  isCurrent(captured: AuthSessionContext | null): boolean;
  updateToken(captured: AuthSessionContext | null, accessToken: string): boolean;
  track(captured: AuthSessionContext | null, controller: AbortController): () => void;
}

export function createAuthSessionManager(): AuthSessionManager;
