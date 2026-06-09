import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { buildClientIceConfig } from "../config/ice-service.js";
import { config } from "../config/env.js";
import { requireAuth } from "../plugins/auth.plugin.js";

const plugin: FastifyPluginAsync = async (app) => {
  app.get(
    "/v1/ice-servers",
    {
      preHandler: requireAuth,
    },
    async (request) => {
      return buildClientIceConfig(config, request.user.userId);
    },
  );
};

export const iceServerRoutes = fp(plugin, {
  name: "ice-server-routes",
});
