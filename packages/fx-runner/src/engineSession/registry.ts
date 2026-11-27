/**
 * D#845 ON-14a (Ruling 120.2): the engine sessions that are up, as the bridge sees them. The session lifecycle fills this in memory when a start reached `done` (the repository, the signed start job's own facts and the session's channel) and clears it
 * when a stop or a delete begins; nothing is written to a settings file or a host directory. The repository id is the signed job's (`job.repo_gh_id`), never a name a person typed, and it is the only identity a session repo has here: the bridge
 * checks it against the cloud's list by id alone, and a command or an event can only ever be for it.
 */
import type { SessionChannel } from "../engineHost/channelClient.js";

export interface SessionEntry {
  /** The signed job's repository. */
  repo_gh_id: number;
  /** The signed start job's id. */
  job_id: string;
  /** The engine version the signed start job carried; undefined when the cloud had none on record (the bridge then does not start for this session). */
  engine_version: string | undefined;
  /** True when this start made a new disk (`created` or `fresh`), so the guest's files begin again and no saved cursor of the old session applies. */
  fresh: boolean;
  channel: Pick<SessionChannel, "command" | "eventsRead">;
}

export interface SessionRegistry {
  /** Adds the session, replacing the one of the same repository. */
  register(entry: SessionEntry): void;
  /** Removes the repository's session; with `jobId`, only that job's (a late clear of an older start never removes a newer one). */
  clear(repoGhId: number, jobId?: string): void;
  list(): readonly SessionEntry[];
}

export function createSessionRegistry(): SessionRegistry {
  const entries = new Map<number, SessionEntry>();
  return {
    register: (entry) => void entries.set(entry.repo_gh_id, entry),
    clear(repoGhId, jobId) {
      if (jobId === undefined || entries.get(repoGhId)?.job_id === jobId) entries.delete(repoGhId);
    },
    list: () => [...entries.values()],
  };
}
