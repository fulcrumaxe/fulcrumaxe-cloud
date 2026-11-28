import { describe, expect, it, vi } from "vitest";
import { RunPullRequestError, type SetupFinishPort, type SetupInstallPort } from "@fx/runner-cloud";
import { setupFinishStep, setupInstallStep, type ReconcileHandlerDeps } from "../app/api/cron/reconcile/handler";
import { drainInstallPr, drainSetupFinish, finishNow, installPrNow, HANDOFF_MAX_SETUPS, type HandoffDeps } from "../lib/onboardingHandoff";

/**
 * D#845 Ruling 122: the hand-offs a person waits on act right after the request or webhook, with the tick as the backstop. This is the app side: the same steps the tick runs, over a fake pool (the claim rows) and a fake GitHub
 * port, with the after-response keep-alive recorded. The claim lease, the race and the real definers are the runner-cloud pg suite's.
 */
const SHA = "c".repeat(40);
const INSTALL_ROW = { o_account: "a1", o_setup: "s1", o_repo: "r1", o_user: "u1", o_attempt: 1, o_mode: "pr", o_base: "a".repeat(40), o_branch: "fx/engine-install-1.2.3", o_head: SHA, o_version: "1.2.3", o_owner: "acme", o_name: "widgets" };
const FINISH_ROW = { o_account: "a1", o_setup: "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e", o_repo: "r1", o_attempt: 1, o_owner: "acme", o_name: "widgets", o_roadmap: [], o_seeded: [], o_claim_at: "2026-11-27 21:15:42.123456+00" };

/** A fake of the platform_ops pool: each claim function answers its queue of rows (one per call), the recording definers answer ok. */
function fakePool(queues: { install?: unknown[]; finish?: unknown[] }) {
  const install = [...(queues.install ?? [])];
  const finish = [...(queues.finish ?? [])];
  const sql: string[] = [];
  const args: Array<{ text: string; args: unknown[] | undefined }> = [];
  return {
    sql,
    args,
    pool: {
      query: vi.fn(async (text: string, a?: unknown[]) => {
        sql.push(text);
        args.push({ text, args: a });
        if (text.includes("setup_install_pr_claim")) return { rows: install.length > 0 ? [install.shift()] : [] };
        if (text.includes("setup_finish_claim")) return { rows: finish.length > 0 ? [finish.shift()] : [] };
        if (text.includes("engine_update_pr_claim")) return { rows: [] };
        return { rows: [{ ok: true, r: "done" }] };
      }),
    },
  };
}

function githubPort(over: Partial<SetupInstallPort> = {}) {
  const opened: string[] = [];
  const port = {
    defaultBranch: async () => "main",
    branchState: async () => ({ exists: true, headOid: SHA }),
    commitParents: async () => ["a".repeat(40)],
    ensureLabels: async () => undefined,
    openDraft: async ({ branch }: { branch: string }) => {
      opened.push(branch);
      return { number: 7, headSha: SHA };
    },
    changedFiles: async () => ({ complete: true, files: [{ path: ".fulcrumaxe/engine.json" }] }),
    markReady: async () => undefined,
    close: async () => undefined,
    ...over,
  } as unknown as SetupInstallPort;
  return { port, opened };
}

function rig(pool: unknown, extra: Partial<ReconcileHandlerDeps> = {}) {
  const kept: Array<Promise<unknown>> = [];
  const errors: Array<{ err: unknown; stage: string }> = [];
  const reconcile = { platformOpsPool: pool, reportError: vi.fn(), ...extra } as unknown as ReconcileHandlerDeps;
  const deps: HandoffDeps = {
    reconcile: async () => reconcile,
    steps: async () => ({ setupInstallStep, setupFinishStep }),
    keepAlive: (work) => void kept.push(work),
    reportError: (err, ctx) => void errors.push({ err, stage: ctx.stage }),
  };
  return { deps, kept, errors, reconcile };
}

describe("the install pull request, right after a push ok report", () => {
  it("installPrNow hands one pass to the after-response keep-alive and returns at once", async () => {
    const { pool } = fakePool({ install: [INSTALL_ROW] });
    const gh = githubPort();
    const { deps, kept } = rig(pool, { setupInstallPort: () => gh.port });
    installPrNow(deps);
    expect(kept).toHaveLength(1);
    await Promise.all(kept);
    expect(gh.opened).toEqual(["fx/engine-install-1.2.3"]);
  });

  it("opens the pull request with no tick, through the same claim and completion, and records it", async () => {
    const { pool, sql } = fakePool({ install: [INSTALL_ROW] });
    const gh = githubPort();
    const { deps, errors } = rig(pool, { setupInstallPort: () => gh.port });
    await drainInstallPr(deps);
    expect(gh.opened).toHaveLength(1);
    expect(sql.some((s) => s.includes("setup_install_pr_record"))).toBe(true);
    expect(errors).toEqual([]);
  });

  it("does nothing, and builds no GitHub client, when nothing is due", async () => {
    const { pool } = fakePool({});
    const port = vi.fn();
    const { deps } = rig(pool, { setupInstallPort: port as never });
    await drainInstallPr(deps);
    expect(port).not.toHaveBeenCalled();
  });

  it("takes several due setups one after another, and stops at the pass limit (the tick does the rest)", async () => {
    const rows = Array.from({ length: HANDOFF_MAX_SETUPS + 3 }, (_, i) => ({ ...INSTALL_ROW, o_setup: `s${i}` }));
    const { pool } = fakePool({ install: rows });
    const gh = githubPort();
    const { deps } = rig(pool, { setupInstallPort: () => gh.port });
    await drainInstallPr(deps);
    expect(gh.opened).toHaveLength(HANDOFF_MAX_SETUPS);
  });

  it("stops at once when GitHub cannot be asked: the claim is left for the tick (its lease lapses), and nothing is thrown", async () => {
    const { pool, sql } = fakePool({ install: [INSTALL_ROW, { ...INSTALL_ROW, o_setup: "s2" }] });
    const { RunPullRequestError } = await import("@fx/runner-cloud");
    const gh = githubPort({ defaultBranch: async () => { throw new RunPullRequestError("unavailable", 502); } });
    const { deps, errors } = rig(pool, { setupInstallPort: () => gh.port });
    await expect(drainInstallPr(deps)).resolves.toBeUndefined();
    expect(sql.filter((s) => s.includes("setup_install_pr_claim"))).toHaveLength(1);
    expect(sql.some((s) => s.includes("setup_install_pr_record") || s.includes("setup_install_pr_fail"))).toBe(false);
    expect(errors).toEqual([]);
  });

  it("a database failure inside the pass is reported by stage and never thrown into the request", async () => {
    const boom = new Error("database down");
    const { deps, errors } = rig({ query: async () => { throw boom; } });
    await expect(drainInstallPr(deps)).resolves.toBeUndefined();
    expect(errors).toEqual([{ err: boom, stage: "onboarding.handoff_install_pr" }]);
  });

  it("deps that cannot be built (no platform_ops login configured) are reported and the tick stays the backstop", async () => {
    const { deps, errors } = rig(fakePool({}).pool);
    const broken: HandoffDeps = { ...deps, reconcile: async () => { throw new Error("DATABASE_URL_PLATFORM_OPS must be set"); } };
    await expect(drainInstallPr(broken)).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });
});

describe("the finish, right after the install pull request merged", () => {
  const finishPort = () => ({ findTeamLog: async () => 3, installPullRequest: async () => null, discussionTarget: async () => null }) as unknown as SetupFinishPort;

  it("finishNow keeps one pass alive past the response", async () => {
    const { pool } = fakePool({});
    const { deps, kept } = rig(pool);
    finishNow(deps);
    expect(kept).toHaveLength(1);
    await Promise.all(kept);
  });

  it("claims the due setup, and after a finish starts the first sessions it made due", async () => {
    const { pool, sql } = fakePool({ finish: [FINISH_ROW] });
    const starts = vi.fn(async (_scope: { msLeft: () => number }) => ({ not_configured: false, issued: 1, results: [] }));
    const { deps } = rig(pool, { setupFinishPort: finishPort, engineSystemStarts: starts });
    await drainSetupFinish(deps);
    expect(sql.some((s) => s.includes("setup_finish_claim"))).toBe(true);
    expect(starts).toHaveBeenCalledOnce();
    expect(starts.mock.calls[0]![0].msLeft()).toBeGreaterThan(0);
  });

  it("starts nothing when no setup was due", async () => {
    const { pool } = fakePool({});
    const starts = vi.fn();
    const { deps } = rig(pool, { setupFinishPort: finishPort, engineSystemStarts: starts as never });
    await drainSetupFinish(deps);
    expect(starts).not.toHaveBeenCalled();
  });

  it("a failing start pass is reported and never thrown; the finish already recorded stays", async () => {
    const { pool } = fakePool({ finish: [FINISH_ROW] });
    const boom = new Error("signer down");
    const { deps, errors } = rig(pool, { setupFinishPort: finishPort, engineSystemStarts: async () => { throw boom; } });
    await expect(drainSetupFinish(deps)).resolves.toBeUndefined();
    expect(errors).toEqual([{ err: boom, stage: "onboarding.handoff_finish" }]);
  });

  it("the webhook's pass and the merge route's pass together finish a setup once: the second finds the claim taken", async () => {
    const { pool } = fakePool({ finish: [FINISH_ROW] });
    const starts = vi.fn(async (_scope: { msLeft: () => number }) => ({ not_configured: false, issued: 1, results: [] }));
    const { deps, kept } = rig(pool, { setupFinishPort: finishPort, engineSystemStarts: starts });
    finishNow(deps); // the merge route's hand-off
    finishNow(deps); // the webhook's hand-off
    await Promise.all(kept);
    expect(kept).toHaveLength(2);
    expect(starts).toHaveBeenCalledOnce();
  });

  it("a pass whose GitHub call fails releases its claim so the next pass retries at once: it is reported, never thrown, and starts nothing", async () => {
    const { pool, sql } = fakePool({ finish: [FINISH_ROW] });
    const boom = new Error("github down");
    const starts = vi.fn();
    const port = () => ({ findTeamLog: async () => { throw boom; }, installPullRequest: async () => null, discussionTarget: async () => null }) as unknown as SetupFinishPort;
    const { deps, errors } = rig(pool, { setupFinishPort: port, engineSystemStarts: starts as never });
    await expect(drainSetupFinish(deps)).resolves.toBeUndefined();
    expect(errors).toEqual([{ err: boom, stage: "onboarding.handoff_finish" }]);
    expect(starts).not.toHaveBeenCalled();
    expect(sql.some((q) => q.includes("setup_finish_complete"))).toBe(false);
    expect(sql.filter((q) => q.includes("setup_finish_release"))).toHaveLength(1);
  });

  it("a pass that could not reach GitHub (a retry) also releases its claim, and stops without finishing", async () => {
    const { pool: base, sql, args } = fakePool({ finish: [FINISH_ROW] });
    // the definer counts the failed pass and answers `retry` (the first of 24)
    const pool = { query: vi.fn(async (text: string, args?: unknown[]) => (text.includes("setup_finish_retry") ? (sql.push(text), { rows: [{ r: "retry" }] }) : (base.query as (t: string, a?: unknown[]) => Promise<unknown>)(text, args))) };
    const port = () => ({ findTeamLog: async () => { throw new RunPullRequestError("unavailable", 502); }, createTeamLog: async () => 1, installPullRequest: async () => null, discussionTarget: async () => null }) as unknown as SetupFinishPort;
    const starts = vi.fn();
    const { deps, errors } = rig(pool, { setupFinishPort: port, engineSystemStarts: starts as never });
    await drainSetupFinish(deps);
    expect(errors).toEqual([]);
    expect(sql.filter((q) => q.includes("setup_finish_retry"))).toHaveLength(1);
    expect(sql.filter((q) => q.includes("setup_finish_release"))).toHaveLength(1);
    expect(args.find((c) => c.text.includes("setup_finish_release"))?.args).toEqual([FINISH_ROW.o_setup, 1, FINISH_ROW.o_claim_at]);
    expect(starts).not.toHaveBeenCalled();
  });

  it("an immediate pass for one setup claims that setup alone; the tick's step and the webhook's pass name none", async () => {
    const setup = FINISH_ROW.o_setup;
    const named = fakePool({ finish: [FINISH_ROW] });
    await drainSetupFinish(rig(named.pool, { setupFinishPort: finishPort }).deps, setup);
    expect(named.args.filter((c) => c.text.includes("setup_finish_claim")).every((c) => c.args?.[0] === setup)).toBe(true);
    const open = fakePool({ finish: [FINISH_ROW] });
    await drainSetupFinish(rig(open.pool, { setupFinishPort: finishPort }).deps);
    expect(open.args.find((c) => c.text.includes("setup_finish_claim"))?.args).toEqual([null]);
    const kept: Array<Promise<unknown>> = [];
    const viaNow = fakePool({ finish: [FINISH_ROW] });
    const r = rig(viaNow.pool, { setupFinishPort: finishPort });
    finishNow({ ...r.deps, keepAlive: (w) => void kept.push(w) }, setup);
    await Promise.all(kept);
    expect(viaNow.args.find((c) => c.text.includes("setup_finish_claim"))?.args).toEqual([setup]);
  });

  it("the tick's own step keeps the lease when it fails: it releases nothing", async () => {
    const { pool, sql } = fakePool({ finish: [FINISH_ROW] });
    const port = () => ({ findTeamLog: async () => { throw new Error("github down"); }, installPullRequest: async () => null, discussionTarget: async () => null }) as unknown as SetupFinishPort;
    const { reconcile } = rig(pool, { setupFinishPort: port });
    await expect(setupFinishStep(reconcile)(pool as never)).rejects.toThrow("github down");
    expect(sql.some((q) => q.includes("setup_finish_release"))).toBe(false);
  });

  it("the tick's own step finishes a merged setup with no webhook and no merge-route hand-off", async () => {
    const { pool, sql } = fakePool({ finish: [FINISH_ROW] });
    const { reconcile } = rig(pool, { setupFinishPort: finishPort });
    expect(await setupFinishStep(reconcile)(pool as never)).toBe("done");
    expect(sql.some((q) => q.includes("setup_finish_complete"))).toBe(true);
  });

  it("logs one coded line per pass, telling a pass that found nothing from one that finished a setup", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((l: unknown) => void lines.push(String(l)));
    try {
      await drainSetupFinish(rig(fakePool({ finish: [FINISH_ROW] }).pool, { setupFinishPort: finishPort }).deps);
      await drainSetupFinish(rig(fakePool({}).pool, { setupFinishPort: finishPort }).deps);
    } finally {
      spy.mockRestore();
    }
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { event: "onboarding.finish_pass", finished: 1, stopped: "none" },
      { event: "onboarding.finish_pass", finished: 0, stopped: "none" },
    ]);
  });
});
