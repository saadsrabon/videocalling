import { RoomServiceClient } from "livekit-server-sdk";
import type { AppConfig } from "../config/env.js";

/** Server-side LiveKit Room API (admit, remove, list participants). */
export class LiveKitRoomAdmin {
  private readonly client: RoomServiceClient | null;

  constructor(
    config: Pick<
      AppConfig,
      "livekitApiKey" | "livekitApiSecret" | "livekitInternalUrl"
    >,
  ) {
    if (
      config.livekitApiKey &&
      config.livekitApiSecret &&
      config.livekitInternalUrl
    ) {
      this.client = new RoomServiceClient(
        config.livekitInternalUrl,
        config.livekitApiKey,
        config.livekitApiSecret,
      );
    } else {
      this.client = null;
    }
  }

  get isConfigured(): boolean {
    return this.client !== null;
  }

  async updateParticipantPermissions(
    roomName: string,
    identity: string,
    canPublish: boolean,
  ): Promise<void> {
    if (!this.client) {
      return;
    }

    await this.client.updateParticipant(roomName, identity, undefined, {
      canPublish,
      canSubscribe: true,
      canPublishData: true,
    });
  }

  async removeParticipant(roomName: string, identity: string): Promise<void> {
    if (!this.client) {
      return;
    }

    await this.client.removeParticipant(roomName, identity);
  }

  async deleteRoom(roomName: string): Promise<void> {
    if (!this.client) {
      return;
    }

    await this.client.deleteRoom(roomName);
  }
}
