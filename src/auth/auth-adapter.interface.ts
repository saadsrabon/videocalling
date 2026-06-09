import type { AuthCredentials, AuthResult } from "./types.js";

/**
 * Pluggable auth boundary. Implementations: JWT, session, external auth API.
 * Bootstrap picks one adapter — routes never branch on auth mechanism.
 */
export interface AuthAdapter {
  readonly name: string;
  authenticate(credentials: AuthCredentials): Promise<AuthResult>;
}
