import { readFileSync } from "node:fs";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { createAuthAdapter } from "./auth/create-auth-adapter.js";
import { config } from "./config/env.js";
import { buildClientIceConfig } from "./config/ice-service.js";
import { authPlugin } from "./plugins/auth.plugin.js";
import { roomsPlugin } from "./plugins/rooms.plugin.js";
import { sfuPlugin } from "./plugins/sfu.plugin.js";
import { livekitPlugin } from "./plugins/livekit.plugin.js";
import { signalingPlugin } from "./plugins/signaling.plugin.js";
import { devTokenRoutes } from "./routes/dev-token.js";
import { healthRoutes } from "./routes/health.js";
import { iceServerRoutes } from "./routes/ice-servers.js";
import { meetingRoutes } from "./routes/meetings.js";
import { livekitRoutes } from "./routes/livekit.js";
import { meRoutes } from "./routes/me.js";
import { roomRoutes } from "./routes/rooms.js";

const app = Fastify({
  logger: true,
  ...(config.useHttps
    ? {
        https: {
          key: readFileSync(config.sslKeyPath),
          cert: readFileSync(config.sslCertPath),
        },
      }
    : {}),
});

async function start() {
  try {
    const authAdapter = createAuthAdapter(config);

    await app.register(cors, { origin: true });

    if (config.nodeEnv === "development") {
      await app.register(devTokenRoutes);
      app.log.info(
        {
          ice: buildClientIceConfig(config),
          turnEnabled: config.turnUrls.length > 0,
          mediasoupAnnouncedIp: config.mediasoupAnnouncedIp,
          mediasoupPort: config.mediasoupPort,
        },
        "ICE + SFU config loaded",
      );
    }

    if (config.useHttps) {
      app.log.info("HTTPS enabled for API");
    }

    await app.register(authPlugin, { adapter: authAdapter });
    await app.register(roomsPlugin);
    await app.register(livekitPlugin);
    await app.register(sfuPlugin);
    await app.register(healthRoutes);
    await app.register(iceServerRoutes);
    await app.register(meRoutes);
    await app.register(roomRoutes);
    await app.register(signalingPlugin);
    await app.register(meetingRoutes);
    await app.register(livekitRoutes);
    await app.listen({ port: config.port, host: config.host });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

start();
