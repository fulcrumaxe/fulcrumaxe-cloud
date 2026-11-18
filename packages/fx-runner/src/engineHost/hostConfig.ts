/**
 * EB-12c: the host's inputs that come from outside the supervisor, each read the same careful way.
 *  - `readCheckins` (the engine config's `cloud_bridge.ticks[]`): `<repo checkout>/.autonomous-team/config.json`, opened without following a link, a plain file
 *    of this user that no one else can write, at most 256 KiB. Anything unreadable or malformed is "no check-ins" (the loop tick still runs); an entry that is
 *    not `{name: row key, every_min: 5..1440}` is left out here and nowhere else.
 *  - `tickSettingsFor` (the runner's loop minutes and start-of-day time, set with `config set`) join the two for the ticker.
 *  - `credentialModeOf`: how the host is paid for, from the `apiKeySource` of its own `init` line.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { ROW_KEY_PATTERN } from "@fulcrumaxe/runner-protocol";
import { loadSettings } from "../runnerSettings.js";
import { LOOP_MIN_BOUNDS, type CredentialMode, type TickSettings } from "./ticks.js";

const CONFIG_MAX_BYTES = 256 * 1024;
export const MAX_CHECKINS = 50;

/** The engine config's check-in ticks, valid entries only, at most `MAX_CHECKINS`, one per name. */
export function readCheckins(checkout: string, uid: number): Array<{ name: string; every_min: number }> {
  try {
    const dir = path.join(checkout, ".autonomous-team");
    const dirStat = lstatSync(dir, { throwIfNoEntry: false });
    if (dirStat === undefined || dirStat.isSymbolicLink() || !dirStat.isDirectory()) return [];
    const file = path.join(dir, "config.json");
    const st = lstatSync(file, { throwIfNoEntry: false });
    if (st === undefined || st.isSymbolicLink() || !st.isFile()) return [];
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    let text: string;
    try {
      const open = fstatSync(fd);
      if (!open.isFile() || open.uid !== uid || (open.mode & 0o022) !== 0 || open.size > CONFIG_MAX_BYTES) return [];
      const buf = Buffer.alloc(open.size);
      readSync(fd, buf, 0, open.size, 0);
      text = buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
    const ticks = (JSON.parse(text) as { cloud_bridge?: { ticks?: unknown } } | null)?.cloud_bridge?.ticks;
    if (!Array.isArray(ticks)) return [];
    const seen = new Set<string>();
    const out: Array<{ name: string; every_min: number }> = [];
    for (const t of ticks as Array<{ name?: unknown; every_min?: unknown }>) {
      if (out.length >= MAX_CHECKINS) break;
      if (typeof t?.name !== "string" || !ROW_KEY_PATTERN.test(t.name) || seen.has(t.name)) continue;
      if (typeof t.every_min !== "number" || !Number.isInteger(t.every_min) || t.every_min < LOOP_MIN_BOUNDS.min || t.every_min > 1440) continue;
      seen.add(t.name);
      out.push({ name: t.name, every_min: t.every_min });
    }
    return out;
  } catch {
    // fx-swallow-ok: a config that cannot be read safely means no check-in ticks; nothing of the file or its path is reported
    return [];
  }
}

/** What the ticker asks for: the runner's own settings (read again each time, so a change applies at the next poll) and the engine config's check-ins. */
export function tickSettingsFor(runnerStateDir: string, checkout: string, uid: number): TickSettings {
  const host = loadSettings(runnerStateDir).engineHost;
  // The check-ins are read only when asked for (the ticker asks once, when it starts), not at every poll.
  return { loopMin: host?.loopMin, startDayAt: host?.startDayAt, get checkins() { return readCheckins(checkout, uid); } };
}

/**
 * How the host is paid for, from where its own `init` line says it found its credential (`apiKeySource`), the way `engines/claude/credentialCheck.ts` reads it:
 * `none` is a login (subscription); any other source is a key. A line that has not come yet, or has no such field, is never reported as a subscription.
 */
export function credentialModeOf(keySource: string | undefined): CredentialMode {
  return keySource === "none" ? "subscription" : "api_key";
}
