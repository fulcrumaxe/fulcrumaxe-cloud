/**
 * D#749 V2b: the local half of the post-merge verify stage, put together in one place so the three decisions that depend on the machine's own settings are made the same way:
 *  - which capabilities the hello advertises (`browser_chrome_v1` and `deploy_order_v1`);
 *  - whether a browser job may start now (`browserReady`);
 *  - the deploy order handler the poll loop calls.
 *
 * A capability is advertised ONLY when it is configured AND its check passes now:
 *  - `deploy_order_v1`: `verify.deploy_argv` and `verify.deploy_dir` are set, the engine offers the process-group capture, and the script passes `checkDeployScript` (so an order that would
 *    be refused is never offered to this machine);
 *  - `browser_chrome_v1`: the browser probe passes (browserProbe.ts), which needs `verify.test_account`;
 *  - `browser_playwright_v1`: the playwright probe passes (playwrightProbe.ts): the Chromium executable, the storage-state file (0600, ours, unexpired), the test account and the base URL.
 * The settings are read fresh on every call, so a change applies from the next hello or claim. A cloud that does not know either capability refuses the hello, the runner drops it
 * (client.ts) and `refuse` keeps it out of every later hello.
 */
import { BROWSER_CHROME_CAPABILITY, BROWSER_PLAYWRIGHT_CAPABILITY, DEPLOY_ORDER_CAPABILITY, type BrowserMethod } from "@fulcrumaxe/runner-protocol";
import type { VerifyServerSpec } from "../verifyBrowser/spec.js";
import { parseBase } from "../verifyBrowser/pin.js";
import { playwrightAvailable } from "../verifyBrowser/loadPlaywright.js";
import { probePlaywright, type PlaywrightProbeDeps, type PlaywrightProbeResult } from "./playwrightProbe.js";
import { loadSettings, storageStateFor } from "../runnerSettings.js";
import { probeBrowser, psProcesses, type BrowserProbeDeps, type BrowserProbeResult } from "./browserProbe.js";
import { checkDeployScript, createDeployOrderHandler, runDeployOrder } from "./deployOrder.js";
import type { RunnerClient } from "./client.js";
import type { InstallCapture } from "./engineKit.js";

export interface VerifyLocalDeps {
  stateDir: string;
  uid: number;
  username: string;
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  /** The engine's process-group capture. Absent: this engine cannot run a deploy order, so `deploy_order_v1` is never advertised. */
  capture?: InstallCapture | undefined;
  /** Replaceable so a test can use a directory of its own for the bridge and a process list of its own. */
  probe?: Pick<BrowserProbeDeps, "tmpRoot" | "processes" | "accountLabel">;
  /** D#749 V2c-2b: the user's home directory (the storage-state default and the credential floor are under it). Absent: the playwright method is never offered. */
  home?: string | undefined;
  /** This program's own command (`host.selfCommand`), which the CLI runs as the `fxverify` server. Absent: the playwright method is never offered. */
  selfCommand?: readonly string[] | undefined;
  /** The protection bypass: the path of its file and the registered cloud origin, passed only when the file loaded (run.ts). The verify server is handed the path, never the secret. */
  bypass?: { file: string; cloudOrigin: string } | undefined;
  /** Replaceable by a test: the clock, the library check and the file stat of the playwright probe. */
  playwrightProbe?: Partial<Pick<PlaywrightProbeDeps, "now" | "playwrightAvailable" | "lstat">>;
  signal?: AbortSignal;
  say?: (line: string) => void;
}

export interface VerifyLocal {
  /** The capabilities to add to the hello now, minus any the cloud refused. */
  capabilities(): Promise<Array<typeof BROWSER_CHROME_CAPABILITY | typeof BROWSER_PLAYWRIGHT_CAPABILITY | typeof DEPLOY_ORDER_CAPABILITY>>;
  /** Told the capabilities a cloud refused on the hello; they are not offered again. */
  refuse(dropped: readonly string[]): void;
  /** The closed code to end a browser job with when the probe of its method fails now (no method: the Chrome one); undefined when the job may start. */
  browserReady(method?: BrowserMethod): Promise<string | undefined>;
  /** The playwright probe's answer now, for a message to the person. */
  probePlaywright(): PlaywrightProbeResult;
  /** How the CLI starts the `fxverify` server for a job, from the settings now; undefined when this machine cannot (no home, no program command, no browser or address set). */
  verifyServer(): VerifyServerSpec | undefined;
  /** The browser probe's answer now, for a message to the person. */
  probe(): Promise<BrowserProbeResult>;
  /** The poll loop's deploy order handler; absent when the engine has no process-group capture. */
  deployOrderHandler(client: Pick<RunnerClient, "deployOrderClaim" | "deployOrderReport">): (() => Promise<"handled" | "none">) | undefined;
}

export function createVerifyLocal(deps: VerifyLocalDeps): VerifyLocal {
  const refused = new Set<string>();
  const probe = (): Promise<BrowserProbeResult> =>
    probeBrowser({ testAccount: () => loadSettings(deps.stateDir).verify?.testAccount, uid: deps.uid, username: deps.username, platform: deps.platform, processes: () => (deps.capture === undefined ? Promise.resolve(undefined) : psProcesses(deps.capture, deps.uid, deps.env["PATH"])), ...deps.probe });
  const playwright = (): PlaywrightProbeResult =>
    deps.home === undefined || deps.selfCommand === undefined || deps.platform !== "linux"
      ? { ok: false, reason: "executable_missing" }
      : probePlaywright({ settings: () => loadSettings(deps.stateDir).verify, home: deps.home, uid: deps.uid, now: Date.now, playwrightAvailable, ...deps.playwrightProbe });
  const deployConfigured = (): boolean => {
    const verify = loadSettings(deps.stateDir).verify;
    return deps.capture !== undefined && verify?.deployArgv !== undefined && verify.deployDir !== undefined && checkDeployScript(verify.deployDir, verify.deployArgv, deps.uid).ok;
  };
  return {
    async capabilities() {
      const out: Array<typeof BROWSER_CHROME_CAPABILITY | typeof BROWSER_PLAYWRIGHT_CAPABILITY | typeof DEPLOY_ORDER_CAPABILITY> = [];
      if (!refused.has(BROWSER_CHROME_CAPABILITY) && (await probe()).ok) out.push(BROWSER_CHROME_CAPABILITY);
      if (!refused.has(BROWSER_PLAYWRIGHT_CAPABILITY) && playwright().ok) out.push(BROWSER_PLAYWRIGHT_CAPABILITY);
      if (deployConfigured() && !refused.has(DEPLOY_ORDER_CAPABILITY)) out.push(DEPLOY_ORDER_CAPABILITY);
      return out;
    },
    refuse(dropped) {
      for (const capability of dropped) refused.add(capability);
    },
    // A failed playwright probe ends the claim `runner_setup`: `verify_signin_missing` when the saved sign-in is what is wrong (run `fx-runner verify-login` again), else the same closed code as a
    // failed Chrome one. The probe's own reason (`probePlaywright().reason`) goes to the person's terminal.
    browserReady: async (method) => {
      if (method === "playwright_runner") {
        const checked = playwright();
        if (checked.ok) return undefined;
        deps.say?.(`fx-runner: the verify browser cannot start a job (${checked.reason})`);
        return checked.reason.startsWith("storage_state_") ? "verify_signin_missing" : "browser_not_connected";
      }
      return (await probe()).ok ? undefined : "browser_not_connected";
    },
    probe,
    probePlaywright: playwright,
    verifyServer() {
      const browser = loadSettings(deps.stateDir).verify?.browser;
      const self = deps.selfCommand;
      if (self === undefined || self.length === 0 || browser?.baseUrl === undefined || browser.executable === undefined || deps.home === undefined) return undefined;
      const spec: VerifyServerSpec = { command: self[0]!, args: self.slice(1), baseUrl: browser.baseUrl, executable: browser.executable, storageState: storageStateFor(deps.home, browser) };
      // Only for a base that is the registered cloud origin: the same host the runner's token is already trusted for.
      return deps.bypass !== undefined && parseBase(browser.baseUrl)?.origin === deps.bypass.cloudOrigin ? { ...spec, bypassFile: deps.bypass.file, cloudOrigin: deps.bypass.cloudOrigin } : spec;
    },
    deployOrderHandler(client) {
      const capture = deps.capture;
      if (capture === undefined) return undefined;
      return createDeployOrderHandler({
        client,
        run: (order) => runDeployOrder({ capture, settings: () => loadSettings(deps.stateDir), uid: deps.uid, env: deps.env, ...(deps.signal === undefined ? {} : { signal: deps.signal }) }, order),
        ...(deps.say === undefined ? {} : { say: deps.say }),
      });
    },
  };
}
