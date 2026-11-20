/**
 * The runner's own bridge commands (D#845 ON-BR-2): `bridge_enable` and `bridge_disable`, signed for THIS runner and a repo it is paired with, which the cloud sends when a person presses Connect or
 * Disconnect. They are the runner's, not the engine's: nothing is written to an engine inbox, and no engine session, no running repo and no operate switch is needed. This puller therefore runs whether or not
 * a repo is enabled, once the hello kept `engine_bridge_v1`.
 *
 * Each command is judged in the order the engine commands are, and the first failure acks `refused` with that reason and changes nothing: signature (`signature_invalid`), this runner (`wrong_runner`), a repo
 * the cloud's own list pairs the runner with (`wrong_repo`), `expires_at` ahead (`expired`), and a `command_seq` above the last one taken for the repo and an id not seen in the last 24 hours (`seq_not_increasing`
 * for both). The last sequence and the seen ids live in the runner's state directory, so a replay after a restart, or of a connect after a disconnect, changes nothing.
 *
 * `bridge_enable` then asks the same local code `fx-runner engine-bridge enable` runs (the scan, or the folder the person picked from what this runner offered), with every refusal that code has. The ack says what
 * happened as one result: connected (with the folder's last two parts), already_connected (nothing written), not_found, ambiguous (with the folders), or refused (with a closed code). Folders go only into the
 * ack: never into a log line. `bridge_disable` removes the repo's bridge settings and bridge state file, the same as `engine-bridge disable --repo`, and nothing else.
 *
 * Every pull also reports what this runner bridges (`bridged`: repo and checkout, from the settings file), so the cloud's "connected" follows the machine: a repo disabled by hand drops out at the next pull.
 */
import { EngineCommandAck, JobSignatureError, MAX_CLOCK_SKEW_S, RepoRoot, bridgeRootTail, verifyEngineCommand, type BridgeRefusal, type EngineCommand, type JobKeyring } from "@fulcrumaxe/runner-protocol";
import { readPrivateFile, writePrivateFile } from "../config.js";
import type { CloudReply } from "../cloud.js";
import type { Clock } from "../daemon/lease.js";
import { ACK_CHECK_MS, BACKOFF_MAX_S, BACKOFF_START_S, NO_WAKE_PULL_MS, PERMANENT_400_BACKOFF_S, PULL_PATH, SAFETY_PULL_MS, WAKE_CHECK_MS, ackPath } from "./commands.js";

export const BRIDGE_COMMANDS_FILE = "engine-bridge-commands.json";
/** The ids of commands taken are remembered this long (the engine inbox's own figure). */
export const SEEN_KEEP_MS = 24 * 3600 * 1000;
const SEEN_MAX = 500;
/** How long the folders this runner offered stay pickable (the cloud's own window). */
export const OFFER_WINDOW_MS = 600_000;
/** A repo id no GitHub repository has: a pull for it names nothing and still returns the runner's repo list and its bridge commands. */
const PROBE_ID = Number.MAX_SAFE_INTEGER;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type EnableOutcome = { ok: true; root: string } | { ok: false; code: BridgeRefusal; candidates: readonly string[]; /** The scan hit its cap before it found a copy (only with `checkout_not_found`). */ incomplete?: boolean };
/** What the runner can do to its own settings, bound by the entry point to `enableRepo` and `disableRepos` of the command line. */
export interface BridgeApply {
  /** Enables the repo as `engine-bridge enable --repo <full_name>` would, with `root` as `--repo-root` when the person picked one. Never throws. */
  enable(repo: { repo_gh_id: number; full_name: string }, root: string | undefined): EnableOutcome;
  /** Removes the repo from the bridge settings and removes its bridge state file. True when it was enabled or is not (nothing to undo); false when the settings could not be changed. */
  disable(repoGhId: number): boolean;
  /** The repos enabled now, from the settings file; undefined when the file is damaged. */
  bridged(): ReadonlyArray<{ repo_gh_id: number; full_name: string; root: string }> | undefined;
}

interface State {
  version: 1;
  last_seq: Record<string, number>;
  seen: Record<string, number>;
  /** The folders this runner offered a person for a repo, and when: a carried folder is taken only if it is one of them, inside {@link OFFER_WINDOW_MS} (older offers are dropped when the state is read). */
  offers: Record<string, { at: number; roots: string[] }>;
}

export interface BridgeCommandsDeps {
  post: (path: string, body: unknown) => Promise<CloudReply>;
  keyring: JobKeyring;
  runnerId: string;
  clock: Clock;
  wakeEpoch: () => number | null;
  /** True once the hello was answered and kept `engine_bridge_v1`. */
  accepted: () => boolean;
  runnerStateDir: string;
  /** The cloud's list of this runner's repos as the last pull said it, or undefined when none is held or it is old. */
  allowed: () => ReadonlyArray<{ repo_gh_id: number; full_name: string }> | undefined;
  apply: BridgeApply;
  /** Gets fixed text only. */
  log: (line: string) => void;
}

/** The ack a refusal or an enable outcome becomes. Pure, and always a valid `EngineCommandAck`: anything that would not parse is a plain `bridge_failed` refusal. */
export function ackForEnable(outcome: EnableOutcome): EngineCommandAck {
  const failed: EngineCommandAck = { outcome: "refused", refusal: "bridge_failed", result: "refused" };
  if (outcome.ok) return EngineCommandAck.safeParse({ outcome: "applied", result: "connected", root_tail: bridgeRootTail(outcome.root) }).data ?? failed;
  const candidates = outcome.candidates.filter((c) => RepoRoot.safeParse(c).success).slice(0, 10);
  const base = candidates.length === 0 ? {} : { candidates };
  // The copies a scan skipped as unsafe are information, never a pick (ruling 9): they travel in `skipped`, and no offer is made of them.
  const code = outcome.code;
  const attempt =
    code === "checkout_not_found"
      ? { outcome: "refused", refusal: code, result: "not_found", ...(candidates.length === 0 ? {} : { skipped: candidates }), ...(outcome.incomplete === true ? { incomplete: true } : {}) }
      : code === "checkout_ambiguous"
        ? { outcome: "refused", refusal: code, result: "ambiguous", ...base }
        : { outcome: "refused", refusal: code, result: "refused", ...(code === "checkout_incomplete" ? base : {}) };
  return EngineCommandAck.safeParse(attempt).data ?? failed;
}

export class BridgeCommandPuller {
  private holdUntil = 0;
  private failures = 0;
  private failing = false;
  private ackHoldUntil = 0;
  private ackFailures = 0;
  /** Acks the cloud has not taken yet, by command id: sent again, never dropped. */
  private readonly unsent = new Map<string, EngineCommandAck>();
  private again = false;

  constructor(private readonly deps: BridgeCommandsDeps) {}

  /** Pulls at start, on a wake, every `SAFETY_PULL_MS` (`NO_WAKE_PULL_MS` before a wake answer), after a command was taken (to report what changed), and after a failure when its back-off ends. Until `signal` aborts. */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      if (!this.deps.accepted()) {
        await this.deps.clock.sleep(WAKE_CHECK_MS * 5, signal);
        continue;
      }
      const epoch = this.deps.wakeEpoch();
      const startedAt = this.deps.clock.now().getTime();
      try {
        await this.pullOnce();
      } catch {
        // fx-swallow-ok: the error text could hold a path; a fixed line is logged and the pull is tried again after a wait
        this.deps.log("engine-bridge: a bridge command pass failed; trying again later");
        this.fail(false);
      }
      let ackCheckedAt = startedAt;
      for (;;) {
        await this.deps.clock.sleep(WAKE_CHECK_MS, signal);
        const nowMs = this.deps.clock.now().getTime();
        if (signal.aborted) break;
        if (nowMs - ackCheckedAt >= ACK_CHECK_MS || nowMs < ackCheckedAt) {
          ackCheckedAt = nowMs;
          await this.sendAcks();
        }
        if (this.again) {
          this.again = false;
          break;
        }
        if (nowMs < this.holdUntil) continue;
        const current = this.deps.wakeEpoch();
        const every = current === null ? NO_WAKE_PULL_MS : SAFETY_PULL_MS;
        if (current !== epoch || this.failing || nowMs - startedAt >= every || nowMs < startedAt) break;
      }
    }
  }

  /** One pull: owed acks, then the pull (reporting what is bridged), then each command in sequence order. Never throws for a cloud failure. */
  async pullOnce(): Promise<void> {
    await this.sendAcks();
    if (this.deps.clock.now().getTime() < this.holdUntil) return;
    const bridged = this.deps.apply.bridged();
    const report = bridged === undefined ? {} : { bridged: bridged.slice(0, 10).map((b) => ({ repo_gh_id: b.repo_gh_id, root: b.root })) };
    const reply = await this.deps.post(PULL_PATH, { repo_gh_ids: [PROBE_ID], after_seq: {}, ...report, bridge_commands: true });
    const commands = reply.status === 200 ? commandsOf(reply.body) : undefined;
    if (commands === undefined) return void this.fail(reply.status === 400);
    this.failing = false;
    this.failures = 0;
    this.holdUntil = 0;
    const raws = [...commands].sort((a, b) => seqOf(a) - seqOf(b));
    for (const raw of raws) await this.take(raw);
    await this.sendAcks();
  }

  private async take(raw: unknown): Promise<void> {
    const id = idOf(raw);
    if (id === null) return;
    const now = this.deps.clock.now();
    const state = this.load(now.getTime());
    const verdict = this.judge(raw, state, now);
    if (!verdict.ok) {
      this.unsent.set(id, { outcome: "refused", refusal: verdict.refusal });
      return;
    }
    const { command, repo } = verdict;
    // Remembered before anything is done: a crash in the middle never lets the same command run twice.
    state.last_seq[String(command.repo_gh_id)] = command.command_seq;
    state.seen[id] = now.getTime();
    if (!this.save(state)) {
      this.deps.log("engine-bridge: the bridge command state could not be written; the command was not run");
      return;
    }
    this.again = true;
    if (command.kind === "bridge_disable") {
      this.unsent.set(id, this.deps.apply.disable(command.repo_gh_id) ? { outcome: "applied" } : { outcome: "refused", refusal: "bridge_failed" });
      return;
    }
    if (command.kind !== "bridge_enable") return;
    const have = this.deps.apply.bridged();
    if (have === undefined) {
      this.unsent.set(id, ackForEnable({ ok: false, code: "settings_damaged", candidates: [] }));
      return;
    }
    const existing = have.find((b) => b.repo_gh_id === command.repo_gh_id);
    if (existing !== undefined) {
      this.unsent.set(id, { outcome: "applied", result: "already_connected", root_tail: bridgeRootTail(existing.root) });
      return;
    }
    const root = command.args.repo_root;
    // The cloud's word is a request: a folder is taken only if this runner offered it for this repo a short while ago (and `enable` then judges it with every guard the scan has).
    if (root !== undefined && !(state.offers[String(command.repo_gh_id)]?.roots.includes(root))) {
      this.unsent.set(id, ackForEnable({ ok: false, code: "repo_root_invalid", candidates: [] }));
      return;
    }
    const ack = ackForEnable(this.deps.apply.enable(repo, root));
    // What it offers is remembered, so a later pick can be checked against it.
    if (ack.candidates !== undefined) {
      state.offers[String(command.repo_gh_id)] = { at: now.getTime(), roots: [...ack.candidates] };
      this.save(state);
    }
    this.unsent.set(id, ack);
  }

  private judge(raw: unknown, state: State, now: Date): { ok: true; command: EngineCommand & { kind: "bridge_enable" | "bridge_disable" }; repo: { repo_gh_id: number; full_name: string } } | { ok: false; refusal: "signature_invalid" | "wrong_runner" | "wrong_repo" | "expired" | "seq_not_increasing" } {
    let command: EngineCommand;
    try {
      command = verifyEngineCommand(raw, this.deps.keyring, now);
    } catch (error) {
      // An expired command is judged again at a moment inside its life, so the later checks still run in their order.
      const expiresAt = (raw as { command?: { expires_at?: unknown } } | null)?.command?.expires_at;
      const at = typeof expiresAt === "string" ? Date.parse(expiresAt) - 1 : Number.NaN;
      if (!(error instanceof JobSignatureError) || error.code !== "expired" || !Number.isFinite(at)) return { ok: false, refusal: "signature_invalid" };
      try {
        command = verifyEngineCommand(raw, this.deps.keyring, new Date(at));
      } catch {
        // fx-swallow-ok: a signature that fails at any moment is simply invalid
        return { ok: false, refusal: "signature_invalid" };
      }
    }
    if (command.kind !== "bridge_enable" && command.kind !== "bridge_disable") return { ok: false, refusal: "wrong_repo" };
    if (command.runner_id !== this.deps.runnerId) return { ok: false, refusal: "wrong_runner" };
    const repo = this.deps.allowed()?.find((a) => a.repo_gh_id === command.repo_gh_id);
    if (repo === undefined) return { ok: false, refusal: "wrong_repo" };
    if (Date.parse(command.expires_at) <= now.getTime() || Date.parse(command.issued_at) > now.getTime() + MAX_CLOCK_SKEW_S * 1000) return { ok: false, refusal: "expired" };
    if (command.command_seq <= (state.last_seq[String(command.repo_gh_id)] ?? 0) || Object.hasOwn(state.seen, command.command_id.toLowerCase())) return { ok: false, refusal: "seq_not_increasing" };
    return { ok: true, command, repo };
  }

  private load(nowMs: number): State {
    const empty: State = { version: 1, last_seq: {}, seen: {}, offers: {} };
    let text: string | undefined;
    try {
      text = readPrivateFile(this.deps.runnerStateDir, BRIDGE_COMMANDS_FILE);
    } catch {
      // fx-swallow-ok: an unreadable file is no memory; the cloud's own expiry and the seq rule of a fresh state still apply
      return empty;
    }
    if (text === undefined) return empty;
    try {
      const o = JSON.parse(text) as Partial<State> | null;
      if (o === null || typeof o !== "object" || o.version !== 1 || typeof o.last_seq !== "object" || o.last_seq === null || typeof o.seen !== "object" || o.seen === null) return empty;
      const seen = Object.fromEntries(Object.entries(o.seen).filter(([k, v]) => UUID.test(k) && typeof v === "number" && nowMs - v < SEEN_KEEP_MS));
      const last = Object.fromEntries(Object.entries(o.last_seq).filter(([k, v]) => /^[1-9][0-9]{0,15}$/.test(k) && typeof v === "number" && Number.isSafeInteger(v) && v >= 0));
      const offers: State["offers"] = {};
      for (const [k, v] of Object.entries(o.offers ?? {})) {
        const e = v as { at?: unknown; roots?: unknown } | null;
        if (/^[1-9][0-9]{0,15}$/.test(k) && e !== null && typeof e === "object" && typeof e.at === "number" && nowMs - e.at >= 0 && nowMs - e.at <= OFFER_WINDOW_MS && Array.isArray(e.roots)) offers[k] = { at: e.at, roots: e.roots.filter((r): r is string => typeof r === "string" && RepoRoot.safeParse(r).success).slice(0, 10) };
      }
      return { version: 1, last_seq: last, seen, offers };
    } catch {
      // fx-swallow-ok: a file that is not JSON is no memory
      return empty;
    }
  }

  private save(state: State): boolean {
    const entries = Object.entries(state.seen).sort((a, b) => b[1] - a[1]).slice(0, SEEN_MAX);
    try {
      writePrivateFile(this.deps.runnerStateDir, BRIDGE_COMMANDS_FILE, `${JSON.stringify({ ...state, seen: Object.fromEntries(entries) })}\n`);
      return true;
    } catch {
      // fx-swallow-ok: the error could name a path; the caller logs a fixed line
      return false;
    }
  }

  private async sendAcks(): Promise<void> {
    if (this.deps.clock.now().getTime() < this.ackHoldUntil) return;
    for (const [id, ack] of [...this.unsent]) {
      const reply = await this.deps.post(ackPath(id), ack);
      if (reply.status === 200 || reply.status === 404 || reply.status === 409) {
        // 404 and 409 mean the cloud will not take this ack (another runner's, or already acked): it is settled either way.
        this.unsent.delete(id);
        this.ackFailures = 0;
        this.ackHoldUntil = 0;
        continue;
      }
      this.ackHoldUntil = this.deps.clock.now().getTime() + (reply.status === 400 ? PERMANENT_400_BACKOFF_S : Math.min(BACKOFF_MAX_S, BACKOFF_START_S * 2 ** Math.min(this.ackFailures, 10))) * 1000;
      this.ackFailures += 1;
      return;
    }
  }

  private fail(permanent: boolean): void {
    if (!this.failing) this.deps.log("engine-bridge: the cloud did not take a bridge command pull; trying again later");
    this.failing = true;
    this.holdUntil = this.deps.clock.now().getTime() + (permanent ? PERMANENT_400_BACKOFF_S : Math.min(BACKOFF_MAX_S, BACKOFF_START_S * 2 ** Math.min(this.failures, 10))) * 1000;
    this.failures += 1;
  }
}

function commandsOf(body: unknown): unknown[] | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const { commands, controls } = body as { commands?: unknown; controls?: unknown };
  return Array.isArray(commands) && commands.length <= 20 && Array.isArray(controls) ? commands : undefined;
}
const idOf = (raw: unknown): string | null => {
  const id = (raw as { command?: { command_id?: unknown } } | null)?.command?.command_id;
  return typeof id === "string" && UUID.test(id) ? id.toLowerCase() : null;
};
const seqOf = (raw: unknown): number => {
  const seq = (raw as { command?: { command_seq?: unknown } } | null)?.command?.command_seq;
  return typeof seq === "number" ? seq : Number.MAX_SAFE_INTEGER;
};
