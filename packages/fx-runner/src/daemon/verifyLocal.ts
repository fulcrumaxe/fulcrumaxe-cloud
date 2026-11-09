/**
 * D#749 V2b: the local half of the post-merge verify stage, put together in one place so the three decisions that depend on the machine's own settings are made the same way:
 *  - which capabilities the hello advertises (`browser_chrome_v1` and `deploy_order_v1`);
 *  - whether a browser job may start now (`browserReady`);
 *  - the deploy order handler the poll loop calls.
 *
 * A capability is advertised ONLY when it is configured AND its check passes now:
 *  - `deploy_order_v1`: `verify.deploy_argv` and `verify.deploy_dir` are set, the engine offers the process-group capture, and the script passes `checkDeployScript` (so an order that would
 *    be refused is never offered to this machine);
 *  - `browser_chrome_v1`: the browser probe passes (browserProbe.ts), which needs `verify.test_account`.
 * The settings are read fresh on every call, so a change applies from the next hello or claim. A cloud that does not know either capability refuses the hello, the runner drops it
 * (client.ts) and `refuse` keeps it out of every later hello.
 */
import { BROWSER_CHROME_CAPABILITY, DEPLOY_ORDER_CAPABILITY } from "@fulcrumaxe/runner-protocol";
import { loadSettings } from "../runnerSettings.js";
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
  signal?: AbortSignal;
  say?: (line: string) => void;
}

export interface VerifyLocal {
  /** The capabilities to add to the hello now, minus any the cloud refused. */
  capabilities(): Promise<Array<typeof BROWSER_CHROME_CAPABILITY | typeof DEPLOY_ORDER_CAPABILITY>>;
  /** Told the capabilities a cloud refused on the hello; they are not offered again. */
  refuse(dropped: readonly string[]): void;
  /** The closed code to end a browser job with when the probe fails now; undefined when the job may start. */
  browserReady(): Promise<string | undefined>;
  /** The browser probe's answer now, for a message to the person. */
  probe(): Promise<BrowserProbeResult>;
  /** The poll loop's deploy order handler; absent when the engine has no process-group capture. */
  deployOrderHandler(client: Pick<RunnerClient, "deployOrderClaim" | "deployOrderReport">): (() => Promise<"handled" | "none">) | undefined;
}

export function createVerifyLocal(deps: VerifyLocalDeps): VerifyLocal {
  const refused = new Set<string>();
  const probe = (): Promise<BrowserProbeResult> =>
    probeBrowser({ testAccount: () => loadSettings(deps.stateDir).verify?.testAccount, uid: deps.uid, username: deps.username, platform: deps.platform, processes: () => (deps.capture === undefined ? Promise.resolve(undefined) : psProcesses(deps.capture, deps.uid, deps.env["PATH"])), ...deps.probe });
  const deployConfigured = (): boolean => {
    const verify = loadSettings(deps.stateDir).verify;
    return deps.capture !== undefined && verify?.deployArgv !== undefined && verify.deployDir !== undefined && checkDeployScript(verify.deployDir, verify.deployArgv, deps.uid).ok;
  };
  return {
    async capabilities() {
      const out: Array<typeof BROWSER_CHROME_CAPABILITY | typeof DEPLOY_ORDER_CAPABILITY> = [];
      if (!refused.has(BROWSER_CHROME_CAPABILITY) && (await probe()).ok) out.push(BROWSER_CHROME_CAPABILITY);
      if (deployConfigured() && !refused.has(DEPLOY_ORDER_CAPABILITY)) out.push(DEPLOY_ORDER_CAPABILITY);
      return out;
    },
    refuse(dropped) {
      for (const capability of dropped) refused.add(capability);
    },
    browserReady: async () => ((await probe()).ok ? undefined : "browser_not_connected"),
    probe,
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
