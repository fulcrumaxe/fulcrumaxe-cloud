/**
 * D#845 ON-3: the runner's half of the device flow. The machine makes a key, asks the cloud for a short code (an unsigned request that carries a proof of the key),
 * shows the code, and polls (signed by that key) until the person approves it in the workspace. Only then are the key and the registration saved, so a code that
 * expires, is declined or is cancelled with Ctrl-C leaves nothing behind.
 *
 * What the cloud says is never trusted past its shape: every reply is parsed strictly, the code shown is checked against the code alphabet, the link shown is built
 * here from the origin the person typed, the wait is bounded by this machine's clock, and what is saved goes through the same private-file store `register` uses
 * (fixed file names in the state directory; the one value taken from a reply that reaches a file is a UUID or a fixed word).
 */
import {
  DEVICE_CODE_TTL_SECONDS, DEVICE_POLL_INTERVAL_SECONDS, DEVICE_POLL_PATH, DEVICE_REGISTER_CAPABILITY, DEVICE_START_PATH, DEVICE_USER_CODE_PATTERN, DevicePollMessage, DevicePollResponse,
  DeviceStartMessage, DeviceStartResponse, deviceFlowOffered, signDevicePop, type DeviceFacts,
} from "@fulcrumaxe/runner-protocol";
import { CliError } from "./cliError.js";
import { errorCodeOf, refusalError, signedPost, unsignedPost } from "./cloud.js";
import { KEY_FILE, loadRegistration, removePrivateFile, saveRegistration, withRegisterLock } from "./config.js";
import type { CommandContext, DeviceTerminal } from "./context.js";
import { readHostFacts, readHostname } from "./hostFacts.js";
import { generateRunnerKey, saveRunnerKey, type RunnerKey } from "./keys.js";
import { requireUsable } from "./protectionBypass.js";
import { existingRegistrationError, revokeByKey } from "./registration.js";
import { RUNNER_PROTOCOL_VERSION } from "./version.js";

/** What this build tells the cloud about itself before any registration exists; `deviceFlowOffered` judges it as it judges a hello. A test may pass another list. */
export const DEVICE_FLOW_CAPABILITIES: readonly string[] = [DEVICE_REGISTER_CAPABILITY];
/** The cap on new codes in one run, so a person who keeps pressing Enter (or a loop) cannot hammer the start route. */
export const MAX_DEVICE_CODES = 5;
const MAX_INTERVAL_MS = 60_000;
const MAX_TRANSIENT_FAILURES = 3;
/** A hard cap on polls, whatever the clock says: the code lives 600 s and the interval is 5 s or more. */
const MAX_POLLS = Math.ceil(DEVICE_CODE_TTL_SECONDS / DEVICE_POLL_INTERVAL_SECONDS) + 10;
const HOSTNAME_FACT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
/** The row's own words for an expired code and for Ctrl-C alike (ON-3 criterion 2). */
const RERUN_WORDS = "The code expired. Run `fx-runner setup` again";
const CANCELLED = (): CliError => new CliError(RERUN_WORDS, 130);
const EXPIRED = (): CliError => new CliError(RERUN_WORDS);
/** The longest the final poll after Ctrl-C waits for the poll interval to pass (the cloud answers a poll made sooner with 429). */
const MAX_FINAL_WAIT_MS = 5_000;

export interface DeviceRegisterOptions {
  origin: string;
  /** Whether `/dev/kvm` is there, as a fact for the approval page; undefined when this caller did not look (it is then reported as absent). */
  kvm: boolean | undefined;
  /** What this build says it can do; the device flow is never started for a list without `device_register_v1`. */
  capabilities?: readonly string[] | undefined;
}
export interface DeviceRegistered {
  runnerId: string;
  /** The account the machine joined, as the cloud's approval reply gives it (an id: the reply carries no name). */
  accountId: string;
  mode: string;
}

function factsOf(ctx: CommandContext, kvm: boolean | undefined): DeviceFacts {
  const host = readHostFacts();
  if (host === undefined) throw new CliError("this machine is not one the runner supports; setup works on Linux and macOS, on x64 and arm64");
  const hostname = ctx.hostname ?? readHostname();
  return { ...(HOSTNAME_FACT.test(hostname) ? { hostname } : {}), os: host.os, arch: host.arch, kvm: kvm === true };
}

interface Started {
  deviceCode: string;
  userCode: string;
  /** Epoch ms: the code's own expiry, but never later than this machine's own ceiling. */
  deadline: number;
}

async function startCode(ctx: CommandContext, origin: string, key: RunnerKey, facts: DeviceFacts): Promise<Started> {
  const now = ctx.now();
  const pop = signDevicePop(key.privateKey, { origin, path: DEVICE_START_PATH, iat: Math.floor(now.getTime() / 1000) });
  const body = DeviceStartMessage.parse({ public_key_jwk: key.publicJwk, pop, facts });
  const reply = await unsignedPost({ origin, path: DEVICE_START_PATH, body, fetchFn: ctx.fetchFn, bypass: requireUsable(ctx.bypass) });
  if (reply.status !== 201) throw refusalError(reply);
  const parsed = DeviceStartResponse.safeParse(reply.body);
  const expires = parsed.success ? Date.parse(parsed.data.expires_at) : Number.NaN;
  let link: URL | undefined;
  try {
    link = parsed.success ? new URL(parsed.data.verification_uri) : undefined;
  } catch {
    // fx-swallow-ok: an address that does not parse is refused with the fixed words below
    link = undefined;
  }
  if (!parsed.success || link?.origin !== origin || link.pathname !== "/link" || !DEVICE_USER_CODE_PATTERN.test(parsed.data.user_code) || Number.isNaN(expires)) {
    throw new CliError("the cloud's reply was not understood; update fx-runner and try again");
  }
  const deadline = Math.min(expires, now.getTime() + DEVICE_CODE_TTL_SECONDS * 1000);
  if (deadline <= now.getTime()) throw new CliError("the cloud's reply was not understood; update fx-runner and try again");
  return { deviceCode: parsed.data.device_code, userCode: parsed.data.user_code, deadline };
}

type Approved = { kind: "approved"; runnerId: string; accountId: string; mode: "subscription" | "api_key" };
type Outcome = Approved | { kind: "expired" };
const approvedOf = (r: { runner_id: string; account_id: string; credential_mode: "subscription" | "api_key" }): Approved => ({ kind: "approved", runnerId: r.runner_id, accountId: r.account_id, mode: r.credential_mode });

/** One code's run: set once its revoke has been sent, so a round never sends two. */
interface Round {
  ended: boolean;
}
const LEFT_REVOKED = "A runner this code created was revoked.";

/**
 * Once a round's start has succeeded, every way the round ends without a kept registration sends one best-effort signed revoke with that round's key: the cloud makes the
 * runner when the person approves, whether or not this machine ever sees the approved reply. A 401 means nothing was made, and says nothing. True when a runner was revoked.
 */
async function endRound(ctx: CommandContext, origin: string, key: RunnerKey, round: Round): Promise<boolean> {
  if (round.ended) return false;
  round.ended = true;
  return (await revokeByKey(origin, key, ctx, "setup ended before the registration was kept")) === "revoked";
}

/**
 * An approved reply is in hand: the runner exists. Every failure after that undoes it with the key still in memory (the same signed revoke the raced branch always used)
 * and removes a key file this run wrote. The message names the runner id: revoked, or, when the revoke itself failed, the one left for the person to revoke in the workspace.
 */
async function undoApproved(ctx: CommandContext, origin: string, key: RunnerKey, approved: Approved, headline: string, exitCode: number | undefined, wroteKey: boolean, round: Round): Promise<never> {
  round.ended = true;
  const revoked = (await revokeByKey(origin, key, ctx, "setup could not finish after the code was approved")) === "revoked";
  let note = "";
  if (wroteKey) {
    try {
      removePrivateFile(ctx.stateDir, KEY_FILE);
    } catch {
      // fx-swallow-ok: only the message matters now (the runner is already revoked); a key file that cannot be removed is named so the person can remove it
      note = ` The key file ${ctx.stateDir}/${KEY_FILE} could not be removed; remove it yourself.`;
    }
  }
  const tail = revoked ? `Runner ${approved.runnerId} was approved and has been revoked; nothing was kept.` : `Runner ${approved.runnerId} was approved but could not be revoked from here: revoke it on the runner screen in the workspace.`;
  throw new CliError(`${headline}. ${tail}${note}`, exitCode);
}

/** Saves the approved runner's key and registration under the register lock; on any failure the runner is revoked and the key file removed (see undoApproved). */
async function keepApproved(ctx: CommandContext, origin: string, key: RunnerKey, approved: Approved, signal: AbortSignal, round: Round): Promise<DeviceRegistered> {
  if (signal.aborted) return undoApproved(ctx, origin, key, approved, RERUN_WORDS, 130, false, round);
  let wroteKey = false;
  let problem: string;
  try {
    return await withRegisterLock(ctx.stateDir, ctx.now, async () => {
      const raced = loadRegistration(ctx.stateDir);
      if (raced) throw new CliError(`${existingRegistrationError(raced).message} (it registered while this code was being approved)`);
      saveRunnerKey(ctx.stateDir, key);
      wroteKey = true;
      saveRegistration(ctx.stateDir, { version: 1, cloud_origin: origin, runner_id: approved.runnerId, account_id: approved.accountId, credential_mode: approved.mode, jkt: key.jkt, registered_at: ctx.now().toISOString() });
      return { runnerId: approved.runnerId, accountId: approved.accountId, mode: approved.mode };
    });
  } catch (error) {
    // fx-swallow-ok: the failure is reported below, with the runner it left, once the runner is revoked; only a CliError's fixed words are shown
    problem = error instanceof CliError ? error.message : `the key could not be saved under ${ctx.stateDir}`;
  }
  return undoApproved(ctx, origin, key, approved, problem, undefined, wroteKey, round);
}

/** Polls until the person decides, the code ends or this machine's own deadline passes. 429 (`slow_down` or any other) slows the poll; a few failed attempts in a row end it. */
async function pollCode(ctx: CommandContext, origin: string, key: RunnerKey, started: Started, signal: AbortSignal): Promise<Outcome> {
  let interval = DEVICE_POLL_INTERVAL_SECONDS * 1000;
  let failures = 0;
  let lastPollAt = Number.NEGATIVE_INFINITY;
  const wait = (ms: number): Promise<void> =>
    new Promise((resolve, reject) => {
      if (signal.aborted) return reject(CANCELLED());
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(CANCELLED());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      const done = (): void => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      if (ctx.sleep !== undefined) void ctx.sleep(ms).then(done, reject);
      else timer = setTimeout(done, ms);
    });
  /** Ctrl-C landed while waiting between polls: the person may have approved in that time, so one last poll (after the interval, so it is not refused as too soon) learns it, and the caller undoes it. */
  const finalPoll = async (): Promise<Outcome> => {
    const remaining = Math.min(lastPollAt + interval - ctx.now().getTime(), MAX_FINAL_WAIT_MS);
    if (remaining > 0) await (ctx.sleep !== undefined ? ctx.sleep(remaining) : new Promise<void>((resolve) => setTimeout(resolve, remaining)));
    try {
      const reply = await signedPost({ origin, path: DEVICE_POLL_PATH, body: DevicePollMessage.parse({ device_code: started.deviceCode }), key, now: ctx.now(), fetchFn: ctx.fetchFn, bypass: requireUsable(ctx.bypass) });
      const parsed = reply.status === 200 ? DevicePollResponse.safeParse(reply.body) : undefined;
      if (parsed?.success && parsed.data.status === "approved") return approvedOf(parsed.data.registration);
    } catch {
      // fx-swallow-ok: a poll that fails after Ctrl-C changes nothing: the person is told to run setup again, and a code nobody approved ends by itself
    }
    throw CANCELLED();
  };
  for (let poll = 0; poll < MAX_POLLS; poll++) {
    try {
      await wait(interval);
    } catch (error) {
      if (signal.aborted) return finalPoll();
      throw error;
    }
    if (ctx.now().getTime() >= started.deadline) return { kind: "expired" };
    let reply;
    lastPollAt = ctx.now().getTime();
    try {
      reply = await signedPost({ origin, path: DEVICE_POLL_PATH, body: DevicePollMessage.parse({ device_code: started.deviceCode }), key, now: ctx.now(), fetchFn: ctx.fetchFn, bypass: requireUsable(ctx.bypass) });
    } catch (error) {
      if (!(error instanceof CliError) || ++failures > MAX_TRANSIENT_FAILURES) throw error;
      continue;
    }
    const answer = reply.status === 200 ? DevicePollResponse.safeParse(reply.body) : undefined;
    const approved = answer?.success === true && answer.data.status === "approved";
    // A reply that says approved is never dropped for a Ctrl-C that landed while it was in flight: the runner exists, so the caller revokes it.
    if (signal.aborted && !approved) throw CANCELLED();
    if (reply.status === 429) {
      interval = Math.min(interval + DEVICE_POLL_INTERVAL_SECONDS * 1000, MAX_INTERVAL_MS);
      continue;
    }
    if (reply.status >= 500 && ++failures <= MAX_TRANSIENT_FAILURES) continue;
    if (reply.status === 410) {
      const code = errorCodeOf(reply.body);
      if (code === "denied") throw new CliError("The machine was declined in the workspace. Nothing was stored");
      if (code === "consumed") throw new CliError("That code was already used. Run `fx-runner setup` again");
      return { kind: "expired" };
    }
    if (answer === undefined) throw refusalError(reply);
    if (!answer.success) throw new CliError("the cloud's reply was not understood; update fx-runner and try again");
    failures = 0;
    if (answer.data.status === "approved") return approvedOf(answer.data.registration);
  }
  return { kind: "expired" };
}

/**
 * Registers this machine through the device flow and saves the key and the registration. Refuses, sending nothing, when this build cannot offer the flow or the
 * machine already holds a registration. On expiry it asks once on the terminal for Enter and starts again with no re-run; Ctrl-C or any other answer ends it.
 */
export async function deviceRegister(ctx: CommandContext, options: DeviceRegisterOptions): Promise<DeviceRegistered> {
  if (ctx.terminal === undefined) throw new CliError("this command is only available from the fx-runner program");
  const terminal = ctx.terminal;
  if (!deviceFlowOffered({ protocol_version: RUNNER_PROTOCOL_VERSION, capabilities: options.capabilities ?? DEVICE_FLOW_CAPABILITIES })) {
    throw new CliError("this fx-runner cannot register through the device flow; update fx-runner, or register with a code (fx-runner register --code-stdin)");
  }
  const held = loadRegistration(ctx.stateDir);
  if (held) throw existingRegistrationError(held);
  const signal = terminal.signal();
  try {
    return await deviceRounds(ctx, options, terminal, signal);
  } finally {
    // The Ctrl-C listener is gone before the caller starts the service, so a later Ctrl-C has its ordinary meaning.
    terminal.release?.();
  }
}

async function deviceRounds(ctx: CommandContext, options: DeviceRegisterOptions, terminal: DeviceTerminal, signal: AbortSignal): Promise<DeviceRegistered> {
  const { origin } = options;
  const facts = factsOf(ctx, options.kvm);
  // Before the cloud is asked for anything: a state directory or a register lock that would refuse the save later is refused now, when nothing exists to undo.
  await withRegisterLock(ctx.stateDir, ctx.now, async () => undefined);

  for (let round = 0; round < MAX_DEVICE_CODES; round++) {
    // A fresh key for each code: a key whose code ended is never reused, and none is saved until the person approves.
    const key = generateRunnerKey();
    const started = await startCode(ctx, origin, key, facts);
    ctx.out(`Your code: ${started.userCode}`);
    ctx.out(`Open ${origin}/link and type the code there while you are signed in. Press Ctrl-C to cancel.`);
    const round: Round = { ended: false };
    try {
      const outcome = await pollCode(ctx, origin, key, started, signal);
      if (outcome.kind === "approved") return await keepApproved(ctx, origin, key, outcome, signal, round);
    } catch (error) {
      const revoked = await endRound(ctx, origin, key, round);
      throw revoked && error instanceof CliError ? new CliError(`${error.message}. ${LEFT_REVOKED}`, error.exitCode) : error;
    }
    // The code ended with no registration kept. A person may have approved in its last seconds, which this machine's own clock never polled for.
    if (await endRound(ctx, origin, key, round)) ctx.out(`The code was approved as it ended. ${LEFT_REVOKED}`);
    ctx.out("The code expired. Press Enter for a new code");
    const answer = await terminal.askEnter("> ", signal);
    if (signal.aborted) throw CANCELLED();
    if (answer === undefined || answer.trim() !== "") throw EXPIRED();
  }
  throw EXPIRED();
}
