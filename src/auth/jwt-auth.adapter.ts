import jwt from "jsonwebtoken";
import type { AuthAdapter } from "./auth-adapter.interface.js";
import type { AuthResult, AuthUser } from "./types.js";

export interface JwtAuthAdapterOptions {
  secret: string;
}

interface JwtPayload extends jwt.JwtPayload {
  userId?: string;
  roles?: unknown;
}

function mapPayloadToUser(payload: JwtPayload): AuthUser | null {
  const userId = payload.userId ?? payload.sub;

  if (typeof userId !== "string" || userId.length === 0) {
    return null;
  }

  const roles = Array.isArray(payload.roles)
    ? payload.roles.filter((role): role is string => typeof role === "string")
    : undefined;

  const { sub, userId: _userId, roles: _roles, iat, exp, ...rest } = payload;
  const metadata =
    Object.keys(rest).length > 0
      ? (rest as Record<string, unknown>)
      : undefined;

  return {
    userId,
    roles: roles && roles.length > 0 ? roles : undefined,
    metadata,
  };
}

export function createJwtAuthAdapter(
  options: JwtAuthAdapterOptions,
): AuthAdapter {
  const { secret } = options;

  return {
    name: "jwt",

    async authenticate(credentials): Promise<AuthResult> {
      if (credentials.type !== "bearer") {
        return {
          ok: false,
          reason: "invalid_credentials",
          message: "JWT adapter requires bearer credentials",
        };
      }

      if (!credentials.token) {
        return {
          ok: false,
          reason: "missing_credentials",
          message: "Bearer token is missing",
        };
      }

      try {
        const payload = jwt.verify(credentials.token, secret, {
          algorithms: ["HS256"],
        }) as JwtPayload;

        const user = mapPayloadToUser(payload);

        if (!user) {
          return {
            ok: false,
            reason: "invalid_credentials",
            message: "Token must include userId or sub claim",
          };
        }

        return { ok: true, user };
      } catch (error) {
        if (error instanceof jwt.TokenExpiredError) {
          return {
            ok: false,
            reason: "expired",
            message: error.message,
          };
        }

        if (error instanceof jwt.JsonWebTokenError) {
          return {
            ok: false,
            reason: "invalid_credentials",
            message: error.message,
          };
        }

        throw error;
      }
    },
  };
}
