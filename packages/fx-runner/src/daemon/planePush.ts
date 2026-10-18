/**
 * D#598 P1f-3: the run-end hook that publishes an executor run's change to the repository's PAIRED PUBLIC repository.
 *
 * A repository can be paired with a public code repository: the change an executor makes goes out there as one commit on the public `main` tip,
 * never as private history. The push route that does the work (`routeAndPush`, with its scanner) lives in the protocol package; this file is the
 * caller on the customer's machine. It runs once, after the run's own branch was pushed to the private repository and before `done` is sent,
 * because the cloud's routes need the live lease.
 *
 * What the hook takes, and from where (Corrections C4 and C6):
 *  - the pairing (the private paths, the two rule-file paths, the paired repo) ONLY from the cloud's pairing reply. Nothing on this machine, in the
 *    job or in the repository names them. The route reads it twice, once to start and once at push time, so a pairing edited between the two is
 *    refused `pairing_changed`; the second read is a live call on purpose;
 *  - the pull request title and body, the branch and the commit identity ONLY from the token reply. Nothing the agent wrote can reach them;
 *  - the start commit (`privateBase`) from the daemon's own record, taken before the agent started (`PlaneBaseLedger`), never from the checkout;
 *  - the objects from the daemon's mirror, by local path, into a throwaway bare repository this hook creates in the runner's private state
 *    directory. No clone is ever handed to the route, so no `remote.*`, `branch.*` or `user.*` setting can exist in it.
 *
 * The pairing is read twice in a normal run, no more: once right after the token and before anything is built or run (a reply that cannot be believed
 * costs no local work), which is the route's first read, and once at push time, after the scan and before the push, which is a new call.
 *
 * The token is asked for BEFORE the route runs, because the route needs the text and the identity from its reply to build and scan the commit.
 * It is handed to the route as its "mint" (the route asks for one after its scan), is used for the push header and the two API calls and for
 * nothing else, and is revoked in a `finally`. A run that is not paired is answered 403 `not_paired` to that request: it never enters the hook
 * (no repository is built, nothing runs, nothing is reported). A run that changed nothing reports `no_change` without asking for a token, so it
 * spends none of the three attempts.
 *
 * Added to the route's own refusals, because the route reads a rule file at the run's HEAD (the agent's commit): a run that changed either
 * declared rule file is refused (`scan_refused`, `rule_file_invalid`), so the scanner a run is checked by is the one it started with.
 *
 * Every refusal leaves the public repository's branches as they were, and reports a code with place-plus-rule-key entries, never a matched value.
 */
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import {
  PLANE_REFUSAL_CODES,
  PlaneRouteError,
  planePushGit,
  routeAndPush,
  type PlaneRefusalCode,
  type PlaneRouteInput,
  type PlaneRouteResult,
  type PublicApi,
  type PublicGitTransport,
  type Refusal,
  type RepoPairing,
} from "@fulcrumaxe/runner-protocol/planePush";
import type { PlanePushReportMessage, PlanePushTokenReply, StopReason } from "@fulcrumaxe/runner-protocol";
import type { RunnerClient } from "./client.js";
import type { PlanePushGithub } from "./planePushGithub.js";

/** The daemon's record of the commit each run started from, written before the agent starts and read at run end. The checkout is never asked. */
export interface PlaneBaseLedger {
  /** Records `base` for the run. A second record for the same run throws, so a value cannot be replaced once the agent may be running. */
  record(runId: string, base: string): void;
  read(runId: string): string | undefined;
  forget(runId: string): void;
}

const OBJECT_ID = /^[0-9a-f]{40}$/;

export function createPlaneBaseLedger(): PlaneBaseLedger {
  const bases = new Map<string, string>();
  return {
    record(runId, base) {
      if (!OBJECT_ID.test(base)) throw new TypeError("the start commit must be a full 40-hex id");
      if (bases.has(runId)) throw new Error("the start commit of this run is already recorded");
      bases.set(runId, base);
    },
    read: (runId) => bases.get(runId),
    forget: (runId) => void bases.delete(runId),
  };
}

export type PlanePushOutcome =
  /** Nothing was done and nothing was reported: the run is not paired (or the hook could not be entered). `why` is a closed word. */
  | { kind: "not_entered"; why: "unpaired" | "no_base" | "aborted" | "unavailable" }
  | { kind: "no_change" }
  | { kind: "pr_opened"; number: number; seconds: number }
  | { kind: "pr_not_opened"; seconds: number }
  | { kind: "refused"; code: PlaneRefusalCode; seconds: number }
  /** The cloud has ended or fenced the run: nothing more is reported. */
  | { kind: "stopped"; reason: StopReason }
  /** Something unexpected on this machine; the change was not sent. */
  | { kind: "failed" };

export interface PlanePushRunEnd {
  runId: string;
  leaseGeneration: number;
  repo: { owner: string; name: string };
  /** The daemon's bare mirror of the private repository: where the run's objects are. */
  mirrorDir: string;
  /** The commit the run published to its private branch, or undefined when it added none. */
  privateHead: string | undefined;
  signal?: AbortSignal | undefined;
}

export interface PlanePushHookDeps {
  client: Pick<RunnerClient, "planePushPairing" | "planePushToken" | "planePushReport">;
  github: PlanePushGithub;
  transport: PublicGitTransport;
  baseLedger: PlaneBaseLedger;
  /** A directory in the runner's private state where the throwaway repositories are built (made 0700). */
  workRoot: string;
  /** The runner's user id, when the platform has one: the work root must belong to it. */
  uid?: number | undefined;
  now?: () => Date;
  /** Replaceable so a test does not wait. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** One closed line per run, for the runner's output: an outcome word and the seconds. Never a path, a token or text from the change. */
  say?: (line: string) => void;
}

const WORK_DIR = /^p-[A-Za-z0-9]{6}$/;
const REPORT_TRIES = 3;
const PAIRING_TRIES = 3;
const RETRY_MS = 1500;

/** A work directory is one plain, real directory directly under the root: anything else is not ours to create in or delete. */
function isOwnDirectory(root: string, dir: string): boolean {
  if (path.dirname(dir) !== root || !WORK_DIR.test(path.basename(dir))) return false;
  try {
    const stat = lstatSync(dir);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    // fx-swallow-ok: a directory that cannot be read is not one this hook may delete
    return false;
  }
}

/** The root, made 0700 or checked to be: a real directory (never a link), ours, closed to group and others. Throws on anything else. */
function ensureRoot(root: string, uid: number | undefined): void {
  if (!path.isAbsolute(root)) throw new TypeError("the work root must be absolute");
  let stat = (() => {
    try {
      return lstatSync(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("work_root_insecure");
    }
  })();
  if (stat === null) {
    mkdirSync(root, { mode: 0o700 });
    stat = lstatSync(root);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("work_root_insecure");
  if (uid !== undefined && stat.uid !== uid) throw new Error("work_root_insecure");
  if ((stat.mode & 0o077) !== 0) {
    chmodSync(root, 0o700);
    if ((lstatSync(root).mode & 0o077) !== 0) throw new Error("work_root_insecure");
  }
}

/** Removes the throwaway repositories a stopped daemon left behind. Only entries of the exact work-directory shape that are real directories; a link at the root is left alone. */
export function sweepWorkRoot(root: string): void {
  let names: string[];
  try {
    if (lstatSync(root).isSymbolicLink()) return;
    names = readdirSync(root);
  } catch {
    // fx-swallow-ok: no work directory yet
    return;
  }
  for (const name of names) {
    const dir = path.join(root, name);
    if (!isOwnDirectory(root, dir)) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // fx-swallow-ok: a leftover is only disk, and the next start tries again
    }
  }
}

/** Thrown inside the route's calls when the cloud says the run is over; the hook then stops without reporting. */
class HookStop extends Error {
  constructor(readonly reason: StopReason) {
    super("the cloud ended the run");
    this.name = "HookStop";
  }
}

const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const clip = (text: string, max: number): string => {
  const clean = text.replace(UNSAFE_TEXT, "?");
  return clean.length > max ? clean.slice(0, max) : clean;
};

/** The route's refusals as the report carries them: a kind, a place (path and line) and a rule key. The matched text is never in a `Refusal`, and `message` is not sent. */
export function reportRefusals(refusals: readonly Refusal[]): NonNullable<PlanePushReportMessage["refusals"]> {
  return refusals.slice(0, 100).map((r) => ({
    kind: r.kind,
    place: clip(r.path === undefined ? "-" : `${r.path}${r.line === undefined ? "" : `:${r.line}`}`, 300) || "-",
    rule_key: clip(r.rule ?? r.kind, 200),
  }));
}

const sameRepo = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const coded = (code: PlaneRefusalCode, message: string): PlaneRouteError => new PlaneRouteError(code, message);

/**
 * The route reads each declared rule file at the run's HEAD, which is the agent's commit. A run that changed one would be scanned by the rules it
 * wrote, so a changed (or added, or removed) rule file refuses the push. Compared by the blob each commit holds at that path.
 */
async function assertRuleFilesUnchanged(repoDir: string, base: string, head: string, pairing: RepoPairing): Promise<void> {
  for (const rulePath of [pairing.identifierRulesPath, pairing.planDataRulesPath]) {
    if (rulePath === null) continue;
    const blobAt = async (rev: string): Promise<string> => {
      try {
        return (await planePushGit(repoDir, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}:${rulePath}`])).toString("utf8").trim();
      } catch {
        // fx-swallow-ok: no such file at that commit is the empty answer
        return "";
      }
    };
    if ((await blobAt(base)) !== (await blobAt(head))) {
      throw new PlaneRouteError("scan_refused", "a declared rule file was changed by this run; nothing is pushed", [{ kind: "rule_file_invalid", path: rulePath, message: `the declared rule file ${rulePath} was changed by this run` }]);
    }
  }
}

export function createPlanePushHook(deps: PlanePushHookDeps): (input: PlanePushRunEnd) => Promise<PlanePushOutcome> {
  const now = deps.now ?? ((): Date => new Date());
  const sleep =
    deps.sleep ??
    ((ms: number, signal?: AbortSignal): Promise<void> =>
      new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
      }));
  sweepWorkRoot(deps.workRoot);

  return async (input) => {
    const started = now().getTime();
    const seconds = (): number => Math.round((now().getTime() - started) / 100) / 10;
    const done = (outcome: PlanePushOutcome): PlanePushOutcome => {
      deps.say?.(`fx-runner: public push: ${outcome.kind}${"seconds" in outcome ? ` in ${outcome.seconds}s` : ""}`);
      return outcome;
    };
    const { runId, leaseGeneration } = input;
    const base = deps.baseLedger.read(runId);
    if (base === undefined) return { kind: "not_entered", why: "no_base" };
    if (input.signal?.aborted) return { kind: "not_entered", why: "aborted" };
    const head = input.privateHead ?? base;

    /** One report, tried again on a network failure or a 5xx. A stop reply is returned to the caller; every other failure is dropped (a report is a hint). */
    async function report(message: Omit<PlanePushReportMessage, "run_id" | "lease_generation">): Promise<"recorded" | "not_paired" | { stop: StopReason } | "failed"> {
      for (let attempt = 1; attempt <= REPORT_TRIES; attempt++) {
        const reply = await deps.client.planePushReport({ run_id: runId, lease_generation: leaseGeneration, ...message });
        if (reply.kind === "recorded") return "recorded";
        if (reply.kind === "not_paired") return "not_paired";
        if (reply.kind === "stop") return { stop: reply.reason };
        if (reply.kind === "error" && (reply.status === 0 || reply.status >= 500) && attempt < REPORT_TRIES) {
          await sleep(RETRY_MS * attempt, input.signal);
          continue;
        }
        return "failed";
      }
      return "failed";
    }

    // A run that added no commit has nothing to publish. It reports so without asking for a token; a run that is not paired is told 403 and is done.
    if (head === base) {
      const told = await report({ phase: "no_change" });
      if (told === "not_paired") return { kind: "not_entered", why: "unpaired" };
      if (typeof told === "object") return { kind: "stopped", reason: told.stop };
      return done({ kind: "no_change" });
    }

    // The token request is what "is this run paired" is answered by: 403 `not_paired` ends the hook before anything is built.
    const asked = await deps.client.planePushToken(runId, leaseGeneration);
    if (asked.kind === "not_paired") return { kind: "not_entered", why: "unpaired" };
    if (asked.kind === "stop") return { kind: "stopped", reason: asked.reason };
    if (asked.kind === "error") return { kind: "not_entered", why: "unavailable" };
    if (asked.kind === "refused") {
      const code = (PLANE_REFUSAL_CODES as readonly string[]).includes(asked.code) ? (asked.code as PlaneRefusalCode) : "public_unavailable";
      const told = await report({ phase: "refused", code });
      return typeof told === "object" ? { kind: "stopped", reason: told.stop } : done({ kind: "refused", code, seconds: seconds() });
    }
    const grant: PlanePushTokenReply = asked.reply;
    const token = grant.token;

    let work: string | undefined;
    let pairingDigest: string | undefined;
    let stopReason: StopReason | undefined;
    let commit: string | undefined;
    let tip: string | undefined;
    let routed: Extract<PlaneRouteResult, { plane: "paired" }> | undefined;
    let failure: unknown;
    let tokenRevoked = false;
    /** One live read of the pairing. A read has no side effect, so it is tried again on a network failure or a 5xx, and never on a reply that no schema describes. */
    const readPairing = async (): Promise<RepoPairing> => {
      for (let attempt = 1; ; attempt++) {
        const reply = await deps.client.planePushPairing(runId, leaseGeneration);
        if (reply.kind === "stop") throw new HookStop(reply.reason);
        // A pairing that is gone or edited after the token was granted is `pairing_changed`; nothing in the body is used.
        if (reply.kind === "not_paired" || reply.kind === "pairing_changed") throw coded("pairing_changed", "the pairing changed while the change was being prepared; nothing is pushed");
        if (reply.kind === "error") {
          if ((reply.status === 0 || reply.status >= 500) && attempt < PAIRING_TRIES) {
            await sleep(RETRY_MS * attempt, input.signal);
            continue;
          }
          throw coded("public_unavailable", "the pairing could not be read; nothing is pushed");
        }
        const p = reply.pairing;
        pairingDigest = p.pairing_digest;
        return { enabled: true, codeRepo: p.code_repo, overlayGlobs: [...p.overlay_globs], identifierRulesPath: p.identifier_rules_path, planDataRulesPath: p.plan_data_rules_path };
      }
    };
    let served = 0;
    let firstPairing: RepoPairing;
    try {
      // The pairing is read before anything is built or run: a reply that cannot be believed costs no local work.
      firstPairing = await readPairing();
      ensureRoot(deps.workRoot, deps.uid);
      work = mkdtempSync(path.join(deps.workRoot, "p-"));
      if (!isOwnDirectory(deps.workRoot, work)) throw new Error("work_dir_insecure");
      const repoDir = work;
      // The throwaway repository: created here, so it carries only what `init --bare` writes. The objects come from the mirror by local path.
      await planePushGit(repoDir, ["init", "--bare", "--quiet", "--template="]);
      try {
        await planePushGit(
          repoDir,
          ["-c", "transfer.fsckObjects=true", "fetch", "--no-tags", "--quiet", "--no-write-fetch-head", "--upload-pack=git upload-pack --strict", input.mirrorDir, `${head}:refs/fx/head`, `${base}:refs/fx/base`, "HEAD:refs/fx/default"],
          undefined,
          { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "uploadpack.allowAnySHA1InWant", GIT_CONFIG_VALUE_0: "true" },
        );
      } catch {
        // fx-swallow-ok: replaced by the closed refusal; the tool's text can carry a path
        throw coded("bad_input", "the run's commits could not be read from the mirror");
      }
      try {
        await planePushGit(repoDir, ["merge-base", "--is-ancestor", base, head]);
        await planePushGit(repoDir, ["merge-base", "--is-ancestor", base, "refs/fx/default"]);
      } catch {
        // fx-swallow-ok: replaced by the closed refusal
        throw coded("bad_input", "the recorded start commit is not an ancestor of the run's head, or is not on the default branch");
      }
      let defaultBranch = "main";
      try {
        const named = (await planePushGit(input.mirrorDir, ["symbolic-ref", "--quiet", "--short", "HEAD"])).toString("utf8").trim();
        if (/^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/.test(named)) defaultBranch = named;
      } catch {
        // fx-swallow-ok: the paired route ignores this name; "main" is the answer when the mirror names none
      }

      const loadPairing = async (): Promise<RepoPairing> => {
        served++;
        // The first read was made before anything was built; the route's first read is that one, and its second (at push time) is a new call.
        if (served === 1) {
          await assertRuleFilesUnchanged(repoDir, base, head, firstPairing);
          return firstPairing;
        }
        return readPairing();
      };

      const api: PublicApi = {
        // The token was granted before the route started, so the route's "mint" hands it back. It must be for the repository the pairing names.
        async mintPushToken(codeRepo) {
          if (!sameRepo(codeRepo, grant.code_repo)) throw Object.assign(new Error("token_scope_mismatch"), { code: "token_scope_mismatch" });
          if (Date.parse(grant.expires_at) <= now().getTime() + 30_000) throw Object.assign(new Error("public_unavailable"), { code: "public_unavailable" });
          return token;
        },
        branchExists: (i) => deps.github.branchExists(i),
        openPullRequest: (i) => deps.github.openPullRequest(i),
      };
      let firstTip = true;
      const transport: PublicGitTransport = {
        async fetchTip(dir, codeRepo) {
          const fetched = await deps.transport.fetchTip(dir, codeRepo);
          tip = fetched;
          if (firstTip) {
            firstTip = false;
            // The build and the scan come next. A live state for the item; a failed report never stops the push.
            const told = await report({ phase: "scanning" });
            if (typeof told === "object") {
              // The cloud has ended the run: nothing is built or pushed past this point (the route reads the failure as an unavailable repository).
              stopReason = told.stop;
              throw new HookStop(told.stop);
            }
          }
          return fetched;
        },
        async push(i) {
          await deps.transport.push(i);
          commit = i.commit;
          if (pairingDigest !== undefined && tip !== undefined) {
            const told = await report({ phase: "pushed", branch: i.branch, head_sha: i.commit, tip_sha: tip, pairing_digest: pairingDigest });
            if (typeof told === "object") stopReason = told.stop;
          }
        },
      };
      const route: PlaneRouteInput = {
        repoDir,
        privateBase: base,
        privateHead: head,
        own: { owner: input.repo.owner, name: input.repo.name },
        defaultBranch,
        branch: grant.branch,
        title: grant.pr.title,
        body: grant.pr.body,
        identity: grant.identity,
        commitTime: Math.floor(now().getTime() / 1000),
      };
      const result = await routeAndPush(route, { loadPairing, loadOwn: async () => ({ owner: input.repo.owner, name: input.repo.name }), api, transport });
      if (result.plane === "paired") routed = result;
      else failure = coded("bad_input", "the pairing named no public repository");
    } catch (error) {
      // fx-swallow-ok: the failure is kept and becomes the terminal report's closed code and place below; its text is never sent
      failure = error;
    } finally {
      // The token is revoked whatever happened above, and the throwaway repository is deleted.
      tokenRevoked = await deps.github.revokeToken(token);
      if (work !== undefined && isOwnDirectory(deps.workRoot, work)) {
        try {
          rmSync(work, { recursive: true, force: true });
        } catch {
          // fx-swallow-ok: a leftover is only disk; the next start sweeps the work root
        }
      }
    }

    if (failure instanceof HookStop) stopReason = failure.reason;
    if (stopReason !== undefined) return { kind: "stopped", reason: stopReason };

    // The terminal report. The cloud reads GitHub itself before it records a branch or a pull request, so this is a hint with the facts it checks.
    let told: Awaited<ReturnType<typeof report>>;
    let outcome: PlanePushOutcome;
    if (routed !== undefined && pairingDigest !== undefined) {
      told = await report({ phase: "pr_opened", branch: routed.branch, head_sha: routed.commit, tip_sha: routed.tip, pr_number: routed.number, pairing_digest: pairingDigest, token_revoked: tokenRevoked });
      outcome = { kind: "pr_opened", number: routed.number, seconds: seconds() };
    } else if (failure instanceof PlaneRouteError && failure.code === "no_changes") {
      told = await report({ phase: "no_change", token_revoked: tokenRevoked });
      outcome = { kind: "no_change" };
    } else if (failure instanceof PlaneRouteError && failure.code === "pr_failed" && failure.pushed && commit !== undefined && tip !== undefined && pairingDigest !== undefined) {
      told = await report({ phase: "pr_failed", branch: grant.branch, head_sha: commit, tip_sha: tip, pairing_digest: pairingDigest, token_revoked: tokenRevoked });
      outcome = { kind: "pr_not_opened", seconds: seconds() };
    } else {
      const refusals = failure instanceof PlaneRouteError ? reportRefusals(failure.refusals) : [];
      const code: PlaneRefusalCode = failure instanceof PlaneRouteError ? failure.code : "push_failed";
      told = await report({ phase: "refused", code, ...(refusals.length > 0 ? { refusals } : {}), token_revoked: tokenRevoked });
      outcome = failure instanceof PlaneRouteError ? { kind: "refused", code, seconds: seconds() } : { kind: "failed" };
    }
    if (typeof told === "object") return { kind: "stopped", reason: told.stop };
    return done(outcome);
  };
}
