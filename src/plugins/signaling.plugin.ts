import websocket from "@fastify/websocket";
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { config } from "../config/env.js";
import { authenticateConnection } from "../signaling/auth.js";
import { ConnectionRegistry } from "../signaling/connection-registry.js";
import { routeSignalingMessage } from "../signaling/router.js";
import { sendMessage } from "../signaling/message-types.js";
import { broadcastSfuEvent } from "../signaling/handlers/sfu.js";
import type { SignalingContext } from "../signaling/handlers/join.js";
import { handlePeerDisconnect } from "../signaling/handlers/join.js";
import { startMeetingExpiryWatcher } from "../rooms/meeting-expiry.js";

declare module "fastify" {
  interface FastifyInstance {
    signalingRegistry: ConnectionRegistry;
  }
}

const plugin: FastifyPluginAsync = async (app) => {
  const registry = new ConnectionRegistry();
  app.decorate("signalingRegistry", registry);

  app.sfuService.on((event) => {
    const ctx: SignalingContext = {
      user: { userId: "" },
      roomService: app.roomService,
      registry,
      sfuService: app.sfuService,
      send: () => {
        /* broadcast only */
      },
    };
    broadcastSfuEvent(ctx, event.roomId, event);
  });

  const stopMeetingExpiryWatcher = startMeetingExpiryWatcher({
    roomService: app.roomService,
    sfuService: app.sfuService,
    registry,
    log: app.log,
  });

  app.addHook("onClose", async () => {
    stopMeetingExpiryWatcher();
  });

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

        const ctx: SignalingContext = {
          user,
          roomService: app.roomService,
          registry,
          sfuService: app.sfuService,
          liveKitRoomAdmin: app.liveKitRoomAdmin,
          useLiveKit:
            config.livekitEnabled &&
            (config.mediaBackend === "livekit" ||
              config.mediaBackend === "both"),
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
          handlePeerDisconnect(
            {
              roomService: app.roomService,
              registry,
              sfuService: app.sfuService,
            },
            user.userId,
          );
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
  dependencies: ["auth-plugin", "rooms-plugin", "sfu-plugin", "livekit-plugin"],
});
