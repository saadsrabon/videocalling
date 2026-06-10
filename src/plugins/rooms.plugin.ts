import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { config } from "../config/env.js";
import { InMemoryRoomStore } from "../rooms/room-store.js";
import { RoomService } from "../rooms/room-service.js";

declare module "fastify" {
  interface FastifyInstance {
    roomService: RoomService;
  }
}

const plugin: FastifyPluginAsync = async (app) => {
  const store = new InMemoryRoomStore();
  const roomService = new RoomService(store, config.sfuMaxPeers);

  app.decorate("roomService", roomService);
};

export const roomsPlugin = fp(plugin, {
  name: "rooms-plugin",
});
