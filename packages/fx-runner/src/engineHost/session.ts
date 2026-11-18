/**
 * EB-12c: the host's session id, kept in `engine-host-session.json` of the engine's state directory (0600, written through a temp file and a rename, read
 * without following a link). A supervisor that starts later, after a crash of the whole runner or a reboot, loads it and runs the host with `--resume <id>`,
 * so the Team Lead keeps its conversation. Anything in the file that is not a uuid, a file that is a link or open to others, and a missing file all mean "no
 * session": the host then starts a fresh one (a lost conversation, never a resumed one nobody can vouch for).
 */
import { EngineStateError, readJsonNoFollow, removeStateFile, writeJsonAtomic } from "../engineBridge/stateFiles.js";

export const SESSION_FILE = "engine-host-session.json";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface SessionStore {
  /** The saved session id, or undefined. Never throws. */
  load(): string | undefined;
  /** Saves the id (a uuid; anything else throws). May throw what a write throws. */
  save(id: string): void;
  /** Forgets the saved session; the next host starts a fresh one. */
  clear(): void;
}

export function openSessionStore(dir: string, uid: number): SessionStore {
  return {
    load() {
      try {
        const raw = readJsonNoFollow(dir, SESSION_FILE, uid) as { session_id?: unknown } | null | undefined;
        const id = raw?.session_id;
        return typeof id === "string" && UUID.test(id) ? id : undefined;
      } catch {
        // fx-swallow-ok: a session file that cannot be read safely is no session; the host starts fresh and the file is replaced by the first init line
        return undefined;
      }
    },
    save(id) {
      if (!UUID.test(id)) throw new EngineStateError("the session id is not a uuid");
      writeJsonAtomic(dir, SESSION_FILE, { session_id: id }, uid, { replaceLink: true });
    },
    clear() {
      try {
        removeStateFile(dir, SESSION_FILE);
      } catch {
        // fx-swallow-ok: a session file that cannot be removed is judged again by the next load
      }
    },
  };
}
