import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setPendingHooks, runnerWorkKeyFor } from "@fx/core/src/pendingWork.js";
import { seedF2, type F2Fixture } from "@fx/db/test/helpers/members.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { REGISTER_PATH, applyRunnerSetting, registerRunner, setExecutionMode, setRunnerRepos } from "../src/index.js";
import { harness, insertCode, newKey, respond, signed, type Harness } from "./helpers.js";

/**
 * [pg] The runner-work hint (a no-DB per-account epoch) is written after the commit by each session route that makes
 * runner work claimable: resume (which also ends a pause and a drain), a runner's repository set, and a move onto a runner mode.
 * Routes that do not make work claimable (pause, drain, rename) and routes that refuse leave no key.
 */
describe("runner-work hint from the session routes [pg]", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  const entries = new Map<string, number>();
  let failWrites = false;
  const logs: string[] = [];
  beforeEach(() => {
    entries.clear();
    failWrites = false;
    logs.length = 0;
    vi.spyOn(console, "log").mockImplementation((line: unknown) => void logs.push(String(line)));
    setPendingHooks({
      store: {
        get: async (key) => entries.get(key) ?? null,
        set: async (key, value) => {
          if (failWrites) throw new Error("cache down");
          entries.set(key, value);
        },
        delete: async (key) => void entries.delete(key),
      },
    });
  });
  afterEach(() => {
    setPendingHooks(null);
    vi.restoreAllMocks();
  });

  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  const fresh = (): Promise<F2Fixture> => seedF2(h.admin);
  const act = (f: F2Fixture, id: string, action: "pause" | "drain" | "resume" | "rename", body: unknown = null) =>
    respond(() => applyRunnerSetting(h.deps(), { accountId: f.accountId, userId: f.o1 }, id, action, body));
  async function repo(f: F2Fixture, mode: string): Promise<string> {
    const id = randomUUID();
    await h.admin.query("INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name, execution_mode) VALUES ($1, $2, $3, 'team', 'Acme', 'widgets', $4)", [id, f.accountId, Math.floor(Math.random() * 1e12), mode]);
    return id;
  }

  it("resume sets the account's key after the commit; pause, drain and a refused resume do not", async () => {
    const f = await fresh();
    const id = await insertRunner(h.admin, f.accountId, f.m1);
    const key = runnerWorkKeyFor(f.accountId);
    expect((await act(f, id, "pause")).status).toBe(200);
    expect((await act(f, id, "drain", {})).status).toBe(200);
    await flush();
    expect(entries.has(key)).toBe(false);
    expect((await respond(() => applyRunnerSetting(h.deps(), { accountId: f.accountId, userId: f.m2 }, id, "resume", null))).status).toBe(403);
    await flush();
    expect(entries.has(key)).toBe(false);
    expect((await act(f, id, "resume")).status).toBe(200);
    await flush();
    expect(entries.get(key)).toBeGreaterThan(0);
  });

  it("a runner's repository set marks the account; a refused one does not", async () => {
    const f = await fresh();
    const id = await insertRunner(h.admin, f.accountId, f.m1);
    const key = runnerWorkKeyFor(f.accountId);
    expect((await respond(() => setRunnerRepos(h.deps({ repoVisibility: async () => "private" }), { accountId: f.accountId, userId: f.o1 }, id, { repo_ids: "nope" }))).status).toBe(400);
    await flush();
    expect(entries.has(key)).toBe(false);
    expect((await respond(() => setRunnerRepos(h.deps({ repoVisibility: async () => "private" }), { accountId: f.accountId, userId: f.o1 }, id, { repo_ids: [] }))).status).toBe(200);
    await flush();
    expect(entries.get(key)).toBeGreaterThan(0);
  });

  it("a move onto a runner mode marks the account; a move to sandbox and a no-op do not", async () => {
    const f = await fresh();
    const key = runnerWorkKeyFor(f.accountId);
    const move = (repoId: string, mode: string) =>
      respond(() => setExecutionMode(h.deps({ repoVisibility: async () => "private" }), { accountId: f.accountId, userId: f.o1 }, repoId, { mode, confirm_repo: "Acme/widgets" }));
    const onRunner = await repo(f, "runner_local");
    expect(await move(onRunner, "runner_local")).toMatchObject({ status: 200, body: { changed: false } });
    expect(await move(onRunner, "sandbox")).toMatchObject({ status: 200, body: { changed: true } });
    await flush();
    expect(entries.has(key)).toBe(false);
    expect(await move(onRunner, "runner_local")).toMatchObject({ status: 200, body: { changed: true } });
    await flush();
    expect(entries.get(key)).toBeGreaterThan(0);
  });

  it("a cache that fails never fails the route, and the failure goes to stdout only", async () => {
    const f = await fresh();
    const id = await insertRunner(h.admin, f.accountId, f.m1);
    failWrites = true;
    expect((await act(f, id, "resume")).status).toBe(200);
    await flush();
    expect(entries.size).toBe(0);
    expect(logs.some((l) => l.includes("runner_work.mark_failed") && l.includes("cache down"))).toBe(true);
  });
  it("a registration marks the account once it commits; a refused one (bad code) does not", async () => {
    const f = await fresh();
    const key = newKey();
    const register = (code: string) => respond(() => registerRunner(h.deps({ maxRunners: () => 50 }), signed(key, REGISTER_PATH, { code, public_key_jwk: key.jwk })));
    expect((await register("fxrr_notacode000000000000000000000000000000")).status).toBe(401);
    await flush();
    expect(entries.has(runnerWorkKeyFor(f.accountId))).toBe(false);
    expect((await register(await insertCode(h.admin, f.accountId, f.a1))).status).toBe(201);
    await flush();
    expect(entries.get(runnerWorkKeyFor(f.accountId))).toBeGreaterThan(0);
  });
});
