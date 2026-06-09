import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { buildIceConfig } from "../config/ice.js";
import { config } from "../config/env.js";
import { requireAuth } from "../plugins/auth.plugin.js";

const plugin: FastifyPluginAsync = async (app) => {
  app.get(
    "/v1/ice-servers",
    {
      preHandler: requireAuth,
    },
    async () => {
      return buildIceConfig(config.stunUrls);
    },
  );
};

export const iceServerRoutes = fp(plugin, {
  name: "ice-server-routes",
});
