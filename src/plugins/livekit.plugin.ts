import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { config } from "../config/env.js";
import { LiveKitRoomAdmin } from "../livekit/room-service-client.js";
import { LiveKitTokenService } from "../livekit/token-service.js";

declare module "fastify" {
  interface FastifyInstance {
    liveKitTokenService: LiveKitTokenService;
    liveKitRoomAdmin: LiveKitRoomAdmin;
  }
}

const plugin: FastifyPluginAsync = async (app) => {
  const liveKitTokenService = new LiveKitTokenService(config);
  const liveKitRoomAdmin = new LiveKitRoomAdmin(config);

  app.decorate("liveKitTokenService", liveKitTokenService);
  app.decorate("liveKitRoomAdmin", liveKitRoomAdmin);

  if (config.livekitEnabled) {
    if (!liveKitTokenService.isConfigured) {
      app.log.warn(
        "LIVEKIT_ENABLED=true but LIVEKIT_API_KEY, LIVEKIT_API_SECRET, or LIVEKIT_URL missing",
      );
    } else {
      app.log.info(
        { livekitUrl: config.livekitUrl, mediaBackend: config.mediaBackend },
        "LiveKit token service enabled",
      );
    }
  }
};

export const livekitPlugin = fp(plugin, {
  name: "livekit-plugin",
});
