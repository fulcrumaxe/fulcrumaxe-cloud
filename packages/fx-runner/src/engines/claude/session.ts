import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SESSION_ID_PATTERN } from "@fulcrumaxe/runner-protocol";

/** What the runner remembers of a finished session: where its workspace was. Ids and paths only, never transcript text. */
export type SessionIndex = Record<string, { workspace: string }>;

export function readSessionIndex(file: string): SessionIndex {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const index: SessionIndex = {};
    for (const [id, entry] of Object.entries(parsed)) {
      const workspace = (entry as { workspace?: unknown } | null)?.workspace;
      if (SESSION_ID_PATTERN.test(id) && typeof workspace === "string" && path.isAbsolute(workspace)) index[id] = { workspace };
    }
    return index;
  } catch {
    // fx-swallow-ok: a missing or damaged index only means no session can be resumed; the run starts fresh
    return {};
  }
}

const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 15_000;

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs `work` while holding `<file>.lock`, created exclusively. A lock older than LOCK_STALE_MS belongs to a process that died and is taken over. */
async function withFileLock<T>(file: string, work: () => T): Promise<T> {
  const lock = `${file}.lock`;
  const giveUpAt = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx", 0o600));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { force: true });
      } catch {
        // fx-swallow-ok: the lock was released between the check and the stat; the next attempt takes it
      }
      if (Date.now() > giveUpAt) throw new Error("session index lock timed out");
      await pause(5 + Math.floor(Math.random() * 15));
    }
  }
  try {
    return work();
  } finally {
    rmSync(lock, { force: true });
  }
}

/**
 * Records one finished session, replacing the file in one rename (0600). A bad id is not recorded. Writers are
 * serialised by a lock file, so two runs ending together (in this process or two) each keep their entry; the temp
 * name is unique per write.
 */
export async function recordSession(file: string, sessionId: string, workspace: string): Promise<void> {
  if (!SESSION_ID_PATTERN.test(sessionId) || !path.isAbsolute(workspace)) return;
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  await withFileLock(file, () => {
    const index = readSessionIndex(file);
    index[sessionId] = { workspace };
    const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(temp, `${JSON.stringify(index)}\n`, { mode: 0o600 });
    renameSync(temp, file);
  });
}

export type SessionPlan = { kind: "resume"; sessionId: string; workspace: string } | { kind: "fresh"; branch: string | null };

/**
 * Resume only when this machine's own index holds the id AND that workspace still exists; then the job runs in that
 * workspace. Anything else is a fresh session in a new workspace on `continues.branch`.
 */
export function planSession(continues: { session_id: string; branch: string } | null, index: SessionIndex, dirExists: (dir: string) => boolean = existsSync): SessionPlan {
  if (continues === null) return { kind: "fresh", branch: null };
  const known = Object.hasOwn(index, continues.session_id) ? index[continues.session_id] : undefined;
  if (known !== undefined && dirExists(known.workspace)) return { kind: "resume", sessionId: continues.session_id, workspace: known.workspace };
  return { kind: "fresh", branch: continues.branch };
}
