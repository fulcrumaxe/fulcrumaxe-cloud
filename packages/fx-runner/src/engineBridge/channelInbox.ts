/**
 * D#845 ON-14a: the command inbox of an engine session. The puller judges a command exactly as for a host engine (signature, runner, repo, operate, expiry, sequence); this inbox then forwards the SIGNED command, byte for byte, into the guest
 * through the session's channel (`channel.command`: the guest checks it again against the key pinned for this cloud), and reads the outcomes back through `events_read` `outcomes`. Nothing is written to the host's disk for a command, except the
 * small state that keeps one from being applied twice (the same file the host inbox keeps, in a directory of this runner's own) and the offset of the outcomes already acked.
 * An outcome stays owed until its ack is settled, so a crash before the cloud took the ack reads it again; the offset moves only past outcomes settled from the start of the stream.
 */
import { lstatSync, mkdirSync } from "node:fs";
import path from "node:path";
import { EngineCommandAck, type EngineCommand } from "@fulcrumaxe/runner-protocol";
import type { SessionChannel } from "../engineHost/channelClient.js";
import { loadCursor, saveTextAtomic } from "./cursor.js";
import { Inbox, InboxRefused, type CommandInbox, type Consumed, type Waiting } from "./inbox.js";

const NAME = /^[1-9][0-9]{0,15}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const OFFSET_FILE = "outcomes-offset.json";

export interface ChannelInboxOptions {
  channel: Pick<SessionChannel, "command" | "eventsRead">;
  /** This session's own directory under the runner's state directory (made here, 0700). */
  dir: string;
  uid: number | undefined;
  now: () => number;
  /** Gets fixed text only. */
  log: (line: string) => void;
}

export function createChannelInbox(options: ChannelInboxOptions): CommandInbox {
  const { channel, dir, uid } = options;
  /** The replay state and the offset are written inside `dir`, so `dir` and `sessions` above it are looked at (never followed) every time they are used: a link, a non-directory, a directory of someone else's or one open to group or others refuses, as the host inbox's `ensure()` does. */
  const ensureDirs = (): void => {
    for (const d of [path.dirname(dir), dir]) {
      const st = lstatSync(d, { throwIfNoEntry: false });
      if (st === undefined) continue;
      if (st.isSymbolicLink()) throw new InboxRefused("link");
      if (!st.isDirectory()) throw new InboxRefused("not_directory");
      if (uid !== undefined && st.uid !== uid) throw new InboxRefused("foreign_owner");
      if ((st.mode & 0o077) !== 0) throw new InboxRefused("open_permissions");
    }
  };
  // what exists is judged BEFORE anything is made through it, then the missing parts are made (0700), then all are judged again
  ensureDirs();
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    // fx-swallow-ok: a directory that cannot be made is one fixed refusal
    throw new InboxRefused("unreadable");
  }
  ensureDirs();
  const inner = new Inbox(dir, uid);
  const state = {
    loadState: (nowMs: number) => (ensureDirs(), inner.loadState(nowMs)),
    saveState: (s: Parameters<Inbox["saveState"]>[0]) => (ensureDirs(), inner.saveState(s)),
  };
  const offsetFile = path.join(dir, OFFSET_FILE);
  // the saved offset is read the way the bridge's cursor is (0600, no link, our own): `offset` is the only field that matters
  let committed = loadCursor(offsetFile, undefined, uid)?.offset ?? 0;
  const settled = new Set<string>();
  const written = new Map<string, Waiting>();
  let down = false;
  const fail = (): void => {
    if (!down) options.log("engine-inbox: an engine session's channel could not be read; trying again later");
    down = true;
  };
  return {
    loadState: (nowMs) => state.loadState(nowMs),
    saveState: (s) => state.saveState(s),
    async write(command: EngineCommand, signed: unknown): Promise<string> {
      const name = `${command.command_seq}-${command.command_id.toLowerCase()}`;
      if ((await channel.command(signed)) !== name) throw new Error("engine-inbox: the guest named another command");
      written.set(name, { name, commandId: command.command_id.toLowerCase(), expiresMs: Date.parse(command.expires_at), mtimeMs: options.now() });
      return name;
    },
    waiting: () => [...written.values()],
    async consumed(): Promise<Consumed[]> {
      let read: Awaited<ReturnType<typeof channel.eventsRead>>;
      try {
        read = await channel.eventsRead(committed, "outcomes");
        down = false;
      } catch {
        // fx-swallow-ok: the failure's text could name the guest's paths; the outcomes are read again on the next look
        fail();
        return [];
      }
      if (read.reset) committed = 0;
      const out: Consumed[] = [];
      let prefix = true;
      let advanced = committed;
      let replayState: ReturnType<typeof state.loadState> | undefined;
      const replay = (): ReturnType<typeof state.loadState> => (replayState ??= state.loadState(options.now()));
      read.lines.forEach((line, i) => {
        let name: string | undefined;
        let ack: ReturnType<typeof EngineCommandAck.safeParse> | undefined;
        try {
          const body = JSON.parse(line) as { name?: unknown; ack?: unknown } | null;
          name = typeof body?.name === "string" && NAME.test(body.name) ? body.name : undefined;
          ack = EngineCommandAck.safeParse(body?.ack);
        } catch {
          // fx-swallow-ok: a line that is not JSON is no outcome; it is passed over
        }
        if (name === undefined || ack?.success !== true) {
          if (prefix) advanced = read.ends[i]!;
          return;
        }
        if (settled.has(name)) {
          if (prefix) advanced = read.ends[i]!;
          return;
        }
        // an outcome is relayed only for a command this runner forwarded (in this run, or in an earlier one: the replay state holds its id): the guest cannot make the runner ack a name nobody sent
        if (!written.has(name) && !Object.hasOwn(replay().seen, name.slice(name.indexOf("-") + 1))) {
          if (prefix) advanced = read.ends[i]!;
          return;
        }
        prefix = false;
        written.delete(name);
        out.push({ name, commandId: name.slice(name.indexOf("-") + 1), ack: ack.data });
      });
      if (advanced !== committed) {
        committed = advanced;
        try {
          ensureDirs();
          saveTextAtomic(offsetFile, `${JSON.stringify({ engine_instance_id: null, inode: 1, offset: committed, last_sent_seq: null, last_acked_seq: null })}\n`, undefined, uid);
        } catch {
          // fx-swallow-ok: an offset that cannot be saved is read from the last saved one after a restart, and the cloud answers 409 to an ack it already holds
          options.log("engine-inbox: the outcomes offset could not be saved");
        }
      }
      return out;
    },
    settle(name) {
      settled.add(name);
      written.delete(name);
    },
  };
}
