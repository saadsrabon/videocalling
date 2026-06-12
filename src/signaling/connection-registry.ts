import type { WebSocket } from "ws";

interface ConnectionMeta {
  socket: WebSocket;
  userId: string;
  roomId?: string;
}

export class ConnectionRegistry {
  private readonly byUserId = new Map<string, ConnectionMeta>();

  register(userId: string, socket: WebSocket): void {
    const existing = this.byUserId.get(userId);

    if (existing && existing.socket !== socket) {
      existing.socket.close(4000, "Replaced by new connection");
    }

    this.byUserId.set(userId, { socket, userId });
  }

  bindRoom(userId: string, roomId: string): void {
    const meta = this.byUserId.get(userId);

    if (meta) {
      meta.roomId = roomId;
    }
  }

  getRoomId(userId: string): string | undefined {
    return this.byUserId.get(userId)?.roomId;
  }

  getSocket(userId: string): WebSocket | undefined {
    return this.byUserId.get(userId)?.socket;
  }

  listUserIdsInRoom(roomId: string): string[] {
    const userIds: string[] = [];

    for (const [userId, meta] of this.byUserId) {
      if (meta.roomId === roomId) {
        userIds.push(userId);
      }
    }

    return userIds;
  }

  broadcastToRoom(roomId: string, payload: string): number {
    let sent = 0;

    for (const userId of this.listUserIdsInRoom(roomId)) {
      if (this.sendToUser(userId, payload)) {
        sent += 1;
      }
    }

    return sent;
  }

  remove(userId: string, socket: WebSocket): void {
    const meta = this.byUserId.get(userId);

    if (meta?.socket === socket) {
      this.byUserId.delete(userId);
    }
  }

  sendToUser(userId: string, payload: string): boolean {
    const socket = this.getSocket(userId);

    if (!socket || socket.readyState !== socket.OPEN) {
      return false;
    }

    socket.send(payload);
    return true;
  }
}
