import "dotenv/config";

export type NodeEnv = "development" | "production" | "test";

export interface AppConfig {
  port: number;
  host: string;
  nodeEnv: NodeEnv;
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

/** Loaded once at startup — import this instead of reading process.env elsewhere. */
export const config: AppConfig = {
  port: parsePort(process.env.PORT),
  host: parseHost(process.env.HOST),
  nodeEnv: parseNodeEnv(process.env.NODE_ENV),
};
