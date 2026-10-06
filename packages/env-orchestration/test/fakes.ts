import type { NetworkContext } from "@fx/env-network";
import type { RunCtx, RunSandboxRequest } from "../src/index.js";

export const NET: NetworkContext = { githubForwardHost: "gh-proxy.fx.example", modelProvider: "ai_gateway", vcrHost: "vcr.fx.example" };
export const digest = (c: string): string => `sha256:${c.repeat(64)}`;

export const CTX: RunCtx = { accountId: "acct-1", repoId: "00000000-0000-4000-8000-000000000001", commitSha: "c1", budget: "foreground_compute" };

export function fakeSandbox() {
  const created: RunSandboxRequest[] = [];
  return { created, port: { async create(r: RunSandboxRequest) { created.push(r); return { sandboxName: `rn-${created.length}` }; } } };
}
