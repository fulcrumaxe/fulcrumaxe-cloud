import { describe, expect, it } from "vitest";
import { decide } from "../src/decide.js";
import { parseReceivePackRefUpdates } from "../src/parseReceivePack.js";
import { decideRunner, type RunnerRequest } from "../src/runnerPolicy.js";
import type { ProxyRequest } from "../src/types.js";
import { buildReceivePackBody, SHA_A, ZERO_SHA } from "./fixtures.js";

/**
 * C44-5 (R-C44-1): the executor and the four review roles hold plain Bash, so a reviewer can write files from the shell. What keeps that harmless is that
 * a reviewer's work is never published. This is the cloud half of that guarantee, for every review role the PR widens: the policy refuses a push at
 * discovery and at the POST (even onto an fx/ branch), a pull request, and a ref create. The same discovery and POST refusals hold through `decideRunner`.
 */
const REVIEW_ROLES = ["code-reviewer", "security-reviewer", "acceptance-tester", "debater"] as const;
const TICKET_REF = "fx/0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d-g2";
const INSTALLATION = { owner: "acme", repo: "widgets" };

const base = (over: Partial<ProxyRequest>): ProxyRequest => ({
  method: "GET",
  host: "api.github.com",
  sniHost: "api.github.com",
  path: "/repos/acme/widgets",
  role: "executor",
  product: "team",
  installation: INSTALLATION,
  ...over,
});
const push = (ref: string) => parseReceivePackRefUpdates(buildReceivePackBody([{ old: ZERO_SHA, new: SHA_A, ref }]));
const runnerReq = (over: Partial<RunnerRequest>): RunnerRequest => ({
  method: "GET",
  path: "/acme/widgets.git/info/refs",
  query: { service: "git-receive-pack" },
  role: "executor",
  product: "team",
  installation: INSTALLATION,
  ticketRef: TICKET_REF,
  ...over,
});

describe("a review role's work is never published: the cloud policy refuses every route to a push", () => {
  it("control: the executor is allowed the same requests, so the refusals below are about the role", () => {
    expect(decide(base({ role: "executor", host: "github.com", sniHost: "github.com", path: "/acme/widgets.git/info/refs", query: { service: "git-receive-pack" } })).allow).toBe(true);
    expect(decide(base({ role: "executor", method: "POST", host: "github.com", sniHost: "github.com", path: "/acme/widgets.git/git-receive-pack", gitRefUpdates: push("refs/heads/fx/H03") })).allow).toBe(true);
    expect(decideRunner(runnerReq({ role: "executor" })).allow).toBe(true);
    expect(decideRunner(runnerReq({ role: "executor", method: "POST", path: "/acme/widgets.git/git-receive-pack", query: undefined, gitRefUpdates: push(`refs/heads/${TICKET_REF}`) })).allow).toBe(true);
  });

  describe.each(REVIEW_ROLES)("%s", (role) => {
    it("decide(): push discovery is refused", () => {
      const d = decide(base({ role, host: "github.com", sniHost: "github.com", path: "/acme/widgets.git/info/refs", query: { service: "git-receive-pack" } }));
      expect(d.allow).toBe(false);
      expect(d.reason).toBe("receive_pack_requires_push_capable_role");
    });

    it("decide(): a receive-pack POST onto refs/heads/fx/... is refused", () => {
      const d = decide(base({ role, method: "POST", host: "github.com", sniHost: "github.com", path: "/acme/widgets.git/git-receive-pack", gitRefUpdates: push("refs/heads/fx/H03") }));
      expect(d.allow).toBe(false);
      expect(d.reason).toBe("receive_pack_requires_push_capable_role");
    });

    it("decide(): POST /pulls and POST /git/refs are refused", () => {
      for (const sub of ["pulls", "git/refs"]) {
        const d = decide(base({ role, method: "POST", path: `/repos/acme/widgets/${sub}` }));
        expect(d.allow, sub).toBe(false);
      }
    });

    it("decideRunner(): push discovery and the receive-pack POST are refused", () => {
      const discovery = decideRunner(runnerReq({ role }));
      expect(discovery).toEqual({ allow: false, reason: "receive_pack_requires_push_capable_role" });
      const post = decideRunner(runnerReq({ role, method: "POST", path: "/acme/widgets.git/git-receive-pack", query: undefined, gitRefUpdates: push(`refs/heads/${TICKET_REF}`) }));
      expect(post).toEqual({ allow: false, reason: "receive_pack_requires_push_capable_role" });
    });
  });
});
