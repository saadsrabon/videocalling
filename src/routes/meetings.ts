import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { config } from "../config/env.js";
import { requireAuth } from "../plugins/auth.plugin.js";
import { notifyHostOfWaitingRequest } from "../signaling/handlers/lobby.js";
import { RoomError, type JoinStatus } from "../rooms/types.js";
import type { RoomService } from "../rooms/room-service.js";
import type { ConnectionRegistry } from "../signaling/connection-registry.js";

function notifyHostIfWaiting(
  app: { roomService: RoomService; signalingRegistry: ConnectionRegistry },
  roomId: string,
  userId: string,
  status: JoinStatus,
): void {
  if (status !== "waiting") {
    return;
  }

  notifyHostOfWaitingRequest(
    { roomService: app.roomService, registry: app.signalingRegistry },
    roomId,
    userId,
  );
}

const guestTokenAttempts = new Map<string, { count: number; resetAt: number }>();
const GUEST_RATE_LIMIT = 20;
const GUEST_RATE_WINDOW_MS = 60_000;

function checkGuestRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = guestTokenAttempts.get(ip);

  if (!entry || entry.resetAt < now) {
    guestTokenAttempts.set(ip, { count: 1, resetAt: now + GUEST_RATE_WINDOW_MS });
    return true;
  }

  if (entry.count >= GUEST_RATE_LIMIT) {
    return false;
  }

  entry.count += 1;
  return true;
}

const MAX_MEETING_DURATION_MINUTES = 480;

function parseDurationMinutes(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const minutes = typeof value === "number" ? value : Number(value);

  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MEETING_DURATION_MINUTES) {
    throw new RoomError(
      "invalid_duration",
      `durationMinutes must be an integer from 1 to ${MAX_MEETING_DURATION_MINUTES}`,
    );
  }

  return minutes;
}

function isSuperAdmin(user: { metadata?: Record<string, unknown> }): boolean {
  return user.metadata?.adminRole === "SUPER_ADMIN";
}

function enrichJoinResponse<T extends Record<string, unknown>>(payload: T) {
  return {
    ...payload,
    mediaBackend: config.mediaBackend,
    ...(config.livekitEnabled && config.livekitUrl
      ? { livekitUrl: config.livekitUrl }
      : {}),
  };
}

const plugin: FastifyPluginAsync = async (app) => {
  app.get(
    "/v1/meetings",
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!isSuperAdmin(request.user)) {
        return reply.code(403).send({
          error: "forbidden",
          message: "Only SUPER_ADMIN can list active meetings",
        });
      }

      return {
        meetings: app.roomService.listActiveMeetings(),
        maxParticipants: config.sfuMaxPeers,
      };
    },
  );

  app.post(
    "/v1/meetings",
    { preHandler: requireAuth },
    async (request, reply) => {
      const body = (request.body ?? {}) as {
        title?: string;
        durationMinutes?: unknown;
      };

      let durationMinutes: number | undefined;

      try {
        durationMinutes = parseDurationMinutes(body.durationMinutes);
      } catch (error) {
        if (error instanceof RoomError && error.code === "invalid_duration") {
          return reply.code(400).send({
            error: error.code,
            message: error.message,
          });
        }

        throw error;
      }

      const meeting = app.roomService.createMeeting(
        request.user.userId,
        body.title?.trim() || undefined,
        durationMinutes,
      );

      return {
        ...meeting,
        joinUrl: `${config.meetingBaseUrl}/${meeting.code}`,
        maxParticipants: config.sfuMaxPeers,
      };
    },
  );

  app.get(
    "/v1/meetings/:code/roster",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { code } = request.params as { code: string };

      try {
        const meeting = app.roomService.getMeetingByCode(code);

        if (!app.roomService.isHost(meeting.roomId, request.user.userId)) {
          return reply.code(403).send({
            error: "not_host",
            message: "Only the meeting host can view the roster",
          });
        }

        return {
          roomId: meeting.roomId,
          code: meeting.code,
          hostUserId: meeting.hostUserId,
          admitted: app.roomService.getParticipantRoster(meeting.roomId),
          waiting: app.roomService.getWaitingRoster(meeting.roomId),
        };
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

  app.get("/v1/meetings/:code", async (request, reply) => {
    const { code } = request.params as { code: string };

    try {
      return app.roomService.getMeetingByCode(code);
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
    "/v1/meetings/:code/join",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { code } = request.params as { code: string };
      const body = (request.body ?? {}) as {
        displayName?: string;
        ghost?: boolean;
      };

      if (body.ghost && !isSuperAdmin(request.user)) {
        return reply.code(403).send({
          error: "forbidden",
          message: "Ghost mode requires SUPER_ADMIN",
        });
      }

      const displayName =
        body.displayName?.trim() ||
        (typeof request.user.metadata?.name === "string"
          ? request.user.metadata.name
          : undefined) ||
        (typeof request.user.metadata?.email === "string"
          ? request.user.metadata.email.split("@")[0]
          : undefined);

      try {
        const result = app.roomService.joinMeetingByCode(
          code,
          request.user.userId,
          body.ghost ? displayName ?? "Observer" : displayName,
          { ghost: body.ghost === true },
        );
        notifyHostIfWaiting(
          app,
          result.roomId,
          request.user.userId,
          result.status,
        );
        return enrichJoinResponse(result);
      } catch (error) {
        if (error instanceof RoomError) {
          const status =
            error.code === "room_full"
              ? 409
              : error.code === "meeting_expired"
                ? 410
                : 404;
          return reply.code(status).send({
            error: error.code,
            message: error.message,
          });
        }

        throw error;
      }
    },
  );

  app.post("/v1/meetings/:code/guest-token", async (request, reply) => {
    const ip = request.ip;
    if (!checkGuestRateLimit(ip)) {
      return reply.code(429).send({
        error: "rate_limited",
        message: "Too many guest token requests",
      });
    }

    const { code } = request.params as { code: string };
    const body = (request.body ?? {}) as { name?: string };
    const name = body.name?.trim();

    if (!name || name.length < 1 || name.length > 64) {
      return reply.code(400).send({
        error: "invalid_name",
        message: "Name is required (1-64 characters)",
      });
    }

    try {
      const meeting = app.roomService.getMeetingByCode(code);

      if (meeting.participantCount >= meeting.maxParticipants) {
        return reply.code(409).send({
          error: "room_full",
          message: "Meeting is full",
        });
      }

      const guestId = `guest-${randomUUID()}`;
      const token = jwt.sign(
        {
          sub: guestId,
          name,
          role: "guest",
          roomId: meeting.roomId,
        },
        config.jwtSecret,
        {
          algorithm: "HS256",
          expiresIn: config.guestJwtTtlSeconds,
        },
      );

      return {
        token,
        userId: guestId,
        roomId: meeting.roomId,
        code: meeting.code,
        expiresIn: config.guestJwtTtlSeconds,
      };
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

  app.post("/v1/meetings/:code/guest-join", async (request, reply) => {
    const { code } = request.params as { code: string };
    const body = (request.body ?? {}) as {
      name?: string;
      token?: string;
      displayName?: string;
    };

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
      const displayName =
        body.displayName?.trim() ||
        (typeof authResult.user.metadata?.name === "string"
          ? authResult.user.metadata.name
          : undefined) ||
        (typeof authResult.user.metadata?.email === "string"
          ? authResult.user.metadata.email.split("@")[0]
          : undefined);

      const result = app.roomService.joinMeetingByCode(
        code,
        authResult.user.userId,
        displayName,
      );
      notifyHostIfWaiting(
        app,
        result.roomId,
        authResult.user.userId,
        result.status,
      );
      return enrichJoinResponse(result);
    } catch (error) {
      if (error instanceof RoomError) {
        const status =
          error.code === "room_full"
            ? 409
            : error.code === "meeting_expired"
              ? 410
              : 404;
        return reply.code(status).send({
          error: error.code,
          message: error.message,
        });
      }

      throw error;
    }
  });
};

export const meetingRoutes = fp(plugin, {
  name: "meeting-routes",
  dependencies: ["rooms-plugin", "signaling-plugin"],
});
