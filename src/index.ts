import Fastify from "fastify";
import { createAuthAdapter } from "./auth/create-auth-adapter.js";
import { config } from "./config/env.js";
import { buildIceConfig } from "./config/ice.js";
import { authPlugin } from "./plugins/auth.plugin.js";
import { roomsPlugin } from "./plugins/rooms.plugin.js";
import { signalingPlugin } from "./plugins/signaling.plugin.js";
import { healthRoutes } from "./routes/health.js";
import { iceServerRoutes } from "./routes/ice-servers.js";
import { meRoutes } from "./routes/me.js";
import { roomRoutes } from "./routes/rooms.js";

const app = Fastify({
  logger: true,
});

async function start() {
  try {
    const authAdapter = createAuthAdapter(config);

    if (config.nodeEnv === "development") {
      app.log.info(
        { ice: buildIceConfig(config.stunUrls) },
        "ICE config loaded",
      );
    }

    await app.register(authPlugin, { adapter: authAdapter });
    await app.register(roomsPlugin);
    await app.register(healthRoutes);
    await app.register(iceServerRoutes);
    await app.register(meRoutes);
    await app.register(roomRoutes);
    await app.register(signalingPlugin);
    await app.listen({ port: config.port, host: config.host });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

start();
