import type { AuthAdapter } from "./auth-adapter.interface.js";
import type { AuthResult, AuthUser } from "./types.js";

/**
 * Expected external Auth Service contract (stub — replace URL when service exists):
 *
 * POST {authServiceUrl}/v1/sessions/validate
 * Request:  { "sessionId": "abc123" }
 * Response: { "userId": "user-1", "roles"?: string[], "metadata"?: object }
 * Errors:   401/404 invalid session, 410 expired session
 */
export interface SessionAuthAdapterOptions {
  authServiceUrl: string;
  /** Override for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

interface ValidateSessionResponse {
  userId?: unknown;
  roles?: unknown;
  metadata?: unknown;
}

function mapResponseToUser(data: ValidateSessionResponse): AuthUser | null {
  if (typeof data.userId !== "string" || data.userId.length === 0) {
    return null;
  }

  const roles = Array.isArray(data.roles)
    ? data.roles.filter((role): role is string => typeof role === "string")
    : undefined;

  const metadata =
    data.metadata !== null &&
    typeof data.metadata === "object" &&
    !Array.isArray(data.metadata)
      ? (data.metadata as Record<string, unknown>)
      : undefined;

  return {
    userId: data.userId,
    roles: roles && roles.length > 0 ? roles : undefined,
    metadata,
  };
}

export function createSessionAuthAdapter(
  options: SessionAuthAdapterOptions,
): AuthAdapter {
  const fetchImpl = options.fetchImpl ?? fetch;
  const validateUrl = new URL(
    "/v1/sessions/validate",
    options.authServiceUrl,
  ).toString();

  return {
    name: "session",

    async authenticate(credentials): Promise<AuthResult> {
      if (credentials.type !== "session") {
        return {
          ok: false,
          reason: "invalid_credentials",
          message: "Session adapter requires session credentials",
        };
      }

      if (!credentials.sessionId) {
        return {
          ok: false,
          reason: "missing_credentials",
          message: "Session id is missing",
        };
      }

      try {
        const response = await fetchImpl(validateUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: credentials.sessionId }),
        });

        if (response.status === 410) {
          return {
            ok: false,
            reason: "expired",
            message: "Session expired",
          };
        }

        if (!response.ok) {
          return {
            ok: false,
            reason: "invalid_credentials",
            message: "Session validation failed",
          };
        }

        const data = (await response.json()) as ValidateSessionResponse;
        const user = mapResponseToUser(data);

        if (!user) {
          return {
            ok: false,
            reason: "invalid_credentials",
            message: "Auth service returned invalid user payload",
          };
        }

        return { ok: true, user };
      } catch {
        return {
          ok: false,
          reason: "unauthorized",
          message: "Auth service unavailable",
        };
      }
    },
  };
}
