/**
 * `fx-sandboxd` core (D#587 B-2b-iii-a): named sandboxes (create, get, stop, resume, delete, list) and detached commands. Everything privileged goes
 * to fx-vmhelper through `Helper`; the daemon itself must run as an ordinary user, and refuses to be built as root.
 *
 * Name and id are one string: the helper's id pattern is the only name rule, so a sandbox is found again from the helper's own `list`.
 * `stop` ends the commands and destroys the VM (the helper has no stop verb); the record stays, so the name stays taken and `get(name, {resume})`
 * boots it again fresh. Keeping the disk across a stop is B-3 (snapshots), and so is keeping the record across a daemon restart.
 *
 * `list()` reads only this process's registry, never the helper, so a `prepare` that is still launching cannot hold it up.
 */
import path from "node:path";
import { CliError } from "../../cliError.js";
import { assertBootable, type BootDigests, type TargetListing } from "../bootGate.js";
import type { Arch } from "../lock.js";
import { SandboxdCommand, type CommandSpec } from "./command.js";
import { HelperError, SANDBOX_ID, type Helper, type PreparedReply } from "./helperClient.js";
import type { Connect, GuestAgent } from "./guestAgent.js";
import { STREAM_ID, type GuestStream } from "./streamCommand.js";
import { FileError, MAX_FILE_BYTES, checkGuestPath, guestFileMode, type FileContent } from "./files.js";
import { DEFAULT_KEEP_LAST, DEFAULT_SNAPSHOT_TTL_SECONDS, MAX_KEEP_LAST, MIB, admitSnapshot, loadStore, newSnapshotId, saveStore, snapshotNeedBytes, type SnapshotDeps, type SnapshotMeta } from "./snapshots.js";

/** A connection to a guest vsock port, as `viaFirecrackerVsock` hands it out. */
type Duplex = Awaited<ReturnType<Connect>>;

/** What a stop needs of a running command, whichever way it runs (a one-shot exec, or a stream). */
interface TrackedCommand { kill(signal: "SIGKILL"): Promise<void>; wait(): Promise<unknown>; abort?(): void }
/** One command on the streaming exec; `withToken` and `user` are as in `CommandSpec`. */
export interface StreamSpec { id: string; cmd: string; args?: string[]; cwd?: string; env?: Record<string, string>; stdin?: Buffer; timeoutS?: number; withToken?: boolean; user?: "root" | "ubuntu" }
/** The most stream ids one VM's agent is given in its run. */
const MAX_STREAM_IDS = 4096;

export type SandboxState ="creating" | "running" | "stopping" | "stopped";
/** `retention` is the port's: a persistent sandbox is snapshotted by `stop` and restored by `get(name, {resume})`; the default is not persistent. */
export interface CreateParams { name: string; template: string; vcpus: number; memMb: number; retention?: { persistent: boolean; keepLastSnapshots?: number } }
/** One file to write; `size` is required (and exact) when `content` is not a Buffer. */
export interface WriteFile { path: string; mode?: number; size?: number; content: FileContent }
export interface InventoryRow { name: string; state: SandboxState; createdAt: number }

/** `status` is the HTTP status the overlay's contract names (a taken name is 400 `bad_request`); `code` is fixed text. */
export class SandboxdError extends Error {
  /** `detail` is numbers only (a snapshot refusal names the two it compared); it never carries a path or anything the helper sent. */
  constructor(readonly status: number, readonly code: "bad_request" | "not_found" | "conflict" | "not_running" | "vsock_dir_refused" | "agent_not_ready" | "helper_failed" | "snapshot_refused" | "snapshot_mismatch" | "token_wipe_failed", readonly detail?: string) {
    super(detail === undefined ? `fx-sandboxd: ${code}` : `fx-sandboxd: ${code}: ${detail}`);
    this.name = "SandboxdError";
  }
}

/** What an fstat of an O_PATH|O_NOFOLLOW fd of the vsock directory showed; the daemon reads it through this so it makes no file-system call itself. */
export interface DirFacts { isDirectory: boolean; isSymbolicLink: boolean; uid: number; gid: number; mode: number }

export interface SandboxdDeps {
  /** `process.geteuid()`; undefined where there is none. */
  euid: number | undefined;
  helper: Helper;
  boot: { listTargets(): Promise<TargetListing>; facts(template: string): { arch: Arch; digests: BootDigests } | Promise<{ arch: Arch; digests: BootDigests }> };
  /** What an O_PATH|O_NOFOLLOW fd of the directory the helper named shows (a symlink is reported as one); undefined when it is not there. */
  inspectDir(dir: string): DirFacts | undefined;
  /** True when the directory holds a `v.sock_<port>` entry the runner does not own (or one that cannot be examined): the sandbox is then not started. */
  hasForeignListener(vsockDir: string): boolean;
  agentFor(vsockDir: string): GuestAgent;
  /** D#845 ON-13b2: connects to a guest vsock port (the engine session's channel) through the directory's checked descriptors; the handshake is done and nothing past it is read. Absent: no channel. */
  dial?(vsockDir: string, port: number): Promise<Duplex>;
  /** Removes the runner's own `v.sock` left in a stopped sandbox's vsock directory (see `removeOwnVsockSocket`); throws when it is not the runner's. */
  removeVsockSocket(vsockDir: string): void;
  /** Absent: no sandbox may be persistent. */
  snapshots?: SnapshotDeps;
  now(): number;
  bootTimeoutMs?: number;
  pollMs?: number;
  /** How long `stop` waits for commands that are still starting before it destroys the VM anyway (default 30 s). */
  startWaitMs?: number;
}

export function assertNotRoot(euid: number | undefined): void {
  if (typeof euid !== "number" || !Number.isInteger(euid) || euid <= 0) throw new CliError("refusing to start: fx-sandboxd must run as the runner user, not as root");
}

/** 01770: owner the runner, group the sandbox's gid, sticky (decision Correction 8; it supersedes the earlier 0710). */
const VSOCK_DIR_MODE = 0o1770;

/** The helper's own rules for the path it names, checked again here (ruling 1 of the vsock contract). `normalize` equal to the input also rules out `..`, `.` and doubled slashes. Returns the path when it holds. */
export function checkVsockDir(dir: string, id: string, gid: number, runnerUid: number, facts: DirFacts | undefined): string {
  const lexical = path.posix.isAbsolute(dir) && !dir.includes("\0") && path.posix.normalize(dir) === dir && !dir.endsWith("/") && path.posix.basename(dir) === id;
  if (!lexical || facts === undefined || !facts.isDirectory || facts.isSymbolicLink || facts.uid !== runnerUid || facts.gid !== gid || (facts.mode & 0o7777) !== VSOCK_DIR_MODE) throw new SandboxdError(502, "vsock_dir_refused");
  return dir;
}

interface Record_ {
  name: string;
  state: SandboxState;
  createdAt: number;
  params: CreateParams;
  /** Oldest first. Only a persistent sandbox has any. */
  snapshots: SnapshotMeta[];
  agent?: GuestAgent;
  /** The checked vsock directory of the running VM (set with `agent`). */
  vsockDir?: string;
  commands: Set<TrackedCommand>;
  /** Every stream id given to this VM's agent (the agent keeps an id for its whole run, so one is never reused); cleared when the VM is destroyed. */
  streamIds?: Set<string>;
  starting: Set<Promise<unknown>>;
  stopping?: Promise<void>;
  /** The resume in flight: a second `get(name, { resume })` shares it instead of starting another. */
  resuming?: Promise<void>;
  /** The boot in flight (create or resume), so a teardown can wait for it instead of racing it. */
  bringing?: Promise<void>;
  /** A token was pushed to this VM and not yet wiped: set before the first byte is sent, so a delivery that fails half way is still wiped. */
  tokenHeld?: boolean;
  /** Token deliveries in flight: a snapshot stop waits for them (bounded) before it wipes. */
  delivering?: Set<Promise<void>>;
  /** A stop has begun: no new delivery is taken. */
  stopRequested?: boolean;
  /** Snapshot ids whose write the helper had not answered when the client gave up. They stay in `writing` until a destroy of this VM returns (the helper holds the sandbox for the whole write, so the write is then over); a destroy releases them, and the sweep and `delete` then remove the files. */
  timedOut?: Set<string>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Waits for `work` or `ms`, whichever is first, and clears the timer either way so none is left pending. */
async function within(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([work, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

export class Sandbox {
  constructor(private readonly daemon: Sandboxd, readonly name: string) {}
  get status(): SandboxState { return this.daemon.stateOf(this.name); }
  runCommand(spec: CommandSpec & { signal?: AbortSignal }): Promise<SandboxdCommand> { return this.daemon.runCommand(this.name, spec); }
  writeFiles(files: WriteFile[]): Promise<void> { return this.daemon.writeFiles(this.name, files); }
  /** Takes ownership of `token`: it is zeroed once sent. */
  deliverToken(token: Buffer): Promise<void> { return this.daemon.deliverToken(this.name, token); }
  /** Removes the token and kills every holder; resolves only when the guest confirms none is left (`token_wipe_failed` otherwise). */
  wipeToken(): Promise<void> { return this.daemon.wipeToken(this.name); }
  readFile(path: string, sink: (chunk: Buffer) => void | Promise<void>): Promise<number> { return this.daemon.readFile(this.name, path, sink); }
  /** D#845 ON-13b2: a connection to a guest vsock port, through the checked vsock directory. */
  connect(port: number): Promise<Duplex> { return this.daemon.connect(this.name, port); }
  stop(): Promise<void> { return this.daemon.stop(this.name); }
  delete(): Promise<void> { return this.daemon.delete(this.name); }
  /** A command on the guest's streaming exec: output as it arrives, a `kill` by id, the exit status once every frame is read. The sandbox's stop ends it. */
  runStream(spec: StreamSpec): Promise<GuestStream> { return this.daemon.runStream(this.name, spec); }
}

export class Sandboxd {
  private readonly records = new Map<string, Record_>();
  /** Every id the helper may hold a VM for, added before `prepare` is asked: the teardown's list. */
  readonly registered = new Set<string>();

  /** Snapshots whose `snapshot_delete` the helper has not confirmed: they still use disk, so they still count against the quota. */
  private orphans: SnapshotMeta[] = [];
  /** Bytes admitted for snapshots that are not yet on the helper's side (set in the same step as the admission), by snapshot id. They count against the quota. */
  private readonly reserved = new Map<string, number>();
  /** Ids of snapshots being written right now: they are on `orphans` (so a crash leaves a trace) but the retry of unconfirmed deletes must not touch them. */
  private readonly writing = new Set<string>();

  /** Sandboxes with snapshots come back from the state file as stopped records; a malformed file stops the daemon rather than forgetting snapshots it holds. */
  constructor(private readonly deps: SandboxdDeps) {
    assertNotRoot(deps.euid);
    if (deps.snapshots === undefined) return;
    const stored = loadStore(deps.snapshots.stateDir, deps.euid as number);
    this.orphans = stored.orphans;
    for (const s of stored.sandboxes) {
      const params: CreateParams = { name: s.name, template: s.template, vcpus: s.vcpus, memMb: s.memMb, retention: { persistent: true, keepLastSnapshots: s.keepLast } };
      this.records.set(s.name, { name: s.name, state: "stopped", createdAt: s.createdAt, params, snapshots: s.snapshots, commands: new Set(), starting: new Set() });
      this.registered.add(s.name); // the helper may still hold it prepared; the teardown asks it to let go
    }
  }

  private persistent(rec: Record_): boolean { return rec.params.retention?.persistent === true; }

  private persist(): void {
    const snaps = this.deps.snapshots;
    if (snaps === undefined) return;
    const sandboxes = [...this.records.values()].filter((r) => r.snapshots.length > 0).map((r) => ({ name: r.name, template: r.params.template, vcpus: r.params.vcpus, memMb: r.params.memMb, createdAt: r.createdAt, keepLast: r.params.retention?.keepLastSnapshots ?? DEFAULT_KEEP_LAST, snapshots: r.snapshots }));
    saveStore(snaps.stateDir, this.deps.euid as number, { version: 1, sandboxes, orphans: this.orphans });
  }

  private usedBytes(): number {
    let sum = 0;
    for (const r of this.records.values()) for (const s of r.snapshots) sum += s.bytes;
    for (const s of this.orphans) sum += s.bytes;
    for (const bytes of this.reserved.values()) sum += bytes;
    return sum;
  }

  /**
   * Takes the snapshots in `gone` out of the records first and writes the state file, then asks the helper to delete them; one the helper does not
   * confirm stays in `orphans` (still counted, tried again on the next pass). The record list is never ahead of the disk in the dangerous direction:
   * a snapshot is forgotten only once the helper says it is gone or never had it.
   */
  private async dropSnapshots(rec: Record_ | undefined, gone: SnapshotMeta[]): Promise<void> {
    if (rec !== undefined) rec.snapshots = rec.snapshots.filter((s) => !gone.includes(s));
    this.orphans.push(...gone);
    this.persist();
    for (const s of [...this.orphans]) {
      if (this.writing.has(s.id)) continue; // being written by a stop that has not heard back yet
      try {
        await this.deps.helper.snapshotDelete(s.id);
      } catch (err) {
        // fx-swallow-ok: not confirmed means it stays an orphan and is counted; only "unknown" is a confirmation
        if (!(err instanceof HelperError && err.code === "unknown_snapshot")) continue;
      }
      this.orphans = this.orphans.filter((o) => o !== s);
    }
    this.persist();
  }

  /** Evicts every snapshot older than the lifetime: what a resume would find expired on Vercel. */
  async sweep(): Promise<void> {
    if (this.orphans.length > 0) await this.dropSnapshots(undefined, []); // deletes the helper did not confirm are asked again before anything is counted
    const ttl = this.deps.snapshots?.ttlSeconds ?? DEFAULT_SNAPSHOT_TTL_SECONDS;
    const now = this.deps.now();
    for (const rec of this.records.values()) {
      const old = rec.snapshots.filter((s) => s.takenAt + ttl <= now);
      if (old.length > 0) await this.dropSnapshots(rec, old);
    }
  }

  stateOf(name: string): SandboxState { return this.get_(name).state; }
  private get_(name: string): Record_ {
    const rec = this.records.get(name);
    if (rec === undefined) throw new SandboxdError(404, "not_found");
    return rec;
  }

  async create(params: CreateParams): Promise<Sandbox> {
    if (!SANDBOX_ID.test(params.name)) throw new SandboxdError(400, "bad_request");
    if (this.records.has(params.name)) throw new SandboxdError(400, "bad_request"); // a taken name, as the overlay's contract has it
    const keep = params.retention?.keepLastSnapshots;
    if (keep !== undefined && (!Number.isSafeInteger(keep) || keep < 1 || keep > MAX_KEEP_LAST)) throw new SandboxdError(400, "bad_request");
    if (params.retention?.persistent === true && this.deps.snapshots === undefined) throw new SandboxdError(400, "bad_request"); // nowhere to keep a snapshot: never silently non-persistent
    const rec: Record_ = { name: params.name, state: "creating", createdAt: this.deps.now(), params, snapshots: [], commands: new Set(), starting: new Set() };
    this.records.set(params.name, rec); // synchronously: a second create of the same name, in the same turn, finds it taken
    try {
      await (rec.bringing = this.bring(rec).finally(() => (rec.bringing = undefined)));
    } catch (err) {
      this.records.delete(params.name);
      throw err;
    }
    return new Sandbox(this, params.name);
  }

  /** The signed-metadata gate first, then the helper: a digest that is not listed never reaches `prepare`. */
  private async bring(rec: Record_, from?: SnapshotMeta): Promise<void> {
    const { name, params } = rec;
    const { arch, digests } = await this.deps.boot.facts(params.template);
    assertBootable(await this.deps.boot.listTargets(), params.template, arch, digests);
    this.registered.add(name);
    try {
      let started: PreparedReply;
      if (from === undefined) {
        await this.deps.helper.prepare({ sandboxId: name, template: params.template, vcpus: params.vcpus, memMb: params.memMb });
        started = await this.deps.helper.start(name);
      } else {
        started = await this.resumeFrom(rec, from);
      }
      const dir = checkVsockDir(started.vsockDir, name, started.sandboxGid, this.deps.euid as number, this.deps.inspectDir(started.vsockDir));
      if (this.deps.hasForeignListener(dir)) throw new SandboxdError(502, "vsock_dir_refused");
      rec.agent = this.deps.agentFor(dir);
      rec.vsockDir = dir;
      await this.waitForAgent(rec.agent);
      rec.state = "running";
    } catch (err) {
      await this.destroyQuietly(name);
      if (err instanceof HelperError && err.code === "unknown_snapshot") throw new SandboxdError(404, "not_found"); // evicted behind our back: what an expired snapshot is on Vercel
      if (err instanceof HelperError && err.code === "snapshot_mismatch") throw new SandboxdError(409, "snapshot_mismatch"); // the snapshot is kept: the template may be put back
      throw err instanceof HelperError ? new SandboxdError(502, "helper_failed") : err;
    }
  }

  /** Makes sure the helper holds the sandbox prepared (it may have restarted, or the daemon may have), clears the dead VM's `v.sock`, then resumes. */
  private async resumeFrom(rec: Record_, snap: SnapshotMeta): Promise<PreparedReply> {
    const { name, params } = rec;
    const listed = (await this.deps.helper.list()).find((e) => e.sandboxId === name);
    const held: PreparedReply = listed ?? (await this.deps.helper.prepare({ sandboxId: name, template: params.template, vcpus: params.vcpus, memMb: params.memMb }));
    checkVsockDir(held.vsockDir, name, held.sandboxGid, this.deps.euid as number, this.deps.inspectDir(held.vsockDir));
    try {
      this.deps.removeVsockSocket(held.vsockDir);
    } catch {
      // fx-swallow-ok: replaced by one fixed refusal; the entry stays where it is
      throw new SandboxdError(502, "vsock_dir_refused");
    }
    try {
      return await this.deps.helper.resume(name, snap.id);
    } catch (err) {
      if (err instanceof HelperError && err.code === "unknown_snapshot") await this.dropSnapshots(rec, [snap]); // gone from the helper: forget it, and the next resume is "not found"
      throw err;
    }
  }

  private async waitForAgent(agent: GuestAgent): Promise<void> {
    const until = Date.now() + (this.deps.bootTimeoutMs ?? 30_000);
    for (;;) {
      try {
        // the boot bound holds even while one ping is pending: a guest that never answers must not outlast it
        let timer: NodeJS.Timeout | undefined;
        const deadline = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new SandboxdError(502, "agent_not_ready")), Math.max(1, until - Date.now()))));
        return await Promise.race([agent.ping(), deadline]).finally(() => clearTimeout(timer));
      } catch {
        // fx-swallow-ok: not listening yet is the normal state of a booting guest; the loop ends at the deadline with a fixed error
        if (Date.now() >= until) throw new SandboxdError(502, "agent_not_ready");
        await sleep(this.deps.pollMs ?? 100);
      }
    }
  }

  /** Destroys the VM and drops it from the registered set only when the helper says it is gone (or never knew it). */
  private async destroyQuietly(name: string): Promise<void> {
    try {
      await this.deps.helper.destroy(name);
      this.registered.delete(name);
      this.releaseTimedOut(this.records.get(name)); // the destroy returned: no write of this sandbox is still going on
    } catch (err) {
      // fx-swallow-ok: any other refusal leaves the id registered, so the daemon-wide teardown tries again; the caller already has its own error
      if (err instanceof HelperError && err.code === "unknown_sandbox") {
        this.registered.delete(name);
        this.releaseTimedOut(this.records.get(name)); // the helper does not know it: nothing is writing for it
      }
    }
  }

  /** True while a snapshot write of this sandbox timed out and no destroy of it has returned since: the helper has stopped (or is about to stop) its VM on its own. */
  hasTimedOutWrite(name: string): boolean {
    return (this.records.get(name)?.timedOut?.size ?? 0) > 0;
  }

  /** Lets the sweep and `delete` remove the snapshots whose write once timed out; they stay on `orphans` until the helper confirms their deletion. */
  private releaseTimedOut(rec: Record_ | undefined): void {
    for (const id of rec?.timedOut ?? []) this.writing.delete(id);
    rec?.timedOut?.clear();
  }

  async get(name: string, opts: { resume?: boolean } = {}): Promise<Sandbox> {
    const rec = this.get_(name);
    // the state changes in this same step (the async body runs to its first await), so a second caller finds the resume in flight and waits for it
    if (rec.state === "stopped" && opts.resume === true) rec.resuming = this.resumeNow(rec).finally(() => (rec.resuming = undefined));
    if (rec.resuming !== undefined) await rec.resuming;
    return new Sandbox(this, name);
  }

  private async resumeNow(rec: Record_): Promise<void> {
    rec.state = "creating";
    try {
      let from: SnapshotMeta | undefined;
      if (this.persistent(rec)) {
        await this.sweep();
        from = rec.snapshots[rec.snapshots.length - 1];
        if (from === undefined) throw new SandboxdError(404, "not_found"); // evicted or expired: the caller's fallback starts a fresh sandbox
      }
      await (rec.bringing = this.bring(rec, from).finally(() => (rec.bringing = undefined)));
    } catch (err) {
      rec.state = "stopped";
      throw err;
    }
  }

  /** Reads this process's registry only. */
  list(): InventoryRow[] {
    return [...this.records.values()].map((r) => ({ name: r.name, state: r.state, createdAt: r.createdAt }));
  }

  async runCommand(name: string, spec: CommandSpec & { signal?: AbortSignal }): Promise<SandboxdCommand> {
    const rec = this.get_(name);
    const agent = this.runningAgent(name);
    const command = new SandboxdCommand(agent, spec);
    rec.commands.add(command);
    const onAbort = (): void => void command.kill("SIGKILL");
    if (spec.signal?.aborted === true) onAbort(); // before start(): the command then ends without ever being sent
    else spec.signal?.addEventListener("abort", onAbort, { once: true });
    const starting = command.start();
    rec.starting.add(starting);
    try {
      await starting;
    } catch (err) {
      rec.commands.delete(command);
      throw err;
    } finally {
      rec.starting.delete(starting);
      spec.signal?.removeEventListener("abort", onAbort);
    }
    void command.wait().then(() => rec.commands.delete(command), () => rec.commands.delete(command));
    return command;
  }

  /** Refuses a bad id or one this VM's agent has seen. The command is counted among the sandbox's running ones, so a stop or delete kills it and ends its stream. */
  async runStream(name: string, spec: StreamSpec): Promise<GuestStream> {
    const rec = this.get_(name);
    const agent = this.runningAgent(name);
    if (!STREAM_ID.test(spec.id)) throw new SandboxdError(400, "bad_request");
    const ids = (rec.streamIds ??= new Set());
    if (ids.has(spec.id) || ids.size >= MAX_STREAM_IDS) throw new SandboxdError(409, "conflict");
    ids.add(spec.id);
    const { id, cmd, args, withToken, ...rest } = spec;
    const starting = agent.streamInGuest({ ...rest, id, argv: [cmd, ...(args ?? [])], ...(withToken === true ? { token: true } : {}) }).then((stream) => {
      const tracked: TrackedCommand = { kill: () => stream.kill("SIGKILL"), wait: () => stream.done, abort: () => stream.abort() };
      rec.commands.add(tracked); // before `starting` settles, so a stop that waits for it finds the command
      const gone = (): void => void rec.commands.delete(tracked);
      stream.done.then(gone, gone);
      return stream;
    });
    rec.starting.add(starting);
    try {
      return await starting;
    } finally {
      rec.starting.delete(starting);
    }
  }

  private runningAgent(name: string): GuestAgent {
    const rec = this.get_(name);
    if (rec.state !== "running" || rec.agent === undefined) throw new SandboxdError(409, "not_running");
    return rec.agent;
  }

  /**
   * Writes files in order, one transfer each. Every path and mode is checked before the first byte is sent, so a bad one writes nothing.
   * Memory is bounded by the transfer's piece size, not the file's. A file that fails leaves the guest's earlier files written (the agent
   * replaces each file whole or not at all).
   */
  async writeFiles(name: string, files: WriteFile[]): Promise<void> {
    const agent = this.runningAgent(name);
    const plan = files.map((f) => {
      const size = Buffer.isBuffer(f.content) ? f.content.length : f.size;
      // the same bound `put` enforces, applied here so a bad later entry is refused before the first file is written
      if (size === undefined || !Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) throw new SandboxdError(400, "bad_request");
      try {
        return { path: checkGuestPath(f.path), mode: guestFileMode(f.mode), size, content: f.content };
      } catch (err) {
        if (err instanceof FileError) throw new SandboxdError(400, "bad_request");
        throw err;
      }
    });
    for (const file of plan) await agent.put(file);
  }

  /**
   * Pushes the subscription token into the guest's tmpfs (D#587 B-6.4); the host connects, the guest never asks. A token delivered here is wiped
   * (file removed, holders killed) before any snapshot of this sandbox, and a snapshot is refused if the wipe cannot be confirmed. `token` is
   * zeroed when this settles. A delivery that fails is wiped on a best-effort basis, and the error is the agent's fixed one.
   */
  async deliverToken(name: string, token: Buffer): Promise<void> {
    let agent: GuestAgent;
    try {
      agent = this.runningAgent(name);
      if (this.get_(name).stopRequested === true) throw new SandboxdError(409, "not_running"); // a stop has begun: a token that lands after its wipe would be snapshotted
    } catch (err) {
      token.fill(0);
      throw err;
    }
    const rec = this.get_(name);
    rec.tokenHeld = true;
    const delivery = (async (): Promise<void> => {
      try {
        await agent.putToken(token);
      } catch (err) {
        // fx-swallow-ok: the put's own error is the one the caller gets; tokenHeld stays set when the wipe is not confirmed
        await agent.wipeToken().then(() => void (rec.tokenHeld = false), () => undefined);
        throw err;
      }
    })();
    (rec.delivering ??= new Set()).add(delivery);
    try {
      await delivery;
    } finally {
      rec.delivering.delete(delivery);
    }
  }

  /** A connection to `port` of the running guest (the engine session's channel is 5255); the caller owns and closes it. */
  async connect(name: string, port: number): Promise<Duplex> {
    this.runningAgent(name);
    const dir = this.get_(name).vsockDir;
    if (dir === undefined || this.deps.dial === undefined) throw new SandboxdError(409, "not_running");
    return this.deps.dial(dir, port);
  }

  /** An explicit wipe: a delivery in flight lands (or is given up on, bounded) first, then the guest must confirm that no file and no holder is left. */
  async wipeToken(name: string): Promise<void> {
    const rec = this.get_(name);
    this.runningAgent(name);
    await within(Promise.allSettled([...(rec.delivering ?? [])]), this.deps.startWaitMs ?? 30_000);
    if ((rec.delivering?.size ?? 0) > 0 || !(await this.wipeBeforeSnapshot(rec))) throw new SandboxdError(502, "token_wipe_failed");
  }

  /** Streams one guest file into `sink` and resolves with its size. */
  async readFile(name: string, path: string, sink: (chunk: Buffer) => void | Promise<void>): Promise<number> {
    const agent = this.runningAgent(name);
    try {
      checkGuestPath(path);
    } catch (err) {
      if (err instanceof FileError) throw new SandboxdError(400, "bad_request");
      throw err;
    }
    return agent.get(path, sink);
  }

  /**
   * Ends one id for good: stops its commands and destroys the VM, then drops the record. The id leaves `registered` only when the helper says
   * the VM is gone. A sandbox still being created is waited for first: destroying under a `prepare` that has not landed would be told
   * "unknown" and leave the VM behind. The caller bounds the wait. Returns whether it is gone.
   */
  async teardown(name: string): Promise<boolean> {
    await this.records.get(name)?.bringing?.catch(() => undefined); // fx-swallow-ok: the create's own caller has the error; this only waits for it to end
    const rec = this.records.get(name);
    if (rec !== undefined && rec.state !== "creating" && rec.state !== "stopped") {
      rec.stopping ??= this.beginStop(rec, false); // never a snapshot: nobody asked for one, and it would write the guest's whole RAM
      await rec.stopping.catch(() => undefined); // fx-swallow-ok: the destroy below is the real attempt, and the result is what is returned
    }
    if (this.registered.has(name)) await this.destroyQuietly(name);
    if (this.registered.has(name)) return false;
    if (rec === undefined || rec.snapshots.length === 0) this.records.delete(name); // a sandbox that holds snapshots stays (stopped): they are what a restart resumes from
    return true;
  }

  /**
   * Waits for every command that is still starting (so none is left half-launched), kills each live one, then destroys the VM. A command
   * whose start was in flight is killed once it has started, or never started at all: either way its `wait()` settles once.
   */
  stop(name: string): Promise<void> {
    const rec = this.get_(name);
    if (rec.state === "stopped") return Promise.resolve();
    if (rec.state === "creating") return Promise.reject(new SandboxdError(409, "conflict"));
    rec.stopping ??= this.beginStop(rec, this.persistent(rec) && (rec.timedOut?.size ?? 0) === 0);
    return rec.stopping;
  }

  /** The stop is requested in this same step (the state stays `running` while a snapshot is admitted), so a token delivery that comes after it is refused. */
  private beginStop(rec: Record_, snapshot: boolean): Promise<void> {
    rec.stopRequested = true;
    return this.stopNow(rec, snapshot).finally(() => {
      rec.stopping = undefined;
      rec.stopRequested = false;
    });
  }

  /**
   * Refuses (and changes nothing) when the snapshot would not fit: the sandbox keeps running. The admission and the reservation of its bytes are
   * one synchronous step (nothing is awaited between them), so two stops at once cannot both be admitted against the same free quota.
   */
  private async admitStop(rec: Record_): Promise<{ id: string; bytes: number }> {
    const snaps = this.deps.snapshots as SnapshotDeps;
    await this.sweep(); // expired ones free their room first
    const guestRamBytes = rec.params.memMb * MIB;
    const verdict = admitSnapshot({ guestRamBytes, usedBytes: this.usedBytes(), quotaBytes: snaps.quotaBytes, freeBytes: snaps.freeBytes(snaps.dir) });
    if (!verdict.admit) throw new SandboxdError(507, "snapshot_refused", verdict.detail);
    const reservation = { id: newSnapshotId(), bytes: snapshotNeedBytes(guestRamBytes) };
    this.reserved.set(reservation.id, reservation.bytes);
    return reservation;
  }

  private async stopNow(rec: Record_, snapshot: boolean): Promise<void> {
    const reservation = snapshot ? await this.admitStop(rec) : undefined;
    try {
      await this.stopAdmitted(rec, reservation);
    } finally {
      if (reservation !== undefined) this.reserved.delete(reservation.id); // released on every way out; a written snapshot is by now a record or an orphan
    }
  }

  private async stopAdmitted(rec: Record_, reservation: { id: string; bytes: number } | undefined): Promise<void> {
    const name = rec.name;
    rec.state = "stopping";
    // bounded: a start stuck on a silent guest must not hold the stop; destroying the VM below ends it
    await within(Promise.allSettled([...rec.starting]), this.deps.startWaitMs ?? 30_000);
    await Promise.allSettled([...rec.commands].map((c) => c.kill("SIGKILL")));
    await within(Promise.allSettled([...rec.commands].map((c) => c.wait())), this.deps.pollMs ?? 100);
    for (const c of rec.commands) c.abort?.(); // a stream the kill did not end goes with the VM
    rec.commands.clear();
    rec.streamIds?.clear();
    if (reservation !== undefined) {
      // a delivery already in flight lands (or is given up on) before the wipe; one that is still pending after the bound means no snapshot
      await within(Promise.allSettled([...(rec.delivering ?? [])]), this.deps.startWaitMs ?? 30_000);
      if ((rec.delivering?.size ?? 0) > 0 || (rec.tokenHeld === true && !(await this.wipeBeforeSnapshot(rec)))) {
        await this.destroyQuietly(name); // no snapshot of a guest that may still hold the token: the VM goes, and its RAM with it
        rec.state = this.registered.has(name) ? "running" : "stopped";
        throw new SandboxdError(502, "token_wipe_failed");
      }
      return this.snapshotNow(rec, reservation);
    }
    await this.destroyQuietly(name);
    if (this.registered.has(name)) {
      rec.state = "running"; // the helper still holds the VM: say so, and let the caller try again
      throw new SandboxdError(502, "helper_failed");
    }
    rec.state = "stopped";
  }

  /** True when the guest confirmed that no token file and no holder is left. */
  private async wipeBeforeSnapshot(rec: Record_): Promise<boolean> {
    try {
      await (rec.agent as GuestAgent).wipeToken();
      rec.tokenHeld = false;
      return true;
    } catch {
      // fx-swallow-ok: not confirmed means no snapshot; the caller destroys the VM and reports one fixed code
      return false;
    }
  }

  /**
   * The helper writes the snapshot and kills the VM, also when it fails. A new snapshot is recorded (and the state file written) before the old
   * ones beyond `keepLastSnapshots` are evicted, so a failed write never costs the snapshot that was already there. A sandbox stays prepared
   * on the helper after a good snapshot, which is what `resume` needs.
   */
  private async snapshotNow(rec: Record_, reservation: { id: string; bytes: number }): Promise<void> {
    const name = rec.name;
    const id = reservation.id;
    // Written down BEFORE the helper is asked, as an orphan of the size the admission expected: a lost reply, the client's timeout or a crash then
    // leaves a trace, and the next sweep deletes the snapshot (or confirms it never existed). It counts against the quota from here on.
    const pending: SnapshotMeta = { id, bytes: reservation.bytes, takenAt: this.deps.now() };
    this.orphans.push(pending);
    this.writing.add(id);
    try {
      this.persist();
    } catch (err) {
      this.orphans = this.orphans.filter((o) => o !== pending);
      this.writing.delete(id);
      rec.state = "running"; // nothing was asked of the helper: the VM is still up; the reservation is released by the caller's `finally`
      throw err;
    }
    this.reserved.delete(id); // the orphan now carries the same bytes
    let bytes: number;
    try {
      bytes = (await this.deps.helper.snapshot(name, id)).snapshotBytes;
    } catch (err) {
      if (err instanceof HelperError && err.code === "timeout") {
        // The helper may still be writing: destroying the VM now would cut the write short. Nothing is destroyed. The helper kills the VM itself when
        // it is done, the id stays in `writing` (so no sweep deletes a file that is being written) and on `orphans` (so the next daemon start does),
        // and the sandbox is reported as still held. The id is noted on the record: the next destroy of this VM releases it, so that the sweep and a
        // delete remove the file. The next stop of the record is a destroy with no snapshot (the helper ends the VM itself, so a second snapshot of it would fail).
        (rec.timedOut ??= new Set()).add(id);
        rec.state = "running";
        throw new SandboxdError(502, "helper_failed");
      }
      // fx-swallow-ok: replaced by the fixed error below, once the VM is made sure to be gone; the orphan stays so the snapshot is deleted if it exists
      this.writing.delete(id);
      await this.destroyQuietly(name);
      rec.state = this.registered.has(name) ? "running" : "stopped"; // still held by the helper: say so, and let the caller try again
      throw new SandboxdError(502, "helper_failed");
    }
    this.writing.delete(id);
    this.orphans = this.orphans.filter((o) => o !== pending);
    rec.state = "stopped";
    rec.snapshots.push({ id, bytes, takenAt: pending.takenAt });
    this.persist();
    const keep = rec.params.retention?.keepLastSnapshots ?? DEFAULT_KEEP_LAST;
    if (rec.snapshots.length > keep) await this.dropSnapshots(rec, rec.snapshots.slice(0, rec.snapshots.length - keep));
  }

  /** Ends the sandbox and its snapshots for good (a persistent sandbox is not snapshotted on the way out). */
  async delete(name: string): Promise<void> {
    const rec = this.records.get(name);
    if (rec === undefined) return; // idempotent, as on Vercel
    if (rec.state === "creating") throw new SandboxdError(409, "conflict");
    if (rec.state !== "stopped") {
      rec.stopping ??= this.beginStop(rec, false);
      await rec.stopping;
    }
    if (this.registered.has(name)) await this.destroyQuietly(name); // a persistent one is still prepared on the helper
    if (this.registered.has(name)) throw new SandboxdError(502, "helper_failed");
    this.records.delete(name);
    await this.dropSnapshots(rec, [...rec.snapshots]);
  }
}
