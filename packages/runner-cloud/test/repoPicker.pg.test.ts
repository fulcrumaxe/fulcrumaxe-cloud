import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activePreset, activePresetsFor, classTwo, currentRows, presetDisposition } from "@fx/db/src/dialPreset.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedF2, type F2Fixture } from "@fx/db/test/helpers/members.js";
import { PICKER_OWNERS_TTL_MS, PICKER_VISIBILITY_TTL_MS, clearPickerVisibilityCache, listPickerRepos } from "../src/index.js";
import { harness, respond, type Harness } from "./helpers.js";

/**
 * [pg] D#845 ON-7a2: GET /api/runners/repos/picker on real Postgres with row security forced. No test here reaches GitHub: the visibility port is a stub the test owns, and
 * the environment carries invalid GitHub credentials as a second wall (see the `beforeAll`).
 */
type Body = { repos: Array<{ id: string; name: string; visibility: string; active_preset: string | null }>; owners: Array<{ gh_id: number; login: string }>; owners_unknown?: true };
const T0 = new Date("2026-11-23T12:00:00.000Z");

describe("the project picker read [pg]", () => {
  let h: Harness;
  const saved: Record<string, string | undefined> = {};
  beforeAll(async () => {
    for (const k of ["GH_TOKEN", "GITHUB_TOKEN", "GH_HOST"]) saved[k] = process.env[k];
    process.env.GH_TOKEN = "invalid";
    process.env.GITHUB_TOKEN = "invalid";
    process.env.GH_HOST = "invalid.localhost";
    h = await harness();
  });
  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    await h.close();
  });
  beforeEach(() => clearPickerVisibilityCache());

  const fresh = (): Promise<F2Fixture> => seedF2(h.admin);
  async function repo(f: F2Fixture, name = `app-${randomUUID().slice(0, 6)}`): Promise<string> {
    const id = randomUUID();
    await h.admin.query("INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, floor(random() * 2000000000)::bigint + 1, 'team', 'acme', $3)", [id, f.accountId, name]);
    return id;
  }
  /** Writes version `version` of one class 2 dial, as the admin role (the routes' own writer is the dials API, covered elsewhere). */
  async function dial(f: F2Fixture, repoId: string, type: string, disposition: string, version = 1): Promise<void> {
    await h.admin.query("INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, preset, version, changed_by) VALUES ($1, $2, $3, $4, NULL, $5, $6)", [f.accountId, repoId, type, disposition, version, f.o1]);
  }
  async function writePreset(f: F2Fixture, repoId: string, preset: "cautious" | "balanced" | "autonomous"): Promise<void> {
    for (const e of classTwo()) await dial(f, repoId, e.id, presetDisposition(e, preset));
  }
  const pick = (f: F2Fixture, userId: string, over: Parameters<Harness["deps"]>[0] = {}) => respond(() => listPickerRepos(h.deps({ now: () => T0, ...over }), { accountId: f.accountId, userId }));
  const repos = async (f: F2Fixture, userId = f.o1, over: Parameters<Harness["deps"]>[0] = {}): Promise<Body["repos"]> => {
    const res = await pick(f, userId, over);
    expect(res.status).toBe(200);
    return (res.body as Body).repos;
  };

  it("an owner and an admin read it; a member gets 403 and no GitHub call is made", async () => {
    const f = await fresh();
    await repo(f);
    const visibility = vi.fn(async () => "private" as const);
    expect((await pick(f, f.o1, { repoVisibility: visibility })).status).toBe(200);
    expect((await pick(f, f.a1, { repoVisibility: visibility })).status).toBe(200);
    const calls = visibility.mock.calls.length;
    const refused = await pick(f, f.m1, { repoVisibility: visibility });
    expect(refused.status).toBe(403);
    expect(visibility.mock.calls.length).toBe(calls);
    expect((await pick(f, randomUUID(), { repoVisibility: visibility })).status).toBe(403);
  });

  it("lists the account's repos by name with visibility from the port; no cache header, and the body names nothing else", async () => {
    const f = await fresh();
    const a = await repo(f, "alpha");
    const b = await repo(f, "bravo");
    const c = await repo(f, "charlie");
    const answers: Record<string, "public" | "private" | "unknown"> = { [a]: "private", [b]: "public", [c]: "unknown" };
    const res = await pick(f, f.o1, { repoVisibility: async (_acct, id) => answers[id]! });
    expect(res.headers?.["cache-control"]).toBe("no-store");
    expect((res.body as Body).repos).toEqual([
      { id: a, name: "acme/alpha", visibility: "private", active_preset: expect.anything() },
      { id: b, name: "acme/bravo", visibility: "public", active_preset: expect.anything() },
      { id: c, name: "acme/charlie", visibility: "unknown", active_preset: expect.anything() },
    ]);
  });

  it("unknown on every failure: no port, a throw, a bad answer, a hang past the deadline", async () => {
    const f = await fresh();
    const ids = [await repo(f, "a1"), await repo(f, "a2"), await repo(f, "a3")];
    expect((await repos(f)).map((r) => r.visibility)).toEqual(["unknown", "unknown", "unknown"]);
    clearPickerVisibilityCache();
    const mixed = async (_a: string, id: string) => {
      if (id === ids[0]) throw new Error("boom: ghs_secret");
      if (id === ids[1]) return "internal" as never;
      return new Promise<never>(() => undefined);
    };
    const t0 = Date.now();
    const out = await repos(f, f.o1, { repoVisibility: mixed, repoVisibilityTimeoutMs: 50, repoVisibilityTotalTimeoutMs: 200 });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(out.map((r) => r.visibility)).toEqual(["unknown", "unknown", "unknown"]);
    expect(JSON.stringify(out)).not.toContain("ghs_secret");
  });

  it("remembers a definite answer for 60 s and no longer; never remembers unknown; an answer is per account", async () => {
    const f = await fresh();
    const other = await fresh();
    const id = await repo(f, "cached");
    await repo(other, "cached");
    const port = vi.fn(async (_a: string, _r: string) => "private" as const);
    await repos(f, f.o1, { repoVisibility: port });
    await repos(f, f.o1, { repoVisibility: port, now: () => new Date(T0.getTime() + PICKER_VISIBILITY_TTL_MS - 1) });
    expect(port).toHaveBeenCalledTimes(1);
    // The other account has the same repo name but its own ids: it asks for itself.
    await repos(other, other.o1, { repoVisibility: port });
    expect(port).toHaveBeenCalledTimes(2);
    // Past the TTL it asks again, and a public turn shows at once.
    const nowPublic = vi.fn(async () => "public" as const);
    const later = await repos(f, f.o1, { repoVisibility: nowPublic, now: () => new Date(T0.getTime() + PICKER_VISIBILITY_TTL_MS) });
    expect(nowPublic).toHaveBeenCalledTimes(1);
    expect(later.find((r) => r.id === id)?.visibility).toBe("public");
    // A failure is not remembered: the next read asks again and shows the answer it gets.
    clearPickerVisibilityCache();
    const failing = vi.fn(async () => {
      throw new Error("down");
    });
    expect((await repos(f, f.o1, { repoVisibility: failing }))[0]?.visibility).toBe("unknown");
    const up = vi.fn(async () => "private" as const);
    expect((await repos(f, f.o1, { repoVisibility: up }))[0]?.visibility).toBe("private");
    expect(up).toHaveBeenCalledTimes(1);
  });

  it("asks for at most 8 repos at once", async () => {
    const f = await fresh();
    for (let i = 0; i < 20; i++) await repo(f, `r${String(i).padStart(2, "0")}`);
    let open = 0;
    let most = 0;
    const port = async () => {
      most = Math.max(most, ++open);
      await new Promise((r) => setTimeout(r, 5));
      open--;
      return "private" as const;
    };
    const out = await repos(f, f.o1, { repoVisibility: port });
    expect(out).toHaveLength(20);
    expect(most).toBeLessThanOrEqual(8);
  });

  it("each row's active_preset is what activePreset derives from that repo's own dials; a hand-moved dial reads as custom (null) and the repo beside it does not follow", async () => {
    const f = await fresh();
    const aut = await repo(f, "autonomous");
    const cau = await repo(f, "cautious");
    const cus = await repo(f, "custom");
    const sib = await repo(f, "sibling");
    const none = await repo(f, "untouched");
    await writePreset(f, aut, "autonomous");
    await writePreset(f, cau, "cautious");
    // Custom: every dial at Cautious except one at its Autonomous value, so no preset matches. The sibling holds a clean Autonomous.
    await writePreset(f, cus, "cautious");
    await dial(f, cus, "tool_call", "act", 2);
    await writePreset(f, sib, "autonomous");
    const by = new Map((await repos(f, f.o1, { repoVisibility: async () => "private" })).map((r) => [r.id, r.active_preset]));
    expect(by.get(aut)).toBe("autonomous");
    expect(by.get(cau)).toBe("cautious");
    expect(by.get(cus)).toBeNull();
    expect(by.get(sib)).toBe("autonomous");
    // The reference: the very function the dials route uses, over the same repo's rows, for every repo.
    for (const id of [aut, cau, cus, sib, none]) {
      const expected = await withTenant(h.appPool, f.accountId, f.o1, async (c) => activePreset(await currentRows(c, id)));
      expect(by.get(id), id).toBe(expected);
    }
  });

  it("tenant: another account's repos never appear, even through a connection that bypasses row security", async () => {
    const f = await fresh();
    const other = await fresh();
    const mine = await repo(f, "mine");
    const theirs = await repo(other, "theirs");
    await writePreset(other, theirs, "autonomous");
    const seen = vi.fn(async () => "private" as const);
    // Row security on: only the account's own repo.
    expect((await repos(f, f.o1, { repoVisibility: seen })).map((r) => r.id)).toEqual([mine]);
    // Row security off (the owner pool): the query's own account predicate is what keeps the other account out.
    clearPickerVisibilityCache();
    const bypass = await repos(f, f.o1, { repoVisibility: seen, appUserPool: h.adminPool });
    expect(bypass.map((r) => r.id)).toEqual([mine]);
    expect(seen.mock.calls.every((c) => (c as unknown[])[1] !== theirs)).toBe(true);
  });

  it("activePresetsFor with another account's id reads nothing, through a connection that bypasses row security", async () => {
    const f = await fresh();
    const other = await fresh();
    const theirs = await repo(other, "theirs");
    await writePreset(other, theirs, "autonomous");
    // Its own account sees the preset; asked as a different account it sees no rows (all null), so no preset is derived from them.
    expect((await activePresetsFor(h.admin, other.accountId, [theirs])).get(theirs)).toBe("autonomous");
    const foreign = (await activePresetsFor(h.admin, f.accountId, [theirs])).get(theirs);
    const none = (await activePresetsFor(h.admin, f.accountId, [randomUUID()])).values().next().value;
    expect(foreign).toBe(none);
    expect(foreign).not.toBe("autonomous");
  });

  it("an account with no repos answers an empty list without asking GitHub", async () => {
    const f = await fresh();
    const port = vi.fn(async () => "private" as const);
    expect(await repos(f, f.o1, { repoVisibility: port })).toEqual([]);
    expect(port).not.toHaveBeenCalled();
  });

  // ON-7b (Ruling 87.1): owners, asked of GitHub live per team installation. The port here is a strict stub the test owns; nothing reaches GitHub.
  let ghInstall = 880_000_000 + Math.floor(Math.random() * 1_000_000);
  async function installation(f: F2Fixture, kind = "team"): Promise<number> {
    const gh = ++ghInstall;
    await h.admin.query("INSERT INTO installations (account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3)", [f.accountId, gh, kind]);
    return gh;
  }
  const ownersOf = async (f: F2Fixture, over: Parameters<Harness["deps"]>[0], userId = f.o1): Promise<Body> => {
    const res = await pick(f, userId, over);
    expect(res.status).toBe(200);
    return res.body as Body;
  };

  it("lists the owners of the account's team installations, sorted, deduplicated, with only gh_id and login", async () => {
    const f = await fresh();
    const a = await installation(f);
    const b = await installation(f);
    const c = await installation(f);
    await installation(f, "sitekit"); // not the team App: never asked about
    const accounts: Record<number, { gh_id: number; login: string } | null> = { [a]: { gh_id: 20, login: "zeta" }, [b]: { gh_id: 10, login: "alpha" }, [c]: { gh_id: 20, login: "zeta" } };
    const port = vi.fn(async (id: number) => accounts[id] ?? null);
    const body = await ownersOf(f, { installationAccount: port });
    expect(body.owners).toEqual([{ gh_id: 10, login: "alpha" }, { gh_id: 20, login: "zeta" }]);
    expect(body.owners_unknown).toBeUndefined();
    expect(port.mock.calls.map((x) => x[0]).sort()).toEqual([a, b, c].sort());
  });

  it("an account with no installation has no owners and asks GitHub nothing; a gone or suspended installation (null) is not an owner", async () => {
    const f = await fresh();
    const port = vi.fn(async () => null);
    expect(await ownersOf(f, { installationAccount: port })).toMatchObject({ owners: [] });
    expect(port).not.toHaveBeenCalled();
    await installation(f);
    const body = await ownersOf(f, { installationAccount: port });
    expect(body.owners).toEqual([]);
    expect(body.owners_unknown).toBeUndefined();
  });

  it("owners are unknown (empty list plus owners_unknown) on a throw, a hang past the deadline, or no reader; the repos still list", async () => {
    const f = await fresh();
    const id = await repo(f, "still-here");
    const ghId = await installation(f);
    await installation(f);
    const reasons: Array<Parameters<Harness["deps"]>[0]> = [
      { installationAccount: async () => { throw new Error("boom ghs_secret"); } },
      { installationAccount: () => new Promise<never>(() => undefined), installationAccountTimeoutMs: 50 },
      { installationAccount: async (n: number) => (n === ghId ? { gh_id: 1, login: "ok" } : (() => { throw new Error("one failed"); })()) },
      {},
    ];
    for (const over of reasons) {
      clearPickerVisibilityCache();
      const t0 = Date.now();
      const res = await pick(f, f.o1, { repoVisibility: async () => "private", ...over });
      expect(Date.now() - t0).toBeLessThan(2000);
      const body = res.body as Body;
      expect(body.owners).toEqual([]);
      expect(body.owners_unknown).toBe(true);
      expect(body.repos.map((r) => r.id)).toEqual([id]);
      expect(JSON.stringify(body)).not.toContain("ghs_secret");
    }
  });

  it("asks at most 4 installations at once", async () => {
    const f = await fresh();
    for (let i = 0; i < 12; i++) await installation(f);
    let open = 0;
    let most = 0;
    const port = async (n: number) => {
      most = Math.max(most, ++open);
      await new Promise((r) => setTimeout(r, 5));
      open--;
      return { gh_id: n, login: `o${n}` };
    };
    expect((await ownersOf(f, { installationAccount: port })).owners).toHaveLength(12);
    expect(most).toBeLessThanOrEqual(4);
  });

  it("keeps a good answer for 60 s per account; never keeps unknown or an empty answer; each account asks for itself", async () => {
    const f = await fresh();
    const other = await fresh();
    await installation(f);
    await installation(other);
    const port = vi.fn(async (n: number) => ({ gh_id: n, login: `o${n}` }));
    await ownersOf(f, { installationAccount: port });
    await ownersOf(f, { installationAccount: port, now: () => new Date(T0.getTime() + PICKER_OWNERS_TTL_MS - 1) });
    expect(port).toHaveBeenCalledTimes(1);
    await ownersOf(other, { installationAccount: port }, other.o1);
    expect(port).toHaveBeenCalledTimes(2);
    await ownersOf(f, { installationAccount: port, now: () => new Date(T0.getTime() + PICKER_OWNERS_TTL_MS) });
    expect(port).toHaveBeenCalledTimes(3);
    // A failure is not kept: the next read asks again.
    clearPickerVisibilityCache();
    const down = vi.fn(async () => { throw new Error("down"); });
    expect((await ownersOf(f, { installationAccount: down })).owners_unknown).toBe(true);
    const up = vi.fn(async (n: number) => ({ gh_id: n, login: "back" }));
    expect((await ownersOf(f, { installationAccount: up })).owners).toHaveLength(1);
    // An empty answer is not kept either, so an App installed a moment ago shows at once.
    clearPickerVisibilityCache();
    const none = vi.fn(async () => null);
    await ownersOf(f, { installationAccount: none });
    await ownersOf(f, { installationAccount: none });
    expect(none).toHaveBeenCalledTimes(2);
  });

  it("members get 403 and GitHub is not asked", async () => {
    const f = await fresh();
    await installation(f);
    const port = vi.fn(async () => ({ gh_id: 1, login: "x" }));
    expect((await pick(f, f.m1, { installationAccount: port })).status).toBe(403);
    expect(port).not.toHaveBeenCalled();
  });

  it("tenant: a second account's installations never appear, even through a connection that bypasses row security", async () => {
    const f = await fresh();
    const other = await fresh();
    const mine = await installation(f);
    const theirs = await installation(other);
    await installation(other);
    const port = vi.fn(async (n: number) => ({ gh_id: n, login: `o${n}` }));
    expect((await ownersOf(f, { installationAccount: port })).owners.map((o) => o.gh_id)).toEqual([mine]);
    clearPickerVisibilityCache();
    port.mockClear();
    const bypass = await ownersOf(f, { installationAccount: port, appUserPool: h.adminPool });
    expect(bypass.owners.map((o) => o.gh_id)).toEqual([mine]);
    expect(port.mock.calls.map((c) => c[0])).not.toContain(theirs);
  });
});
