import type { IceConfig, IceServerEntry } from "./ice.js";
import { buildIceConfig } from "./ice.js";
import type { AppConfig } from "./env.js";
import { generateTurnCredentials } from "../turn/credentials.js";

export function buildClientIceConfig(
  appConfig: AppConfig,
  userId?: string,
): IceConfig {
  if (appConfig.turnUrls.length === 0 || !appConfig.turnSecret) {
    return buildIceConfig(appConfig.stunUrls);
  }

  const turnCreds = generateTurnCredentials({
    secret: appConfig.turnSecret,
    ttlSeconds: appConfig.turnCredentialTtlSeconds,
    userId,
  });

  const stunServers = buildIceConfig(appConfig.stunUrls).iceServers;
  const turnServers: IceServerEntry[] = appConfig.turnUrls.map((url) => ({
    urls: url,
    username: turnCreds.username,
    credential: turnCreds.credential,
  }));

  return {
    iceServers: [...stunServers, ...turnServers],
  };
}
