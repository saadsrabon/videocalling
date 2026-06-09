import { createHmac } from "node:crypto";

export interface TurnCredentialOptions {
  secret: string;
  ttlSeconds: number;
  /** Optional id embedded in username — e.g. authenticated userId. */
  userId?: string;
}

export interface TurnCredentials {
  username: string;
  credential: string;
  expiresAt: number;
}

/**
 * Coturn time-limited credentials (use-auth-secret / static-auth-secret).
 *
 * username: "<expiryUnix>:<id>"
 * credential: base64( HMAC-SHA1(secret, username) )
 */
export function generateTurnCredentials(
  options: TurnCredentialOptions,
): TurnCredentials {
  const expiresAt = Math.floor(Date.now() / 1000) + options.ttlSeconds;
  const id = options.userId ?? "turn";
  const username = `${expiresAt}:${id}`;
  const credential = createHmac("sha1", options.secret)
    .update(username)
    .digest("base64");

  return {
    username,
    credential,
    expiresAt,
  };
}
