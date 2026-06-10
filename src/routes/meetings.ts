import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { config } from "../config/env.js";
import { requireAuth } from "../plugins/auth.plugin.js";
import { RoomError } from "../rooms/types.js";

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

const plugin: FastifyPluginAsync = async (app) => {
  app.post(
    "/v1/meetings",
    { preHandler: requireAuth },
    async (request) => {
      const body = (request.body ?? {}) as { title?: string };
      const meeting = app.roomService.createMeeting(
        request.user.userId,
        body.title?.trim() || undefined,
      );

      return {
        ...meeting,
        joinUrl: `${config.meetingBaseUrl}/${meeting.code}`,
        maxParticipants: config.sfuMaxPeers,
      };
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
      const displayName =
        typeof request.user.metadata?.name === "string"
          ? request.user.metadata.name
          : undefined;

      try {
        return app.roomService.joinMeetingByCode(
          code,
          request.user.userId,
          displayName,
        );
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
    const body = (request.body ?? {}) as { name?: string; token?: string };

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
      return app.roomService.joinMeetingByCode(
        code,
        authResult.user.userId,
        typeof authResult.user.metadata?.name === "string"
          ? authResult.user.metadata.name
          : undefined,
      );
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
  dependencies: ["rooms-plugin"],
});
