import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { config } from "../config/env.js";
import { createMediasoupRuntime } from "../sfu/worker.js";
import { SfuService } from "../sfu/sfu-service.js";

declare module "fastify" {
  interface FastifyInstance {
    sfuService: SfuService;
  }
}

const plugin: FastifyPluginAsync = async (app) => {
  const { worker, webRtcServer } = await createMediasoupRuntime({
    announcedIp: config.mediasoupAnnouncedIp,
    listenPort: config.mediasoupPort,
  });

  const sfuService = new SfuService({
    worker,
    webRtcServer,
    maxPeersPerRoom: config.sfuMaxPeers,
  });

  app.decorate("sfuService", sfuService);

  app.addHook("onClose", async () => {
    webRtcServer.close();
    worker.close();
  });
};

export const sfuPlugin = fp(plugin, {
  name: "sfu-plugin",
});
