/** WebRTC RTCPeerConnection iceServers entry shape. */
export interface IceServerEntry {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface IceConfig {
  iceServers: IceServerEntry[];
}

const DEFAULT_STUN_URLS = ["stun:stun.l.google.com:19302"] as const;

/** Build client-facing ICE config from parsed STUN URLs (TURN added in Phase 5). */
export function buildIceConfig(stunUrls: readonly string[]): IceConfig {
  const urls =
    stunUrls.length > 0 ? stunUrls : [...DEFAULT_STUN_URLS];

  return {
    iceServers: urls.map((url) => ({ urls: url })),
  };
}
