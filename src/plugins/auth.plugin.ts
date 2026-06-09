import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { AuthAdapter } from "../auth/auth-adapter.interface.js";
import type { AuthCredentials, AuthUser } from "../auth/types.js";
import { config } from "../config/env.js";

declare module "fastify" {
  interface FastifyInstance {
    authAdapter: AuthAdapter;
  }

  interface FastifyRequest {
    user: AuthUser;
  }
}

export interface AuthPluginOptions {
  adapter: AuthAdapter;
}

function parseBearerToken(
  authorization: string | undefined,
): string | undefined {
  if (!authorization) {
    return undefined;
  }

  const [scheme, token] = authorization.split(" ");

  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return undefined;
  }

  return token;
}

function parseCookieValue(
  cookieHeader: string | undefined,
  name: string,
): string | undefined {
  if (!cookieHeader) {
    return undefined;
  }

  const match = cookieHeader.match(
    new RegExp(`(?:^|;\\s*)${name}=([^;]+)`),
  );

  if (!match?.[1]) {
    return undefined;
  }

  return decodeURIComponent(match[1]);
}

function buildCredentials(request: FastifyRequest): AuthCredentials {
  const token = parseBearerToken(request.headers.authorization);
  const sessionId = parseCookieValue(
    request.headers.cookie,
    config.sessionCookieName,
  );

  if (token) {
    return { type: "bearer", token };
  }

  if (sessionId) {
    return { type: "session", sessionId };
  }

  return { type: "bearer" };
}

/** Opt-in preHandler — attach to any route that requires authentication. */
export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const result = await request.server.authAdapter.authenticate(
    buildCredentials(request),
  );

  if (!result.ok) {
    await reply.code(401).send({
      error: result.reason,
      message: result.message ?? "Unauthorized",
    });
    return;
  }

  request.user = result.user;
}

const plugin: FastifyPluginAsync<AuthPluginOptions> = async (app, options) => {
  app.decorate("authAdapter", options.adapter);
};

export const authPlugin = fp(plugin, {
  name: "auth-plugin",
});
