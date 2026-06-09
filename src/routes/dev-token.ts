import jwt from "jsonwebtoken";
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { config } from "../config/env.js";

/** Development-only helper — never register in production. */
const plugin: FastifyPluginAsync = async (app) => {
  app.get("/v1/dev/token", async (request) => {
    const query = request.query as { userId?: string };
    const userId = query.userId?.trim() || "user-a";

    const token = jwt.sign({ sub: userId }, config.jwtSecret, {
      expiresIn: "1h",
      algorithm: "HS256",
    });

    return { userId, token };
  });
};

export const devTokenRoutes = fp(plugin, {
  name: "dev-token-routes",
});
