import { configDir, type Io } from "./context.js";
import { checkDir, getCredential, readCredentials } from "./credentials.js";
import { CliExit, EXIT, notSignedIn, usage } from "./errors.js";
import { checkProfileName, DEFAULT_ORIGIN, DEFAULT_PROFILE, describeProfiles, normaliseOrigin, readProfiles } from "./profiles.js";

export const TOKEN_RE = /^fxat_[0-9A-Za-z]{49}$/;

export interface Session {
  profile: string;
  origin: string;
  token: string;
}

/**
 * The origin config.json names for a profile, for use when `FX_TOKEN` has no `FX_BASE_URL`. That file decides where a bearer token goes, so its
 * directory gets the same owner/mode checks as the credential file (exit 3 on failure). Windows has no usable mode bits: there it is ignored.
 */
function configuredOrigin(io: Io, profiles: Map<string, string>, profile: string): string | undefined {
  const origin = profiles.get(profile);
  if (origin === undefined || io.platform === "win32") return undefined;
  checkDir(configDir(io), io.uid);
  return origin;
}

/**
 * Which token goes to which origin. `FX_TOKEN` beats the stored login. A stored token is used only against the origin it was saved for: if the
 * profile's origin was edited since, nothing is sent (exit 3).
 */
export function resolveSession(io: Io, profileFlag: string | undefined): Session {
  const explicit = profileFlag ?? (io.env["FX_PROFILE"] || undefined);
  const profile = checkProfileName(explicit ?? DEFAULT_PROFILE);
  const profiles = readProfiles(io);
  const fromEnv = io.env["FX_TOKEN"];
  if (fromEnv !== undefined && fromEnv !== "") {
    if (!TOKEN_RE.test(fromEnv)) throw new CliExit(EXIT.auth, "malformed_token", "FX_TOKEN is not a fulcrumaxe token (it starts with fxat_ and has 49 letters or digits after that)");
    const base = io.env["FX_BASE_URL"];
    const origin = base !== undefined && base !== "" ? normaliseOrigin(base) : (configuredOrigin(io, profiles, profile) ?? DEFAULT_ORIGIN);
    if (origin === undefined) throw usage("set FX_BASE_URL (or log in once with `fx login --base-url <url>`) so the CLI knows where to send FX_TOKEN");
    return { profile, origin, token: fromEnv };
  }
  if (io.platform === "win32") throw usage("a stored login is not supported on Windows: set FX_TOKEN and FX_BASE_URL");
  const stored = getCredential(readCredentials(io), profile);
  const configured = profiles.get(profile);
  if (stored === undefined && configured === undefined && explicit !== undefined) throw usage(`unknown profile "${profile}"; ${describeProfiles(profiles)}`);
  if (stored === undefined) throw notSignedIn();
  if (configured !== undefined && configured !== stored.origin) {
    throw new CliExit(EXIT.auth, "origin_changed", `profile "${profile}" now points at a different origin than its saved token was made for, so nothing was sent: log in again with \`fx login --profile ${profile}\``);
  }
  return { profile, origin: normaliseOrigin(stored.origin), token: stored.token };
}
