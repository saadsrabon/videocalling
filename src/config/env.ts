import "dotenv/config";

export type NodeEnv = "development" | "production" | "test";

export type AuthMode = "jwt" | "session";

export interface AppConfig {
  port: number;
  host: string;
  nodeEnv: NodeEnv;
  authMode: AuthMode;
  jwtSecret: string;
  authServiceUrl: string;
  sessionCookieName: string;
  stunUrls: string[];
  turnUrls: string[];
  turnSecret: string | null;
  turnCredentialTtlSeconds: number;
  useHttps: boolean;
  sslKeyPath: string;
  sslCertPath: string;
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value === "") {
    return 3000;
  }

  const port = Number(value);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `Invalid PORT: "${value}". Must be an integer between 1 and 65535.`,
    );
  }

  return port;
}

function parseHost(value: string | undefined): string {
  if (value === undefined || value === "") {
    return "0.0.0.0";
  }

  return value;
}

function parseNodeEnv(value: string | undefined): NodeEnv {
  if (value === undefined || value === "") {
    return "development";
  }

  if (value === "development" || value === "production" || value === "test") {
    return value;
  }

  throw new Error(
    `Invalid NODE_ENV: "${value}". Must be development, production, or test.`,
  );
}

function parseJwtSecret(
  value: string | undefined,
  nodeEnv: NodeEnv,
): string {
  if (value === undefined || value === "") {
    if (nodeEnv === "production") {
      throw new Error("JWT_SECRET is required in production");
    }

    return "dev-jwt-secret-change-me";
  }

  if (value.length < 16) {
    throw new Error("JWT_SECRET must be at least 16 characters");
  }

  return value;
}

function parseAuthMode(value: string | undefined): AuthMode {
  if (value === undefined || value === "") {
    return "jwt";
  }

  if (value === "jwt" || value === "session") {
    return value;
  }

  throw new Error(`Invalid AUTH_MODE: "${value}". Must be jwt or session.`);
}

function parseAuthServiceUrl(
  value: string | undefined,
  authMode: AuthMode,
): string {
  if (value === undefined || value === "") {
    if (authMode === "session") {
      throw new Error("AUTH_SERVICE_URL is required when AUTH_MODE=session");
    }

    return "http://127.0.0.1:4000";
  }

  return value.replace(/\/$/, "");
}

function parseSessionCookieName(value: string | undefined): string {
  if (value === undefined || value === "") {
    return "sessionId";
  }

  return value;
}

function parseStunUrls(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") {
    return [];
  }

  const urls = value
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url.length > 0);

  for (const url of urls) {
    if (!url.startsWith("stun:") && !url.startsWith("stuns:")) {
      throw new Error(
        `Invalid STUN URL: "${url}". Must start with stun: or stuns:`,
      );
    }
  }

  return urls;
}

function parseTurnUrls(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") {
    return [];
  }

  const urls = value
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url.length > 0);

  for (const url of urls) {
    if (
      !url.startsWith("turn:") &&
      !url.startsWith("turns:") &&
      !url.startsWith("turn://") &&
      !url.startsWith("turns://")
    ) {
      throw new Error(
        `Invalid TURN URL: "${url}". Must start with turn: or turns:`,
      );
    }
  }

  return urls;
}

function parseTurnSecret(
  value: string | undefined,
  turnUrls: string[],
): string | null {
  if (turnUrls.length === 0) {
    return null;
  }

  if (value === undefined || value.trim() === "") {
    throw new Error("TURN_SECRET is required when TURN_URL is set");
  }

  if (value.length < 16) {
    throw new Error("TURN_SECRET must be at least 16 characters");
  }

  return value;
}

function parseTurnCredentialTtlSeconds(value: string | undefined): number {
  if (value === undefined || value.trim() === "") {
    return 3600;
  }

  const ttl = Number(value);

  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 86400) {
    throw new Error(
      "TURN_CREDENTIAL_TTL_SECONDS must be an integer between 60 and 86400",
    );
  }

  return ttl;
}

function parseBoolean(value: string | undefined): boolean {
  return value === "true" || value === "1";
}

function parsePath(value: string | undefined, fallback: string): string {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  return value.trim();
}

/** Loaded once at startup — import this instead of reading process.env elsewhere. */
const nodeEnv = parseNodeEnv(process.env.NODE_ENV);
const authMode = parseAuthMode(process.env.AUTH_MODE);
const turnUrls = parseTurnUrls(process.env.TURN_URL);

export const config: AppConfig = {
  port: parsePort(process.env.PORT),
  host: parseHost(process.env.HOST),
  nodeEnv,
  authMode,
  jwtSecret: parseJwtSecret(process.env.JWT_SECRET, nodeEnv),
  authServiceUrl: parseAuthServiceUrl(process.env.AUTH_SERVICE_URL, authMode),
  sessionCookieName: parseSessionCookieName(process.env.SESSION_COOKIE_NAME),
  stunUrls: parseStunUrls(process.env.STUN_URLS),
  turnUrls,
  turnSecret: parseTurnSecret(process.env.TURN_SECRET, turnUrls),
  turnCredentialTtlSeconds: parseTurnCredentialTtlSeconds(
    process.env.TURN_CREDENTIAL_TTL_SECONDS,
  ),
  useHttps: parseBoolean(process.env.USE_HTTPS),
  sslKeyPath: parsePath(process.env.SSL_KEY_PATH, "certs/dev-key.pem"),
  sslCertPath: parsePath(process.env.SSL_CERT_PATH, "certs/dev-cert.pem"),
};
