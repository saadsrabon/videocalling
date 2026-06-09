import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { InMemoryRoomStore } from "../rooms/room-store.js";
import { RoomService } from "../rooms/room-service.js";

declare module "fastify" {
  interface FastifyInstance {
    roomService: RoomService;
  }
}

const plugin: FastifyPluginAsync = async (app) => {
  const store = new InMemoryRoomStore();
  const roomService = new RoomService(store);

  app.decorate("roomService", roomService);
};

export const roomsPlugin = fp(plugin, {
  name: "rooms-plugin",
});
