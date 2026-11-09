/**
 * D#749 V2b: the runner executes a deploy order. THE CLOUD CAN ONLY SAY "DEPLOY SHA X OF REPOSITORY R" (runner-protocol deployOrder.ts). The command that does it is the machine
 * owner's own: `verify.deploy_argv` and the checkout it runs in, `verify.deploy_dir`, both set on this machine (runnerSettings.ts) and in no message, reply or row.
 *
 * THREAT MODEL. The adversary is a compromised cloud, or hostile content in the repository (a merged change that edits the deploy script, or plants a link where it is). At risk: the
 * machine owner's account, files and deploy credentials. Out of scope: an attacker who can already write the owner's files as the owner (they need no deploy order), and the deploy
 * script's own behaviour once it is the owner's reviewed file. What this file does:
 *  - no shell: the command is an argument vector, started with an explicit environment, never joined into a string and never given to `sh -c`;
 *  - the order contributes exactly two values to the process, the commit and the repository name, and only as environment entries (`FX_DEPLOY_SHA`, `FX_DEPLOY_REPO`) after this
 *    file checked their shape again; neither is ever an argument, a path or part of one;
 *  - the script (argument 1 after a program name, or argument 0 when it is itself a relative path) must be a relative path whose every part, from the checkout down, is looked at with
 *    `lstat`: no link anywhere on the way, a directory for each part but the last and a plain file at the end, owned by this user and not writable by others. Containment is lexical
 *    (no `..`, no absolute path), never `realpath`. The process starts with the script's checked absolute path, so the name that was checked is the name that runs;
 *  - a time limit, and the whole process group is ended (SIGTERM, then SIGKILL) on the limit or when the daemon stops, so nothing the script started outlives it;
 *  - what goes back is the exit status and the last 20 lines of output, each at most 200 characters, redacted of secret shapes and of control characters.
 * Same-user residual: between the check and the start the owner's own account could swap the file; that account can run the deploy itself, so it gains nothing here.
 */
import { lstatSync, type Stats } from "node:fs";
import path from "node:path";
import { MAX_DEPLOY_OUTPUT_LINE_CHARS, MAX_DEPLOY_OUTPUT_TAIL_LINES, redactText, type DeployOrderFailureCode, type DeployOrderReportMessage } from "@fulcrumaxe/runner-protocol";
import type { DeployOrderClaimResult, RunnerClient } from "./client.js";
import type { InstallCapture } from "./engineKit.js";
import type { VerifySettings } from "../runnerSettings.js";

/** The longest a deploy command may run. Under the order's lease (20 minutes), so the report is sent while the order is still this runner's. */
export const DEPLOY_TIMEOUT_MS = 15 * 60_000;
/** How much of the end of the output is kept before it is cut to lines. */
const TAIL_CHARS = 16 * 1024;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
/** Environment entries the command inherits from the daemon: where programs and the owner's own tool logins are found, and nothing else. */
const INHERITED_ENV = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"] as const;
/** A surrogate half with no partner (a cut can leave one at the end of a line). */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const CONTROL = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

export type DeployOutcome = Pick<DeployOrderReportMessage, "result" | "exit_code" | "failure_code" | "output_tail">;

/** The checked script, as the absolute path to run. */
export type ScriptCheck = { ok: true; script: string; scriptIndex: 0 | 1 } | { ok: false };

const refused: ScriptCheck = { ok: false };

function lstatOrNull(target: string): Stats | null {
  try {
    return lstatSync(target);
  } catch {
    // fx-swallow-ok: a part that is not there is a refusal
    return null;
  }
}

/** A directory or file of this user that others cannot write. Never a link (the caller passes an `lstat`). */
const ownPrivate = (stat: { uid: number; mode: number }, uid: number): boolean => stat.uid === uid && (stat.mode & 0o002) === 0;

/**
 * Checks the deploy command against the checkout. `dir` is the owner's configured checkout (an absolute, normalized path that is itself a real directory of this user); the script
 * is looked up by `lstat` part by part below it. Returns the script's absolute path, or a plain refusal (no reason text: a path is not repeated anywhere).
 */
export function checkDeployScript(dir: string, argv: readonly string[], uid: number): ScriptCheck {
  if (argv.length < 1 || !path.isAbsolute(dir) || path.resolve(dir) !== dir) return refused;
  const root = lstatOrNull(dir);
  if (root === null || !root.isDirectory() || !ownPrivate(root, uid)) return refused;
  // argument 0 is the script when it is a path; otherwise it is a program found on the path and argument 1 is the script.
  const scriptIndex = argv[0]!.includes("/") ? 0 : 1;
  const word = argv[scriptIndex];
  if (word === undefined || word.startsWith("-") || word.includes("\0") || word.includes("\\") || path.isAbsolute(word)) return refused;
  if (scriptIndex === 1 && argv[0]!.startsWith("-")) return refused;
  const parts = (word.startsWith("./") ? word.slice(2) : word).split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return refused;
  let current = dir;
  for (const [i, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = lstatOrNull(current);
    if (stat === null || stat.isSymbolicLink() || !ownPrivate(stat, uid)) return refused;
    if (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) return refused;
  }
  const relative = path.relative(dir, current);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return refused;
  return { ok: true, script: current, scriptIndex };
}

/** The last lines of the output as the report carries them: redacted, free of control characters, well-formed, bounded in count and length. */
export function outputTailOf(tail: string): string[] {
  const lines = tail.replace(/\t/g, " ").split(/\r\n|\n|\r/);
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  return lines.slice(-MAX_DEPLOY_OUTPUT_TAIL_LINES).map((line) => redactText(line, []).replace(CONTROL, "").slice(0, MAX_DEPLOY_OUTPUT_LINE_CHARS).replace(LONE_SURROGATE, "\uFFFD"));
}

export interface DeployOrderDeps {
  capture: InstallCapture;
  /** The owner's two local values, read fresh for every order. */
  settings: () => { verify?: VerifySettings | undefined };
  uid: number;
  /** The daemon's environment, of which only `INHERITED_ENV` is passed on. */
  env: Readonly<Record<string, string | undefined>>;
  /** Aborts when the daemon is asked to stop: the group is ended and nothing is reported (the lease lapses and the order can be taken again). */
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface DeployOrder {
  repo: { owner: string; name: string };
  sha: string;
}

const fail = (failure_code: DeployOrderFailureCode, rest: { exit_code?: number; output_tail?: string[] } = {}): DeployOutcome => ({ result: "failed", failure_code, ...rest });

/** Runs the owner's deploy command for one order. Resolves `"aborted"` when the daemon was stopped (nothing is to be reported). Never throws for what the command does. */
export async function runDeployOrder(deps: DeployOrderDeps, order: DeployOrder): Promise<DeployOutcome | "aborted"> {
  const verify = deps.settings().verify;
  if (verify?.deployArgv === undefined || verify.deployDir === undefined) return fail("not_configured");
  // The order's two values are checked again here: a cloud that is wrong or hostile cannot put anything but a commit and a repository name into the environment.
  if (!SHA.test(order.sha) || !OWNER.test(order.repo.owner) || !NAME.test(order.repo.name)) return fail("script_refused");
  const checked = checkDeployScript(verify.deployDir, verify.deployArgv, deps.uid);
  if (!checked.ok) return fail("script_refused");
  const env: Record<string, string> = {};
  for (const key of INHERITED_ENV) {
    const value = deps.env[key];
    if (typeof value === "string" && !value.includes("\0")) env[key] = value;
  }
  env["FX_DEPLOY_SHA"] = order.sha;
  env["FX_DEPLOY_REPO"] = `${order.repo.owner}/${order.repo.name}`;
  const argv = verify.deployArgv;
  const [command, args] = checked.scriptIndex === 0 ? [checked.script, argv.slice(1)] : [argv[0]!, [checked.script, ...argv.slice(2)]];
  const out = await deps.capture(command, args, env, verify.deployDir, deps.timeoutMs ?? DEPLOY_TIMEOUT_MS, TAIL_CHARS, deps.signal, undefined);
  if (out.aborted) return "aborted";
  const output_tail = outputTailOf(out.tail);
  const tail = output_tail.length === 0 ? {} : { output_tail };
  if (out.timedOut) return fail("timeout", tail);
  if (out.code === 0) return { result: "succeeded", exit_code: 0, ...tail };
  // A program that could not start, or was ended by a signal, has no exit status to report.
  if (out.code === null || out.code < 1 || out.code > 255) return fail("spawn_failed", tail);
  return fail("exit_nonzero", { exit_code: out.code, ...tail });
}

export interface DeployOrderHandlerDeps {
  client: Pick<RunnerClient, "deployOrderClaim" | "deployOrderReport">;
  run: (order: DeployOrder) => Promise<DeployOutcome | "aborted">;
  say?: (line: string) => void;
}

/**
 * The poll loop's handler for a claim reply that said a deploy order waits (`deploy_order: true`): claim it, run the owner's command, report. `handled` means an order was taken
 * (the loop claims again at once); `none` means there was nothing (or the cloud could not be asked). One report try, then one more when the first did not get through: a report
 * that is lost lets the lease lapse and the order can be offered again (at most three attempts, the cloud's rule), so nothing is held back.
 */
export function createDeployOrderHandler(deps: DeployOrderHandlerDeps): () => Promise<"handled" | "none"> {
  return async () => {
    const claimed: DeployOrderClaimResult = await deps.client.deployOrderClaim();
    if (claimed.kind !== "order") return "none";
    const { order } = claimed;
    deps.say?.("fx-runner: running the deploy command for a deploy order");
    const outcome = await deps.run({ repo: order.repo, sha: order.sha });
    if (outcome === "aborted") return "handled";
    deps.say?.(`fx-runner: the deploy command ended (${outcome.result}${outcome.failure_code === undefined ? "" : `, ${outcome.failure_code}`})`);
    const message = { order_id: order.order_id, lease_generation: order.lease_generation, ...outcome };
    for (let attempt = 0; attempt < 2; attempt++) {
      const reply = await deps.client.deployOrderReport(message);
      if (reply.kind === "recorded" || reply.kind === "fenced") break;
    }
    return "handled";
  };
}
