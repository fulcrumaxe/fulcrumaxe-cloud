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
import type { GuestAgent } from "./guestAgent.js";
import { FileError, MAX_FILE_BYTES, checkGuestPath, guestFileMode, type FileContent } from "./files.js";

export type SandboxState = "creating" | "running" | "stopping" | "stopped";
export interface CreateParams { name: string; template: string; vcpus: number; memMb: number }
/** One file to write; `size` is required (and exact) when `content` is not a Buffer. */
export interface WriteFile { path: string; mode?: number; size?: number; content: FileContent }
export interface InventoryRow { name: string; state: SandboxState; createdAt: number }

/** `status` is the HTTP status the overlay's contract names (a taken name is 400 `bad_request`); `code` is fixed text. */
export class SandboxdError extends Error {
  constructor(readonly status: number, readonly code: "bad_request" | "not_found" | "conflict" | "not_running" | "vsock_dir_refused" | "agent_not_ready" | "helper_failed") {
    super(`fx-sandboxd: ${code}`);
    this.name = "SandboxdError";
  }
}

/** What an fstat of an O_PATH|O_NOFOLLOW fd of the vsock directory showed; the daemon reads it through this so it makes no file-system call itself. */
export interface DirFacts { isDirectory: boolean; isSymbolicLink: boolean; uid: number; gid: number; mode: number }

export interface SandboxdDeps {
  /** `process.geteuid()`; undefined where there is none. */
  euid: number | undefined;
  helper: Helper;
  boot: { listTargets(): Promise<TargetListing>; facts(template: string): { arch: Arch; digests: BootDigests } };
  /** What an O_PATH|O_NOFOLLOW fd of the directory the helper named shows (a symlink is reported as one); undefined when it is not there. */
  inspectDir(dir: string): DirFacts | undefined;
  /** True when the directory holds a `v.sock_<port>` entry the runner does not own (or one that cannot be examined): the sandbox is then not started. */
  hasForeignListener(vsockDir: string): boolean;
  agentFor(vsockDir: string): GuestAgent;
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
  agent?: GuestAgent;
  commands: Set<SandboxdCommand>;
  starting: Set<Promise<unknown>>;
  stopping?: Promise<void>;
  /** The boot in flight (create or resume), so a teardown can wait for it instead of racing it. */
  bringing?: Promise<void>;
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
  readFile(path: string, sink: (chunk: Buffer) => void | Promise<void>): Promise<number> { return this.daemon.readFile(this.name, path, sink); }
  stop(): Promise<void> { return this.daemon.stop(this.name); }
  delete(): Promise<void> { return this.daemon.delete(this.name); }
}

export class Sandboxd {
  private readonly records = new Map<string, Record_>();
  /** Every id the helper may hold a VM for, added before `prepare` is asked: the teardown's list. */
  readonly registered = new Set<string>();

  constructor(private readonly deps: SandboxdDeps) {
    assertNotRoot(deps.euid);
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
    const rec: Record_ = { name: params.name, state: "creating", createdAt: this.deps.now(), params, commands: new Set(), starting: new Set() };
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
  private async bring(rec: Record_): Promise<void> {
    const { name, params } = rec;
    const { arch, digests } = this.deps.boot.facts(params.template);
    assertBootable(await this.deps.boot.listTargets(), params.template, arch, digests);
    this.registered.add(name);
    try {
      await this.deps.helper.prepare({ sandboxId: name, template: params.template, vcpus: params.vcpus, memMb: params.memMb });
      const started: PreparedReply = await this.deps.helper.start(name);
      const dir = checkVsockDir(started.vsockDir, name, started.sandboxGid, this.deps.euid as number, this.deps.inspectDir(started.vsockDir));
      if (this.deps.hasForeignListener(dir)) throw new SandboxdError(502, "vsock_dir_refused");
      rec.agent = this.deps.agentFor(dir);
      await this.waitForAgent(rec.agent);
      rec.state = "running";
    } catch (err) {
      await this.destroyQuietly(name);
      throw err instanceof HelperError ? new SandboxdError(502, "helper_failed") : err;
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
    } catch (err) {
      // fx-swallow-ok: any other refusal leaves the id registered, so the daemon-wide teardown tries again; the caller already has its own error
      if (err instanceof HelperError && err.code === "unknown_sandbox") this.registered.delete(name);
    }
  }

  async get(name: string, opts: { resume?: boolean } = {}): Promise<Sandbox> {
    const rec = this.get_(name);
    if (rec.state === "stopped" && opts.resume === true) {
      rec.state = "creating";
      try {
        await (rec.bringing = this.bring(rec).finally(() => (rec.bringing = undefined)));
      } catch (err) {
        rec.state = "stopped";
        throw err;
      }
    }
    return new Sandbox(this, name);
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
    if (rec !== undefined && rec.state !== "creating") await this.stop(name).catch(() => undefined); // fx-swallow-ok: the destroy below is the real attempt, and the result is what is returned
    if (this.registered.has(name)) await this.destroyQuietly(name);
    if (this.registered.has(name)) return false;
    this.records.delete(name);
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
    rec.stopping ??= this.stopNow(rec).finally(() => (rec.stopping = undefined));
    return rec.stopping;
  }

  private async stopNow(rec: Record_): Promise<void> {
    const name = rec.name;
    rec.state = "stopping";
    // bounded: a start stuck on a silent guest must not hold the stop; destroying the VM below ends it
    await within(Promise.allSettled([...rec.starting]), this.deps.startWaitMs ?? 30_000);
    await Promise.allSettled([...rec.commands].map((c) => c.kill("SIGKILL")));
    await within(Promise.allSettled([...rec.commands].map((c) => c.wait())), this.deps.pollMs ?? 100);
    rec.commands.clear();
    await this.destroyQuietly(name);
    if (this.registered.has(name)) {
      rec.state = "running"; // the helper still holds the VM: say so, and let the caller try again
      throw new SandboxdError(502, "helper_failed");
    }
    rec.state = "stopped";
  }

  async delete(name: string): Promise<void> {
    const rec = this.records.get(name);
    if (rec === undefined) return; // idempotent, as on Vercel
    await this.stop(name);
    this.records.delete(name);
  }
}
