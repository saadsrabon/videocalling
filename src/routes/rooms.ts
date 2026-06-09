import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { requireAuth } from "../plugins/auth.plugin.js";
import { RoomError } from "../rooms/types.js";

const plugin: FastifyPluginAsync = async (app) => {
  app.post(
    "/v1/rooms",
    {
      preHandler: requireAuth,
    },
    async () => {
      return app.roomService.create();
    },
  );

  app.post(
    "/v1/rooms/:roomId/join",
    {
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const { roomId } = request.params as { roomId: string };

      try {
        return app.roomService.join(roomId, request.user.userId);
      } catch (error) {
        if (error instanceof RoomError && error.code === "room_not_found") {
          return reply.code(404).send({
            error: error.code,
            message: error.message,
          });
        }

        throw error;
      }
    },
  );
};

export const roomRoutes = fp(plugin, {
  name: "room-routes",
});
