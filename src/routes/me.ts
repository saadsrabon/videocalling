import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { requireAuth } from "../plugins/auth.plugin.js";

const plugin: FastifyPluginAsync = async (app) => {
  app.get(
    "/v1/me",
    {
      preHandler: requireAuth,
    },
    async (request) => {
      return { user: request.user };
    },
  );
};

export const meRoutes = fp(plugin, {
  name: "me-routes",
});
