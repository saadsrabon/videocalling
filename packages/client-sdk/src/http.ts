/** Strip whitespace/newlines and optional "Bearer " prefix from pasted tokens. */
export function normalizeToken(token: string): string {
  return token.trim().replace(/^Bearer\s+/i, "").replace(/\s+/g, "");
}

/** Validate and normalize API base URL (origin only). */
export function normalizeServerUrl(serverUrl: string): string {
  const trimmed = serverUrl.trim();

  if (!trimmed) {
    throw new Error("Server URL is required");
  }

  let parsed: URL;

  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(
      "Invalid server URL — use http://127.0.0.1:3004 (include http://)",
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Server URL must use http:// or https://");
  }

  return parsed.origin;
}

export function authHeaders(token: string): HeadersInit {
  const normalized = normalizeToken(token);

  if (!normalized) {
    throw new Error("JWT token is required");
  }

  return {
    Authorization: `Bearer ${normalized}`,
  };
}

/** POST with JSON content-type — Fastify requires a body when this header is set. */
export function jsonPostInit(token: string): { headers: HeadersInit; body: string } {
  return {
    headers: {
      ...authHeaders(token),
      "Content-Type": "application/json",
    },
    body: "{}",
  };
}
