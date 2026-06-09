/** Authenticated identity returned by any auth adapter. */
export interface AuthUser {
  userId: string;
  roles?: string[];
  metadata?: Record<string, unknown>;
}

/** How credentials are presented — adapters pick what they support. */
export type AuthCredentialType = "bearer" | "session";

/**
 * Raw credentials extracted from HTTP (or WS). Routes/plugins build this;
 * adapters never read headers directly.
 */
export interface AuthCredentials {
  type: AuthCredentialType;
  /** JWT value without the "Bearer " prefix. */
  token?: string;
  /** Session id or cookie value for session-based auth. */
  sessionId?: string;
}

export type AuthFailureReason =
  | "missing_credentials"
  | "invalid_credentials"
  | "expired"
  | "unauthorized";

export interface AuthSuccess {
  ok: true;
  user: AuthUser;
}

export interface AuthFailure {
  ok: false;
  reason: AuthFailureReason;
  message?: string;
}

/** Discriminated union — check `ok` before accessing `user`. */
export type AuthResult = AuthSuccess | AuthFailure;
