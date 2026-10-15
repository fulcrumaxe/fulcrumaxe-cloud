import type { Parsed } from "../args.js";
import type { Io } from "../context.js";
import { clearCredentials, emptyCredentials, getCredential, readCredentials, writeCredentials } from "../credentials.js";
import { usage } from "../errors.js";
import { developerTokensLink } from "../links.js";
import type { Output } from "../output.js";
import { checkProfileName, DEFAULT_PROFILE, describeProfiles, readProfiles } from "../profiles.js";
import { resolveSession } from "../session.js";
import { call } from "../transport.js";

/** `fx whoami`: asks the API every time and caches nothing. The token is shown by its last 4 characters only. */
export async function whoami(io: Io, out: Output, args: Parsed): Promise<void> {
  const session = resolveSession(io, args.profile);
  const account = await call(io, out, session, "getAccount");
  out.say(`profile: ${session.profile}\norigin: ${session.origin}\nplan: ${account.plan}\nstatus: ${account.status}\ntoken: ...${session.token.slice(-4)}`);
  out.success(account);
}

const STILL_WORKS = (origin: string): string => `Signed out on this machine. The token still works until it expires or is revoked: ${developerTokensLink(origin)}`;

/** `fx logout [--profile p] [--all]`: local only. It removes the saved token; it cannot revoke it. */
export function logout(io: Io, out: Output, args: Parsed): void {
  if (io.platform === "win32") throw usage("there is no stored login on Windows: unset FX_TOKEN instead");
  const profiles = readProfiles(io);
  if (args.all) {
    const origins = [...new Set(Object.values(readCredentialsOrEmpty(io)).map((c) => c.origin))];
    clearCredentials(io);
    for (const origin of origins.length > 0 ? origins : [undefined]) out.say(origin === undefined ? "Signed out on this machine. Nothing was stored." : STILL_WORKS(origin));
    out.success({ all: true, origins });
    return;
  }
  const profile = checkProfileName(args.profile ?? (io.env["FX_PROFILE"] || DEFAULT_PROFILE));
  const creds = readCredentials(io);
  const saved = getCredential(creds, profile);
  if (saved === undefined) {
    if (!profiles.has(profile) && args.profile !== undefined) throw usage(`unknown profile "${profile}"; ${describeProfiles(profiles)}`);
    out.say(`Profile "${profile}" has no saved token.`);
    out.success({ profile, removed: false });
    return;
  }
  delete creds[profile];
  writeCredentials(io, creds);
  out.say(STILL_WORKS(saved.origin));
  out.success({ profile, origin: saved.origin, removed: true });
}

function readCredentialsOrEmpty(io: Io): ReturnType<typeof readCredentials> {
  try {
    return readCredentials(io);
  } catch {
    // fx-swallow-ok: --all exists to clear a file that fails its safety checks, so there is nothing to list
    return emptyCredentials();
  }
}

/** `fx profiles`: names and origins from config.json. No secret is read. */
export function profiles(io: Io, out: Output): void {
  const list = readProfiles(io);
  out.say(describeProfiles(list).replace(/^profiles: /, "").split(", ").join("\n"));
  out.success({ profiles: [...list].map(([name, origin]) => ({ name, origin })) });
}
