import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { config } from "../config/env.js";
import { requireAuth } from "../plugins/auth.plugin.js";
import { RoomError } from "../rooms/types.js";
import type { LiveKitParticipantRole } from "../livekit/types.js";

interface StandardTokenBody {
  room_name?: string;
  participant_identity?: string;
  participant_name?: string;
  participant_metadata?: string;
}

function livekitUnavailable(reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
  return reply.code(503).send({
    error: "livekit_unavailable",
    message: "LiveKit is not enabled or configured on this server",
  });
}

function resolveRole(
  isHost: boolean,
  isGuest: boolean,
  status: "admitted" | "waiting",
): LiveKitParticipantRole {
  if (status === "waiting") {
    return "waiting";
  }

  if (isHost) {
    return "host";
  }

  if (isGuest) {
    return "guest";
  }

  return "participant";
}

const plugin: FastifyPluginAsync = async (app) => {
  app.get("/v1/livekit/config", async (_request, reply) => {
    if (!config.livekitEnabled || !app.liveKitTokenService.isConfigured) {
      return livekitUnavailable(reply);
    }

    return {
      mediaBackend: config.mediaBackend,
      serverUrl: config.livekitUrl,
    };
  });

  /** LiveKit-standard token endpoint (used by TokenSource.endpoint). */
  app.post(
    "/v1/livekit/token",
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!config.livekitEnabled || !app.liveKitTokenService.isConfigured) {
        return livekitUnavailable(reply);
      }

      const body = (request.body ?? {}) as StandardTokenBody;
      const roomName = body.room_name?.trim();
      const identity = body.participant_identity?.trim() || request.user.userId;

      if (!roomName) {
        return reply.code(400).send({
          error: "missing_room",
          message: "room_name is required",
        });
      }

      if (identity !== request.user.userId) {
        return reply.code(403).send({
          error: "forbidden",
          message: "participant_identity must match authenticated user",
        });
      }

      const token = await app.liveKitTokenService.createToken({
        roomName,
        identity,
        name: body.participant_name?.trim(),
        metadata: body.participant_metadata,
        role: "participant",
        admitted: true,
      });

      return reply.code(201).send({
        server_url: token.serverUrl,
        participant_token: token.participantToken,
      });
    },
  );

  app.post(
    "/v1/meetings/:code/livekit-token",
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!config.livekitEnabled || !app.liveKitTokenService.isConfigured) {
        return livekitUnavailable(reply);
      }

      const { code } = request.params as { code: string };
      const body = (request.body ?? {}) as { displayName?: string };

      try {
        const meeting = app.roomService.getMeetingByCode(code);
        const userId = request.user.userId;
        const isHost = app.roomService.isHost(meeting.roomId, userId);
        const isAdmitted = app.roomService.isParticipant(meeting.roomId, userId);
        const isWaiting = app.roomService.isWaiting(meeting.roomId, userId);

        if (!isAdmitted && !isWaiting) {
          return reply.code(403).send({
            error: "not_joined",
            message: "Join the meeting before requesting a LiveKit token",
          });
        }

        const status = isAdmitted ? "admitted" : "waiting";
        const displayName =
          body.displayName?.trim() ||
          app.roomService.getDisplayName(meeting.roomId, userId) ||
          userId;

        const isGuest = userId.startsWith("guest-");
        const isGhost = app.roomService.isGhostParticipant(
          meeting.roomId,
          userId,
        );

        const token = await app.liveKitTokenService.createToken({
          roomName: meeting.roomId,
          identity: userId,
          name: displayName,
          role: resolveRole(isHost, isGuest, status),
          admitted: status === "admitted",
          metadata: JSON.stringify({
            code: meeting.code,
            ghost: isGhost,
            status,
          }),
        });

        return reply.code(201).send({
          server_url: token.serverUrl,
          participant_token: token.participantToken,
          roomId: meeting.roomId,
          code: meeting.code,
          status,
        });
      } catch (error) {
        if (error instanceof RoomError) {
          const status = error.code === "meeting_expired" ? 410 : 404;
          return reply.code(status).send({
            error: error.code,
            message: error.message,
          });
        }

        throw error;
      }
    },
  );

  app.post("/v1/meetings/:code/guest-livekit-token", async (request, reply) => {
    if (!config.livekitEnabled || !app.liveKitTokenService.isConfigured) {
      return livekitUnavailable(reply);
    }

    const { code } = request.params as { code: string };
    const body = (request.body ?? {}) as { token?: string };

    if (!body.token) {
      return reply.code(400).send({
        error: "missing_token",
        message: "Guest token is required",
      });
    }

    const authResult = await app.authAdapter.authenticate({
      type: "bearer",
      token: body.token,
    });

    if (!authResult.ok) {
      return reply.code(401).send({
        error: "invalid_token",
        message: authResult.message ?? "Invalid guest token",
      });
    }

    try {
      const meeting = app.roomService.getMeetingByCode(code);
      const userId = authResult.user.userId;

      if (meeting.roomId !== authResult.user.metadata?.roomId) {
        return reply.code(403).send({
          error: "forbidden",
          message: "Guest token is not valid for this meeting",
        });
      }

      const isAdmitted = app.roomService.isParticipant(meeting.roomId, userId);
      const isWaiting = app.roomService.isWaiting(meeting.roomId, userId);

      if (!isAdmitted && !isWaiting) {
        return reply.code(403).send({
          error: "not_joined",
          message: "Join the meeting before requesting a LiveKit token",
        });
      }

      const status = isAdmitted ? "admitted" : "waiting";
      const displayName =
        app.roomService.getDisplayName(meeting.roomId, userId) ||
        (typeof authResult.user.metadata?.name === "string"
          ? authResult.user.metadata.name
          : userId);

      const lkToken = await app.liveKitTokenService.createToken({
        roomName: meeting.roomId,
        identity: userId,
        name: displayName,
        role: resolveRole(false, true, status),
        admitted: status === "admitted",
        metadata: JSON.stringify({ code: meeting.code, status, guest: true }),
      });

      return reply.code(201).send({
        server_url: lkToken.serverUrl,
        participant_token: lkToken.participantToken,
        roomId: meeting.roomId,
        code: meeting.code,
        status,
      });
    } catch (error) {
      if (error instanceof RoomError) {
        const status = error.code === "meeting_expired" ? 410 : 404;
        return reply.code(status).send({
          error: error.code,
          message: error.message,
        });
      }

      throw error;
    }
  });
  app.post(
    "/v1/rooms/:roomId/livekit-token",
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!config.livekitEnabled || !app.liveKitTokenService.isConfigured) {
        return livekitUnavailable(reply);
      }

      const { roomId } = request.params as { roomId: string };

      try {
        app.roomService.join(roomId, request.user.userId);
      } catch (error) {
        if (error instanceof RoomError && error.code === "room_not_found") {
          return reply.code(404).send({
            error: error.code,
            message: error.message,
          });
        }

        if (!(error instanceof RoomError && error.code === "already_joined")) {
          throw error;
        }
      }

      const token = await app.liveKitTokenService.createToken({
        roomName: roomId,
        identity: request.user.userId,
        name:
          (typeof request.user.metadata?.name === "string"
            ? request.user.metadata.name
            : undefined) ?? request.user.userId,
        role: "participant",
        admitted: true,
      });

      return reply.code(201).send({
        server_url: token.serverUrl,
        participant_token: token.participantToken,
      });
    },
  );
};

export const livekitRoutes = fp(plugin, {
  name: "livekit-routes",
  dependencies: ["livekit-plugin", "rooms-plugin"],
});
