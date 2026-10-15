import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { configDir, type Io } from "./context.js";
import { usage } from "./errors.js";

export const DEFAULT_PROFILE = "default";
/** The production origin, once it is named. Until then `fx login` needs `--base-url`. */
export const DEFAULT_ORIGIN: string | undefined = undefined;

/** `https://host[:port]`, or `http://` only for this machine's loopback. No userinfo, path, query or fragment (the same rule as fx-runner's cloud.ts). */
export function normaliseOrigin(input: string): string {
  const bad = usage("the base URL must be an https address with no path, like https://example.com (http is allowed only for localhost)");
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    // fx-swallow-ok: the parser's own text could echo the input
    throw bad;
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  const schemeOk = url.protocol === "https:" || (url.protocol === "http:" && loopback);
  if (!schemeOk || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || url.pathname !== "/" || input.endsWith("?") || input.endsWith("#")) throw bad;
  return url.origin;
}

export function checkProfileName(name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(name)) throw usage("a profile name is 1 to 40 letters, digits, dots, dashes or underscores");
  // `constructor`, `toString`, `hasOwnProperty` and the like are real members of every object; they are never profile names.
  if (name in Object.prototype || name === "prototype") throw usage("that profile name is reserved; pick another");
  return name;
}

const file = (io: Io): string => path.join(configDir(io), "config.json");

/** Profile name to origin, from config.json. No secret lives here. */
export function readProfiles(io: Io): Map<string, string> {
  let text: string;
  try {
    text = readFileSync(file(io), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw usage("config.json cannot be read");
  }
  try {
    const raw = (JSON.parse(text) as { profiles?: Record<string, unknown> }).profiles ?? {};
    return new Map(Object.entries(raw).flatMap(([k, v]) => (typeof v === "string" ? [[k, v] as [string, string]] : [])));
  } catch {
    // fx-swallow-ok: a parse error's text could quote the file
    throw usage("config.json is not valid JSON");
  }
}

export function writeProfiles(io: Io, profiles: Map<string, string>): void {
  mkdirSync(configDir(io), { recursive: true, mode: 0o700 });
  writeFileSync(file(io), `${JSON.stringify({ profiles: Object.fromEntries(profiles) }, null, 2)}\n`, { mode: 0o600 });
}

/** `name (origin)` lines for an error that asks the person to pick a profile. */
export function describeProfiles(profiles: Map<string, string>): string {
  return profiles.size === 0 ? "there are no profiles yet: run `fx login --base-url <url>`" : `profiles: ${[...profiles].map(([n, o]) => `${n} (${o})`).join(", ")}`;
}
