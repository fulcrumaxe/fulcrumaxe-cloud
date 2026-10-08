import type { AuthMode } from "./authStatus.js";

const EXPECTED_KEY_SOURCE: Readonly<Record<AuthMode, string>> = { subscription: "none", api_key: "ANTHROPIC_API_KEY" };

/**
 * The second layer behind the sign-in check and the clean environment: the init line says where the binary found its
 * credential, and that must be the source this mode allows. A missing or non-string value is a mismatch.
 * It cannot undo a request already sent; it stops the run before any model output is processed.
 */
export function initCredentialMatches(mode: AuthMode, init: Record<string, unknown>): boolean {
  return init.apiKeySource === EXPECTED_KEY_SOURCE[mode];
}

export function isInitLine(message: Record<string, unknown>): boolean {
  return message.type === "system" && message.subtype === "init";
}
