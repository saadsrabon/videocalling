import websocket from "@fastify/websocket";
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { authenticateConnection } from "../signaling/auth.js";
import { ConnectionRegistry } from "../signaling/connection-registry.js";
import { routeSignalingMessage } from "../signaling/router.js";
import { sendMessage } from "../signaling/message-types.js";

declare module "fastify" {
  interface FastifyInstance {
    signalingRegistry: ConnectionRegistry;
  }
}

const plugin: FastifyPluginAsync = async (app) => {
  const registry = new ConnectionRegistry();
  app.decorate("signalingRegistry", registry);

  await app.register(websocket);

  app.get(
    "/v1/signaling",
    { websocket: true },
    (socket, request) => {
      void (async () => {
        const query = request.query as {
          token?: string;
          sessionId?: string;
        };

        const authResult = await authenticateConnection(app.authAdapter, {
          token: query.token,
          sessionId: query.sessionId,
        });

        if (!authResult.ok) {
          socket.close(4401, authResult.message ?? "Unauthorized");
          return;
        }

        const user = authResult.user;
        registry.register(user.userId, socket);

        app.log.info({ userId: user.userId }, "Signaling connection opened");

        sendMessage((payload) => socket.send(payload), {
          type: "connected",
          userId: user.userId,
          v: 1,
        });

        const ctx = {
          user,
          roomService: app.roomService,
          registry,
          send: (payload: string) => {
            if (socket.readyState === socket.OPEN) {
              socket.send(payload);
            }
          },
        };

        socket.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
          const text = Buffer.isBuffer(raw)
            ? raw.toString()
            : Array.isArray(raw)
              ? Buffer.concat(raw).toString()
              : Buffer.from(raw).toString();
          routeSignalingMessage(ctx, text);
        });

        socket.on("close", () => {
          registry.remove(user.userId, socket);
          app.log.info({ userId: user.userId }, "Signaling connection closed");
        });

        socket.on("error", (error: Error) => {
          app.log.error(
            { userId: user.userId, error },
            "Signaling socket error",
          );
        });
      })();
    },
  );
};

export const signalingPlugin = fp(plugin, {
  name: "signaling-plugin",
  dependencies: ["auth-plugin", "rooms-plugin"],
});
