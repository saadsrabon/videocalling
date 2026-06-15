import { AccessToken } from "livekit-server-sdk";
import type { AppConfig } from "../config/env.js";
import type {
  LiveKitTokenRequest,
  LiveKitTokenResponse,
} from "./types.js";

function buildVideoGrant(req: LiveKitTokenRequest) {
  const isHost = req.role === "host";
  const admitted = req.admitted && req.role !== "waiting";

  return {
    room: req.roomName,
    roomJoin: true,
    roomAdmin: isHost,
    canPublish: admitted && !req.ghost,
    canSubscribe: admitted || req.role === "waiting",
    canPublishData: admitted || req.role === "waiting",
    canUpdateOwnMetadata: true,
  };
}

export class LiveKitTokenService {
  constructor(private readonly config: Pick<
    AppConfig,
    "livekitApiKey" | "livekitApiSecret" | "livekitUrl" | "livekitTokenTtlSeconds"
  >) {}

  get isConfigured(): boolean {
    return Boolean(
      this.config.livekitApiKey &&
        this.config.livekitApiSecret &&
        this.config.livekitUrl,
    );
  }

  async createToken(req: LiveKitTokenRequest): Promise<LiveKitTokenResponse> {
    if (!this.isConfigured) {
      throw new Error("LiveKit is not configured");
    }

    const at = new AccessToken(
      this.config.livekitApiKey,
      this.config.livekitApiSecret,
      {
        identity: req.identity,
        name: req.name,
        ttl: this.config.livekitTokenTtlSeconds,
        metadata: req.metadata,
      },
    );

    at.addGrant(buildVideoGrant(req));

    return {
      serverUrl: this.config.livekitUrl,
      participantToken: await at.toJwt(),
    };
  }
}
