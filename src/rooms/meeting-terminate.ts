import type { LiveKitRoomAdmin } from "../livekit/room-service-client.js";
import type { RoomService } from "./room-service.js";
import type { SfuService } from "../sfu/sfu-service.js";
import type { ConnectionRegistry } from "../signaling/connection-registry.js";
import { SIGNALING_VERSION, sendMessage } from "../signaling/message-types.js";

export function terminateMeetingSession(deps: {
  roomId: string;
  roomService: RoomService;
  sfuService: SfuService;
  registry: ConnectionRegistry;
  liveKitRoomAdmin?: LiveKitRoomAdmin;
  reason: "expired" | "ended";
  message: string;
}): string[] {
  const connectedUserIds = deps.registry.listUserIdsInRoom(deps.roomId);

  sendMessage(
    (payload) => {
      deps.registry.broadcastToRoom(deps.roomId, payload);
    },
    {
      type: "meeting.ended",
      roomId: deps.roomId,
      reason: deps.reason,
      message: deps.message,
      v: SIGNALING_VERSION,
    },
  );

  deps.sfuService.closeRoom(deps.roomId);

  if (deps.liveKitRoomAdmin?.isConfigured) {
    void deps.liveKitRoomAdmin.deleteRoom(deps.roomId).catch(() => undefined);
  }

  deps.roomService.terminateMeeting(deps.roomId);

  for (const userId of connectedUserIds) {
    const socket = deps.registry.getSocket(userId);

    if (socket && socket.readyState === socket.OPEN) {
      socket.close(4410, deps.reason === "expired" ? "Meeting expired" : "Meeting ended");
    }
  }

  return connectedUserIds;
}
