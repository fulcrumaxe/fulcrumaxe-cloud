import { describe, expect, it } from "vitest";
import { ITEM_PR_BRANCH } from "@fulcrumaxe/runner-protocol";
import { parseReceivePackRefUpdates } from "../src/parseReceivePack.js";
import { decideRunner, RUNNER_TICKET_REF_RE, type RunnerRequest } from "../src/runnerPolicy.js";
import { buildReceivePackBody, SHA_A, SHA_B, ZERO_SHA } from "./fixtures.js";

/** D#599 PL-2b-2: a ticket may name the item's own pull request branch (`fx/issue-<n>`), through the one shared constant, and nothing else new. */
const RUN_REF = "fx/0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d-g2";
const ITEM_REF = "fx/issue-7";
const REPO = { owner: "acme", repo: "widgets" };

const pushBody = (updates: { old: string; new: string; ref: string }[]) => parseReceivePackRefUpdates(buildReceivePackBody(updates));
const post = (ticketRef: string, updates: { old: string; new: string; ref: string }[], over: Partial<RunnerRequest> = {}): RunnerRequest => ({
  method: "POST",
  path: "/acme/widgets.git/git-receive-pack",
  role: "executor",
  product: "team",
  installation: REPO,
  ticketRef,
  gitRefUpdates: pushBody(updates),
  ...over,
});

describe("the ticket ref pattern", () => {
  it("takes a run branch and an item pull request branch, and each shape the shared constant refuses stays refused", () => {
    expect(RUNNER_TICKET_REF_RE.test(RUN_REF)).toBe(true);
    expect(RUNNER_TICKET_REF_RE.test(ITEM_REF)).toBe(true);
    for (const ref of ["main", "fx/issue-0", "fx/issue-07", "fx/issue-7/x", "fx/issues-7", "refs/heads/fx/issue-7", "fx/docs/x", "fx/issue-12345678901", "fx/issue-7\n", " fx/issue-7"]) {
      expect(RUNNER_TICKET_REF_RE.test(ref), JSON.stringify(ref)).toBe(false);
    }
  });

  it("accepts an item branch exactly when the one shared constant does (no copy to drift)", () => {
    for (const ref of ["fx/issue-1", "fx/issue-9999999999", "fx/issue-10", "fx/issue-00", "fx/issue-", "fx/issue-1a", "fx/issue-1/", "FX/issue-1"]) {
      expect(RUNNER_TICKET_REF_RE.test(ref) === ITEM_PR_BRANCH.test(ref), ref).toBe(true);
    }
  });
});

describe("decideRunner with an item branch ticket", () => {
  const update = (ref: string, over: Partial<{ old: string; new: string }> = {}) => ({ old: SHA_B, new: SHA_A, ref, ...over });

  it("allows one fast-forward update of refs/heads/fx/issue-7 under a ticket ref of fx/issue-7", () => {
    expect(decideRunner(post(ITEM_REF, [update("refs/heads/fx/issue-7")]))).toMatchObject({ allow: true, reason: "runner_push_allowed" });
  });

  it("denies every other ref under that ticket with its existing closed reason", () => {
    for (const ref of ["refs/heads/main", "refs/heads/fx/issue-8", "refs/heads/fx/issue-7/x", `refs/heads/${RUN_REF}`, "refs/tags/fx/issue-7"]) {
      expect(decideRunner(post(ITEM_REF, [update(ref)])), ref).toEqual({ allow: false, reason: "receive_pack_ref_not_ticket_ref" });
    }
  });

  it("denies two refs and a delete", () => {
    expect(decideRunner(post(ITEM_REF, [update("refs/heads/fx/issue-7"), update("refs/heads/fx/issue-8")]))).toEqual({ allow: false, reason: "receive_pack_not_single_ref" });
    expect(decideRunner(post(ITEM_REF, [update("refs/heads/fx/issue-7", { new: ZERO_SHA })]))).toEqual({ allow: false, reason: "receive_pack_delete_denied" });
  });

  it("a run branch ticket still cannot push the item branch", () => {
    expect(decideRunner(post(RUN_REF, [update("refs/heads/fx/issue-7")]))).toEqual({ allow: false, reason: "receive_pack_ref_not_ticket_ref" });
  });

  it("a ticket ref outside both shapes stays invalid", () => {
    for (const ticketRef of ["fx/issue-07", "fx/issue-7/x", "fx/docs/x", "main"]) {
      expect(decideRunner(post(ticketRef, [update(`refs/heads/${ticketRef}`)]))).toEqual({ allow: false, reason: "runner_ticket_ref_invalid" });
    }
  });
});

describe("a planned PR child's branch (D#483 S5-b2c-3)", () => {
  const CHILD_REF = "fx/41-api";
  const update = (ref: string) => ({ old: SHA_B, new: SHA_A, ref });

  it("the ticket pattern takes it, and refuses the shapes the shared constant refuses", () => {
    expect(RUNNER_TICKET_REF_RE.test(CHILD_REF)).toBe(true);
    for (const ref of ["fx/12-", "fx/12-a/b", "fx/12-..", "fx/12-ABC", `fx/12-${"a".repeat(33)}`, "fx/012-a"]) expect(RUNNER_TICKET_REF_RE.test(ref), ref).toBe(false);
    expect(RUNNER_TICKET_REF_RE.test("fx/12345678-1234-4234-8234-123456789012-g1")).toBe(true);
  });

  it("allows one fast-forward update of the child's own ref, and denies every other ref under that ticket (the parent's branch, a sibling's, another number)", () => {
    expect(decideRunner(post(CHILD_REF, [update("refs/heads/fx/41-api")]))).toMatchObject({ allow: true, reason: "runner_push_allowed" });
    for (const ref of ["refs/heads/fx/issue-41", "refs/heads/fx/41-ui", "refs/heads/fx/42-api", "refs/heads/main", "refs/heads/fx/41-api/x"]) {
      expect(decideRunner(post(CHILD_REF, [update(ref)])), ref).toEqual({ allow: false, reason: "receive_pack_ref_not_ticket_ref" });
    }
  });
});
