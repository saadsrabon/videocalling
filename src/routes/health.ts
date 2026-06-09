import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";

const plugin: FastifyPluginAsync = async (app) => {
  app.get("/health", async () => {
    return {
      status: "ok",
      service: "video-sdk-service",
    };
  });
};

export const healthRoutes = fp(plugin, {
  name: "health-routes",
});
