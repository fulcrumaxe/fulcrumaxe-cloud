/**
 * D#845 ON-19c: the GitHub sign-in on a managed server, run for the cloud's `gh_login_start` and `gh_logout` machine commands.
 *
 * `gh auth login --web` is started inside util-linux `script` (a pty, MC-8b's way) with a fixed argument vector and prompts off. It prints GitHub's one-time code and the one device address, then waits while the person
 * enters the code on GitHub's own page, so nothing is ever written to it. The runner relays exactly those two values, once, and each only when it matches its exact shape (the protocol's patterns); a link-shaped word that is
 * not the device address ends the sign-in. Everything else the CLI prints, before and after, is dropped as it arrives: no log file, no report, no journal line. The token the CLI saves stays on this machine and is never
 * read here. The sign-in is done when the CLI exits 0. A failure is reported as a short fixed word, never as text the CLI printed. Linux only, managed servers only, one at a time.
 */
import path from "node:path";
import { GH_DEVICE_URL, GH_DEVICE_URL_PATTERN, GH_USER_CODE_PATTERN, type GhLoginReport } from "@fulcrumaxe/runner-protocol";
import { prepareWorkDir, type ClaudeLoginHost, type LoginChild, type Outcome, type ReportResult } from "./claudeLogin.js";

export const GH_LOGIN_ARGS: readonly string[] = Object.freeze(["-q", "-e", "-c", "gh auth login --hostname github.com --web --skip-ssh-key", "/dev/null"]);
export const GH_LOGOUT_ARGS: readonly string[] = Object.freeze(["auth", "logout", "--hostname", "github.com"]);
export const GH_TOKEN_ARGS: readonly string[] = Object.freeze(["auth", "token", "--hostname", "github.com"]);
export const GH_STATUS_LIMIT_MS = 30 * 1000;
export const GH_LOGIN_LIMIT_MS = 10 * 60 * 1000;
export const GH_LINK_LIMIT_MS = 60 * 1000;
export const GH_LOGOUT_LIMIT_MS = 60 * 1000;
/** Its own working directory: the Claude sign-in empties its one before each start, so the two never share it. */
export const GH_LOGIN_CWD_DIR = "gh-login-cwd";
/** What the CLI is told, over the host's fixed environment: no prompt, no update notice, no colour. */
export const GH_LOGIN_ENV = Object.freeze({ GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" });
const UUID_LOWER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONTROL = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|\r/g;

/** What one complete line of the CLI's output relays: the code, the address, `bad` (a link-shaped word that is not the address, or a code that is not an 8-character one), or nothing. */
export function ghRelayOf(line: string): { kind: "code"; code: string } | { kind: "url" } | { kind: "bad" } | undefined {
  const text = line.replace(CONTROL, "").trim();
  const links = text.match(/https?:\/\/\S*/g);
  if (links !== null) return links.every((l) => GH_DEVICE_URL_PATTERN.test(l)) ? { kind: "url" } : { kind: "bad" };
  const code = text.match(/one-time code:\s*(\S+)$/);
  if (code === null) return undefined;
  return GH_USER_CODE_PATTERN.test(code[1]!) ? { kind: "code", code: code[1]! } : { kind: "bad" };
}

export interface GhLoginCloud {
  report(requestId: string, report: GhLoginReport): Promise<ReportResult>;
}
export interface GhLoginRunner {
  start(requestId: string): Promise<Outcome>;
  logout(): Promise<Outcome>;
  idle(): Promise<void>;
}

export function createGhLoginRunner(config: {
  host: ClaudeLoginHost | undefined;
  platform: NodeJS.Platform;
  cloud: GhLoginCloud;
  stateDir: string;
  uid?: number | undefined;
  managed: () => boolean;
  after: (ms: number, fn: () => void) => () => void;
  log: (line: string) => void;
}): GhLoginRunner {
  let busy = false;
  /** The sign-in that is running now: how to end it, and when its process is gone. */
  let active: { requestId: string; end: () => void; exited: Promise<void> } | undefined;
  let ending: Promise<void> = Promise.resolve();
  const workDir = path.join(config.stateDir, GH_LOGIN_CWD_DIR);
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => void config.after(ms, resolve));
  const report = async (requestId: string, body: GhLoginReport): Promise<ReportResult> => {
    let last: ReportResult = { kind: "error" };
    for (let attempt = 0; attempt < 3 && last.kind === "error"; attempt++) {
      if (attempt > 0) await sleep(2000);
      last = await config.cloud.report(requestId, body);
    }
    return last;
  };
  const envFor = (gh: string): Record<string, string> => ({ ...config.host!.env(), ...GH_LOGIN_ENV, PATH: `${path.dirname(gh)}:${config.host!.env()["PATH"] ?? ""}` });
  /** `gh auth logout` for github.com, fixed arguments, the caller holds nothing: it takes the busy flag itself. */
  const signOut = async (): Promise<Outcome> => {
    const host = config.host;
    const gh = host?.locateGh?.();
    if (host === undefined || gh === undefined) return { ok: false, refusal: "failed" };
    busy = true;
    try {
      let child: LoginChild;
      try {
        child = host.launch({ file: gh, args: [...GH_LOGOUT_ARGS], cwd: prepareWorkDir(workDir, config.uid), env: envFor(gh) });
      } catch {
        // fx-swallow-ok: a start that throws is a failed sign-out, in fixed words
        return { ok: false, refusal: "failed" };
      }
      child.onOutput(() => undefined);
      return await new Promise<Outcome>((resolve) => {
        const cancel = config.after(GH_LOGOUT_LIMIT_MS, () => {
          child.kill();
          resolve({ ok: false, refusal: "failed" });
        });
        child.onExit((status) => {
          cancel();
          resolve(status === 0 ? { ok: true } : { ok: false, refusal: "failed" });
        });
      });
    } finally {
      busy = false;
    }
  };

  /** Whether github.com already has an account here, from the exit status of gh auth token alone (read from the stored config, no network; the process is started with every stream ignored, so the token it would print reaches no pipe of ours): 0 present, 1 absent, anything else, a start that fails or no answer in time is `error`. */
  const accountState = async (gh: string): Promise<"present" | "absent" | "error"> => {
    const host = config.host;
    if (host === undefined) return "error";
    let child: LoginChild;
    try {
      child = host.launch({ file: gh, args: [...GH_TOKEN_ARGS], cwd: prepareWorkDir(workDir, config.uid), env: envFor(gh), ignoreStdio: true });
    } catch {
      // fx-swallow-ok: a check that cannot start is "could not be asked", which refuses the sign-in
      return "error";
    }
    child.onOutput(() => undefined);
    return await new Promise((resolve) => {
      const cancel = config.after(GH_STATUS_LIMIT_MS, () => {
        child.kill();
        resolve("error");
      });
      child.onExit((status) => {
        cancel();
        resolve(status === 0 ? "present" : status === 1 ? "absent" : "error");
      });
    });
  };
  /** The fail-safe and the cancel's sign-out say so when it did not work, in fixed words, so the person is told instead of left with an account nobody meant to add. */
  const undo = async (requestId: string): Promise<void> => {
    const out = await signOut();
    if (!out.ok) {
      config.log("fx-runner: the GitHub sign-out did not succeed");
      await report(requestId, { state: "failed", failure_code: "signout_failed" });
    }
  };

  return {
    async start(requestId) {
      if (!UUID_LOWER.test(requestId)) return { ok: false, refusal: "failed" };
      const refuse = async (failure: GhLoginReport["failure_code"] & string, refusal: "unsupported" | "failed" | "busy"): Promise<Outcome> => {
        await report(requestId, { state: "failed", failure_code: failure });
        return { ok: false, refusal };
      };
      const host = config.host;
      if (config.platform !== "linux" || host === undefined) return await refuse("unsupported_platform", "unsupported");
      if (!config.managed()) return await refuse("not_managed", "unsupported");
      if (busy) return await refuse("busy", "busy");
      const gh = host.locateGh?.();
      if (gh === undefined) return await refuse("gh_missing", "failed");
      // One account per machine: a second sign-in would add an account, and a sign-out that names none cannot tell two apart. The check holds the busy flag so nothing else starts meanwhile.
      busy = true;
      const known = await accountState(gh);
      if (known !== "absent") {
        busy = false;
        return await refuse(known === "present" ? "already_signed_in" : "start_failed", "failed");
      }
      let child: LoginChild;
      try {
        child = host.launch({ file: "script", args: [...GH_LOGIN_ARGS], cwd: prepareWorkDir(workDir, config.uid), env: envFor(gh) });
      } catch {
        // fx-swallow-ok: a start that throws (or a working directory that is not safe) is reported in fixed words
        busy = false;
        return await refuse("start_failed", "failed");
      }
      return await new Promise<Outcome>((settleStart) => {
        let pending = "";
        let code: string | undefined;
        let sawUrl = false;
        let relayed = false;
        let finished = false;
        const cancels: Array<() => void> = [];
        const finish = (how: GhLoginReport): void => {
          if (finished) return;
          finished = true;
          for (const cancel of cancels) cancel();
          child.kill();
          busy = false;
          active = undefined;
          settleStart({ ok: false, refusal: "failed" }); // a no-op once the start has settled ok
          const done = report(requestId, how).then(async (r) => {
            if (r.kind !== "recorded") config.log(`fx-runner: the GitHub sign-in report was not taken (${r.kind})`);
            // The cloud no longer takes this sign-in (cancelled or over) but the machine is signed in: undo it, so a code someone else entered leaves nothing behind.
            if (how.state === "done" && r.kind === "refused") await undo(requestId);
          });
          ending = ending.then(() => done);
        };
        const exited = new Promise<void>((resolve) => child.onExit(() => resolve()));
        active = { requestId, end: () => finish({ state: "failed", failure_code: "cancelled" }), exited };
        cancels.push(config.after(GH_LINK_LIMIT_MS, () => (relayed ? undefined : finish({ state: "failed", failure_code: "no_link" }))));
        cancels.push(config.after(GH_LOGIN_LIMIT_MS, () => finish({ state: "failed", failure_code: "timeout" })));
        child.onOutput((text) => {
          if (finished || relayed) return; // after the two values are relayed nothing the CLI prints is looked at, kept or sent
          pending = (pending + text).slice(-8192);
          for (let nl = pending.indexOf("\n"); nl >= 0 && !relayed; nl = pending.indexOf("\n")) {
            const relay = ghRelayOf(pending.slice(0, nl));
            pending = pending.slice(nl + 1);
            if (relay?.kind === "bad") return finish({ state: "failed", failure_code: "bad_link" });
            if (relay?.kind === "code") code = relay.code;
            if (relay?.kind === "url") sawUrl = true;
            if (sawUrl && code !== undefined) {
              relayed = true;
              void report(requestId, { state: "awaiting_code", device_url: GH_DEVICE_URL, user_code: code }).then((r) => {
                if (r.kind === "recorded") settleStart({ ok: true });
                else finish({ state: "failed", failure_code: r.kind === "refused" ? "link_refused" : "link_unsent" });
              });
            }
          }
        });
        child.onExit((status) => finish(relayed && status === 0 ? { state: "done" } : { state: "failed", failure_code: relayed ? "login_failed" : "no_link" }));
      });
    },

    async logout() {
      if (config.platform !== "linux" || config.host === undefined || !config.managed()) return { ok: false, refusal: "unsupported" };
      // A sign-out while a sign-in runs ends that sign-in first (its code must not stay live), then signs out.
      if (active !== undefined) {
        const { end, exited, requestId } = active;
        end();
        await Promise.race([exited, sleep(5000)]);
        if (busy) return { ok: false, refusal: "busy" };
        const out = await signOut();
        if (!out.ok) {
          config.log("fx-runner: the GitHub sign-out did not succeed");
          await report(requestId, { state: "failed", failure_code: "signout_failed" });
        }
        return out;
      }
      if (busy) return { ok: false, refusal: "busy" };
      return await signOut();
    },

    async idle() {
      await ending;
    },
  };
}
