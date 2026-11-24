/**
 * D#845 ON-13a1: the network policy of an engine session's guest. The guest starts `deny-all` and is given exactly these six hosts, in force and awaited before it runs anything (as a setup's is):
 *  - `api.anthropic.com`: the model, through the reverse relay (the guest's own subscription credential);
 *  - `github.com`: git smart HTTP only, through the reverse relay and `MICROVM_GIT_ENV`; CONNECT is port 443 only, so there is no SSH;
 *  - `api.github.com`: the CONNECT tunnel `gh` uses (pull requests, issues, Discussions, labels);
 *  - the three package registries, the one constant a setup uses.
 * No rule injects a header and none is `github_proxy`. Not allowed, on purpose: the cloud's origin (the guest talks only to the runner, over vsock), every other GitHub host (`uploads`, `objects`, `raw`,
 * `codeload`, the Actions log hosts), the CLI's telemetry hosts and the sign-in hosts. Both tiers enforce by host, so `api.github.com` cannot be split by repository here; the repository's scope is the
 * credential the guest holds. The standard tier (ON-13a3) passes this same constant, never a copy.
 */
import type { NetworkRule } from "../sandbox/port.js";
import { PROJECT_SETUP_HOSTS } from "../setup/setupPolicy.js";
import { policyOf } from "../vm/sandboxd/microvmSandbox.js";

export const ENGINE_SESSION_NETWORK: readonly NetworkRule[] = Object.freeze(
  [
    { host: "api.anthropic.com", purpose: "model" },
    { host: "github.com", purpose: "github_git" },
    { host: "api.github.com", purpose: "github_api" },
    ...PROJECT_SETUP_HOSTS.map((host) => ({ host, purpose: "package_registry" })),
  ].map((rule) => Object.freeze(rule)),
);

/** The value `updateNetworkPolicy` is given. */
export const engineSessionPolicy = (): unknown => policyOf(ENGINE_SESSION_NETWORK);
