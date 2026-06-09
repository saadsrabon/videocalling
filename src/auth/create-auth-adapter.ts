import type { AppConfig } from "../config/env.js";
import type { AuthAdapter } from "./auth-adapter.interface.js";
import { createJwtAuthAdapter } from "./jwt-auth.adapter.js";
import { createSessionAuthAdapter } from "./session-auth.adapter.js";

/** Pick auth adapter from config — swap via AUTH_MODE without changing routes. */
export function createAuthAdapter(appConfig: AppConfig): AuthAdapter {
  if (appConfig.authMode === "session") {
    return createSessionAuthAdapter({
      authServiceUrl: appConfig.authServiceUrl,
    });
  }

  return createJwtAuthAdapter({
    secret: appConfig.jwtSecret,
  });
}
