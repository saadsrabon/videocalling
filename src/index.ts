import Fastify from "fastify";
import { config } from "./config/env.js";
import { healthRoutes } from "./routes/health.js";

const app = Fastify({
  logger: true,
});

async function start() {
  try {
    await app.register(healthRoutes);
    await app.listen({ port: config.port, host: config.host });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

start();
