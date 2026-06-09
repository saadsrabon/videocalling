import type { AuthAdapter } from "../auth/auth-adapter.interface.js";
import type { AuthResult } from "../auth/types.js";

export interface SignalingAuthQuery {
  token?: string;
  sessionId?: string;
}

export async function authenticateConnection(
  adapter: AuthAdapter,
  query: SignalingAuthQuery,
): Promise<AuthResult> {
  if (query.token) {
    return adapter.authenticate({ type: "bearer", token: query.token });
  }

  if (query.sessionId) {
    return adapter.authenticate({
      type: "session",
      sessionId: query.sessionId,
    });
  }

  return {
    ok: false,
    reason: "missing_credentials",
    message: "Token or sessionId query parameter is required",
  };
}
