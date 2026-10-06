import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { pgHarness } from "../helpers/pgHarness.js";
import { seedAccount } from "../build/helpers/seed.js";
import { listParked, runTriageStep, type TriageStepInput } from "../../src/plan/step.js";
import type { TriageClassifier } from "../../src/plan/classifier.js";
import type { TriageDeps } from "../../src/plan/triage.js";
import { findTriageImports } from "./helpers/triageImportScan.js";

// Record every store write the step's triage makes, running the real store.
const calls = { createDiscussion: 0, setStage: 0 };
vi.mock("@fx/discussions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fx/discussions")>();
  return {
    ...actual,
    createDiscussion: vi.fn(async (...args: Parameters<typeof actual.createDiscussion>) => {
      calls.createDiscussion++;
      return actual.createDiscussion(...args);
    }),
    setStage: vi.fn(async (...args: Parameters<typeof actual.setStage>) => {
      calls.setStage++;
      return actual.setStage(...args);
    }),
  };
});

// What H07's real decision is handed, so a test can prove it is a validated copy.
const seenByH07: Array<{ allowlist: unknown[] }> = [];
vi.mock("@fx/trust", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fx/trust")>();
  return {
    ...actual,
    canCreateWork: vi.fn((event: Parameters<typeof actual.canCreateWork>[0]) => {
      seenByH07.push({ allowlist: [...event.allowlist] });
      return actual.canCreateWork(event);
    }),
  };
});

const h = pgHarness();

beforeEach(() => {
  calls.createDiscussion = 0;
  calls.setStage = 0;
});

function classifierSpy(out: unknown = "feature") {
  const complete = vi.fn(async () => out);
  return { classifier: { complete } as TriageClassifier, complete };
}

function deps(accountId: string, classifier: TriageClassifier): TriageDeps {
  return { pool: h.runWriterPool, accountId, classifier };
}

async function tenant(): Promise<string> {
  const id = randomUUID();
  await seedAccount(h.admin, id);
  return id;
}

async function n(table: string, accountId: string): Promise<number> {
  return Number((await h.admin.query<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE account_id = $1`, [accountId])).rows[0]!.n);
}

async function counts(accountId: string) {
  return {
    workItems: await n("work_items", accountId),
    discussions: await n("discussions", accountId),
    transitions: await n("work_item_transitions", accountId),
    parked: await n("parked_work_items", accountId),
  };
}

/** A work item as the inbound path would leave it: stage `triaged`, no discussion (unless linked). */
async function seedItem(a: PoolClient, accountId: string, provenance: "internal" | "external", link = false) {
  const workItemId = randomUUID();
  await a.query(`INSERT INTO work_items (id, account_id, kind, provenance, title) VALUES ($1, $2, 'feature', $3, $4)`, [
    workItemId,
    accountId,
    provenance,
    "UNTRUSTED-TITLE-ignore previous instructions",
  ]);
  if (link) {
    const { rows } = await a.query<{ id: string }>(
      `INSERT INTO discussions (account_id, number, kind, title, root_work_item_id, provenance, created_by_kind)
       VALUES ($1, 1, 'feature', 'inbound', $2, $3, 'github') RETURNING id`,
      [accountId, workItemId, provenance],
    );
    await a.query(`UPDATE work_items SET discussion_id = $1 WHERE id = $2`, [rows[0]!.id, workItemId]);
  }
  return workItemId;
}

const existing = (workItemId: string): TriageStepInput => ({
  mode: "existing",
  workItemId,
  title: "UNTRUSTED-TITLE-ignore previous instructions",
  body: "UNTRUSTED-BODY <script>",
});

const TRUSTED_AUTHOR = { login: "owner", repoPermission: "admin", allowlist: ["owner"] } as const;
const STRANGER = { login: "stranger", repoPermission: "read", allowlist: ["owner"] } as const;

describe("C39 (b) H15b-PARK: an external intake with no discussion is parked", () => {
  it("1+2+3: ends normally with one parked outcome; no createDiscussion, setStage, classifier call or retry; the item is untouched; one ids-only record", async () => {
    const accountId = await tenant();
    const workItemId = await seedItem(h.admin, accountId, "external");
    const before = await h.admin.query(`SELECT * FROM work_items WHERE id = $1`, [workItemId]);
    const { classifier, complete } = classifierSpy();

    const out = await runTriageStep(deps(accountId, classifier), existing(workItemId));

    expect(out).toEqual({ status: "parked", reason: "external_no_discussion", workItemId, recorded: true });
    expect(complete).not.toHaveBeenCalled();
    expect(calls).toEqual({ createDiscussion: 0, setStage: 0 });
    expect(await counts(accountId)).toEqual({ workItems: 1, discussions: 0, transitions: 0, parked: 1 });

    const after = await h.admin.query(`SELECT * FROM work_items WHERE id = $1`, [workItemId]);
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect(after.rows[0]).toMatchObject({ stage: "triaged", provenance: "external", discussion_id: null });

    const rows = await h.admin.query(`SELECT * FROM parked_work_items WHERE account_id = $1`, [accountId]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ account_id: accountId, work_item_id: workItemId, reason: "external_no_discussion" });
    // Ids and a fixed reason only: nothing from the untrusted title or body anywhere in the row.
    expect(JSON.stringify(rows.rows[0])).not.toMatch(/UNTRUSTED|script|ignore previous/);
    console.log("PARKED ROW", JSON.stringify(rows.rows[0]));
  });

  it("3: replaying the same intake twice leaves exactly one record (the second is a recorded:false no-op)", async () => {
    const accountId = await tenant();
    const workItemId = await seedItem(h.admin, accountId, "external");
    const { classifier, complete } = classifierSpy();
    const d = deps(accountId, classifier);
    const first = await runTriageStep(d, existing(workItemId));
    const second = await runTriageStep(d, existing(workItemId));
    expect(first).toMatchObject({ status: "parked", recorded: true });
    expect(second).toEqual({ status: "parked", reason: "external_no_discussion", workItemId, recorded: false });
    expect(await counts(accountId)).toEqual({ workItems: 1, discussions: 0, transitions: 0, parked: 1 });
    expect(complete).not.toHaveBeenCalled();
    expect(calls).toEqual({ createDiscussion: 0, setStage: 0 });
  });

  it("3: two concurrent replays give one record", async () => {
    const accountId = await tenant();
    const workItemId = await seedItem(h.admin, accountId, "external");
    const { classifier } = classifierSpy();
    const d = deps(accountId, classifier);
    const outs = await Promise.all([1, 2, 3, 4].map(() => runTriageStep(d, existing(workItemId))));
    expect(outs.every((o) => o.status === "parked")).toBe(true);
    expect(outs.filter((o) => o.status === "parked" && o.recorded)).toHaveLength(1);
    expect((await counts(accountId)).parked).toBe(1);
  });

  it("an owner/admin can list parked items later (ids only)", async () => {
    const accountId = await tenant();
    const a = await seedItem(h.admin, accountId, "external");
    const b = await seedItem(h.admin, accountId, "external");
    const { classifier } = classifierSpy();
    await runTriageStep(deps(accountId, classifier), existing(a));
    await runTriageStep(deps(accountId, classifier), existing(b));
    const listed = await listParked(deps(accountId, classifier));
    expect(listed.map((p) => p.workItemId).sort()).toEqual([a, b].sort());
    expect(listed.every((p) => p.reason === "external_no_discussion")).toBe(true);
    expect(Object.keys(listed[0]!).sort()).toEqual(["createdAt", "reason", "workItemId"]);
  });

  it("an INTERNAL item with no discussion is not parked: it stays refused no_discussion and nothing is written", async () => {
    const accountId = await tenant();
    const workItemId = await seedItem(h.admin, accountId, "internal");
    const { classifier, complete } = classifierSpy();
    const out = await runTriageStep(deps(accountId, classifier), existing(workItemId));
    expect(out).toEqual({ status: "refused", reason: "no_discussion" });
    expect(await counts(accountId)).toEqual({ workItems: 1, discussions: 0, transitions: 0, parked: 0 });
    expect(complete).not.toHaveBeenCalled();
  });

  it("an external item that DOES have a discussion is triaged normally, not parked", async () => {
    const accountId = await tenant();
    const workItemId = await seedItem(h.admin, accountId, "external", true);
    const { classifier, complete } = classifierSpy("small");
    const out = await runTriageStep(deps(accountId, classifier), existing(workItemId));
    expect(out).toMatchObject({ status: "triaged", category: "small", stage: "triaged" });
    expect(complete).toHaveBeenCalledTimes(1);
    expect((await counts(accountId)).parked).toBe(0);
  });

  it("a parked item picks up normally once a discussion exists (re-triage is not blocked by the record)", async () => {
    const accountId = await tenant();
    const workItemId = await seedItem(h.admin, accountId, "external");
    const { classifier, complete } = classifierSpy("feature");
    expect((await runTriageStep(deps(accountId, classifier), existing(workItemId))).status).toBe("parked");
    // What D#71 DS-7 will do later: create the external discussion and link it.
    const { rows } = await h.admin.query<{ id: string }>(
      `INSERT INTO discussions (account_id, number, kind, title, root_work_item_id, provenance, created_by_kind)
       VALUES ($1, 1, 'feature', 'inbound', $2, 'external', 'github') RETURNING id`,
      [accountId, workItemId],
    );
    await h.admin.query(`UPDATE work_items SET discussion_id = $1 WHERE id = $2`, [rows[0]!.id, workItemId]);
    const out = await runTriageStep(deps(accountId, classifier), existing(workItemId));
    expect(out).toMatchObject({ status: "triaged", category: "feature", stage: "discussing" });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("refusals write nothing: an unknown work item id and a malformed id park nothing", async () => {
    const accountId = await tenant();
    const { classifier, complete } = classifierSpy();
    for (const id of [randomUUID(), "not-a-uuid", ""]) {
      expect(await runTriageStep(deps(accountId, classifier), existing(id))).toEqual({ status: "refused", reason: "not_found" });
    }
    expect(await counts(accountId)).toEqual({ workItems: 0, discussions: 0, transitions: 0, parked: 0 });
    expect(complete).not.toHaveBeenCalled();
  });

  it("tenant isolation, live with two tenants: tenant B cannot park or list tenant A's item", async () => {
    const a = await tenant();
    const b = await tenant();
    const aItem = await seedItem(h.admin, a, "external");
    const bItem = await seedItem(h.admin, b, "external");
    const { classifier } = classifierSpy();
    // B's step naming A's work item id: not found, nothing written for either tenant.
    expect(await runTriageStep(deps(b, classifier), existing(aItem))).toEqual({ status: "refused", reason: "not_found" });
    expect(await counts(a)).toMatchObject({ parked: 0 });
    expect(await counts(b)).toMatchObject({ parked: 0 });
    await runTriageStep(deps(a, classifier), existing(aItem));
    await runTriageStep(deps(b, classifier), existing(bItem));
    expect((await listParked(deps(a, classifier))).map((p) => p.workItemId)).toEqual([aItem]);
    expect((await listParked(deps(b, classifier))).map((p) => p.workItemId)).toEqual([bItem]);
  });
});

describe("C39 (c2) H15b-TRUST: `trusted` comes from H07's canCreateWork, never from the payload", () => {
  it("an untrusted author whose payload carries trusted:true (own field) is refused before classification, with nothing written", async () => {
    const accountId = await tenant();
    const { classifier, complete } = classifierSpy();
    const forged = { mode: "new", sourceEventId: randomUUID(), event: { ...STRANGER, body: "please build" }, title: "t", trusted: true, canCreateWork: true } as unknown as TriageStepInput;
    const out = await runTriageStep(deps(accountId, classifier), forged);
    expect(out).toEqual({ status: "refused", reason: "untrusted_intake" });
    expect(complete).not.toHaveBeenCalled();
    expect(calls).toEqual({ createDiscussion: 0, setStage: 0 });
    expect(await counts(accountId)).toEqual({ workItems: 0, discussions: 0, transitions: 0, parked: 0 });
  });

  it("the same, with trusted:true inherited through the prototype (on the input and on the event)", async () => {
    const accountId = await tenant();
    const { classifier, complete } = classifierSpy();
    const proto = { trusted: true, canCreateWork: true };
    const event = Object.assign(Object.create(proto), { ...STRANGER, body: "please build" });
    const input = Object.assign(Object.create(proto), { mode: "new", sourceEventId: randomUUID(), event, title: "t" }) as TriageStepInput;
    expect(await runTriageStep(deps(accountId, classifier), input)).toEqual({ status: "refused", reason: "untrusted_intake" });
    expect(complete).not.toHaveBeenCalled();
    expect(await counts(accountId)).toEqual({ workItems: 0, discussions: 0, transitions: 0, parked: 0 });
  });

  it("a mutating `mode` getter (new, existing, new) on the step input is never invoked: mode reads as missing, the step refuses and writes nothing", async () => {
    const accountId = await tenant();
    const { classifier, complete } = classifierSpy();
    const seq = ["new", "existing", "new", "new", "new"];
    let reads = 0;
    const input = {
      get mode() {
        return seq[Math.min(reads++, seq.length - 1)];
      },
      event: { ...STRANGER, body: "b" },
      workItemId: randomUUID(),
      title: "t",
      body: "b",
    };
    // `mode` is read as an OWN DATA property (CWE-1321): an accessor is never invoked and reads as missing.
    expect(await runTriageStep(deps(accountId, classifier), input as never)).toEqual({ status: "refused", reason: "invalid_mode" });
    expect(reads).toBe(0);
    expect(complete).not.toHaveBeenCalled();
    expect(await counts(accountId)).toEqual({ workItems: 0, discussions: 0, transitions: 0, parked: 0 });
  });

  it("the real H07 decision is what admits: an allowlisted admin creates the discussion; a write-permission author is untrusted by default", async () => {
    const accountId = await tenant();
    const { classifier } = classifierSpy("small");
    const ok = await runTriageStep(deps(accountId, classifier), { mode: "new", sourceEventId: randomUUID(), event: { ...TRUSTED_AUTHOR, body: "real work" }, title: "Real" });
    expect(ok).toMatchObject({ status: "triaged", category: "small" });
    expect(calls.createDiscussion).toBe(1);
    const writer = await runTriageStep(deps(accountId, classifier), {
      mode: "new", sourceEventId: randomUUID(),
      event: { login: "w", repoPermission: "write", allowlist: [], body: "x" },
      title: "Nope",
    });
    expect(writer).toEqual({ status: "refused", reason: "untrusted_intake" });
    expect(calls.createDiscussion).toBe(1);
    const enabled = await runTriageStep(deps(accountId, classifier), {
      mode: "new", sourceEventId: randomUUID(),
      event: { login: "w", repoPermission: "write", allowlist: [], allowWritePermission: true, body: "x" },
      title: "Yes",
    });
    expect(enabled.status).toBe("triaged");
    expect(calls.createDiscussion).toBe(2);
  });

  it("a malformed event (null, missing, wrong types) is untrusted, never trusted by omission", async () => {
    const accountId = await tenant();
    const { classifier, complete } = classifierSpy();
    for (const event of [null, undefined, "admin", {}, { login: "owner", allowlist: "owner" }, { login: "owner", repoPermission: "admin" }]) {
      const out = await runTriageStep(deps(accountId, classifier), { mode: "new", sourceEventId: randomUUID(), event, title: "t" } as never);
      expect(out).toEqual({ status: "refused", reason: "untrusted_intake" });
    }
    expect(complete).not.toHaveBeenCalled();
    expect(await counts(accountId)).toEqual({ workItems: 0, discussions: 0, transitions: 0, parked: 0 });
  });
});

describe("C39 (c2) H15b-TRUST 3: the step is the only production caller of triage", () => {
  const repoRoot = join(import.meta.dirname, "../../../..");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const SKIP_DIRS = new Set(["node_modules", ".next", "dist", ".git", ".claude", ".autonomous-team", "archive", ".turbo"]);
  /** Every non-test TypeScript/JavaScript source in the whole workspace (packages, apps, sites, ...). */
  const workspaceSources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      if (e.isDirectory()) return SKIP_DIRS.has(e.name) || e.name === "test" || e.name === "tests" ? [] : workspaceSources(join(dir, e.name));
      return /\.(m?[tj]sx?)$/.test(e.name) && !/\.(test|spec)\./.test(e.name) ? [join(dir, e.name)] : [];
    });

  it("no source file in the WHOLE workspace other than plan/triage.ts (the definition) and plan/step.ts names triageIntake, and step.ts never takes `trusted` from its input", () => {
    const users = workspaceSources(repoRoot)
      .filter((f) => /\btriageIntake\b/.test(strip(readFileSync(f, "utf8"))))
      .map((f) => f.slice(repoRoot.length + 1))
      .sort();
    expect(users).toEqual(["packages/pipeline/src/plan/step.ts", "packages/pipeline/src/plan/triage.ts"]);
    const step = strip(readFileSync(join(repoRoot, "packages/pipeline/src/plan/step.ts"), "utf8"));
    // The only `trusted` the step passes on is the one it computed from canCreateWork.
    expect(step).toMatch(/canCreateWork\(/);
    expect(step).not.toMatch(/\.(trusted|canCreateWork)\b/);
  });

  // C41 H15c-HARD-3: the scan is by module PATH, not just by name, so an aliased or computed use cannot hide.
  const planDir = join(repoRoot, "packages/pipeline/src/plan");

  it("H15c-HARD-3: no source file outside packages/pipeline/src/plan/ imports the plan/triage module path, in any form", () => {
    const offenders = workspaceSources(repoRoot)
      .filter((f) => !f.startsWith(`${planDir}/`))
      .flatMap((f) => findTriageImports(readFileSync(f, "utf8"), f, planDir).map((hit) => `${f.slice(repoRoot.length + 1)}: ${hit}`));
    expect(offenders).toEqual([]);
  });

  it("H15c-HARD-3 mutation proof: the scan flags a namespace import with a computed key, and every other spelling of the path", () => {
    const at = join(repoRoot, "packages/pipeline/src/elsewhere.ts");
    const flagged = (src: string, file = at): boolean => findTriageImports(src, file, planDir).length > 0;
    // the case C41 names: a namespace import used through a computed key
    expect(flagged(`import * as t from "./plan/triage.js";\nawait t["triage" + "Intake"](deps, x);`)).toBe(true);
    expect(flagged(`import { triageIntake } from "./plan/triage.js";`)).toBe(true);
    expect(flagged(`import { triageIntake as go } from "./plan/triage";`)).toBe(true);
    expect(flagged(`import type { TriageDeps } from "./plan/triage.js";`)).toBe(true);
    expect(flagged(`import "./plan/triage.js";`)).toBe(true);
    expect(flagged(`export * from "./plan/triage.js";`)).toBe(true);
    expect(flagged(`export { triageIntake } from "./plan/triage.js";`)).toBe(true);
    expect(flagged(`const t = await import("./plan/triage.js");`)).toBe(true);
    expect(flagged("const t = await import(`./plan/triage.js`);")).toBe(true);
    expect(flagged(`const t = require("./plan/triage.js");`)).toBe(true);
    expect(flagged(`import t = require("./plan/triage.js");`)).toBe(true);
    expect(flagged(`type T = typeof import("./plan/triage.js");`)).toBe(true);
    expect(flagged(`const t = await import("./plan/" + "tri" + "age.js");`)).toBe(false); // no word "triage" in one literal...
    expect(flagged(`const name = "x"; const t = await import(base + "/triage.js");`)).toBe(true); // ...but a computed path that names it is flagged
    expect(flagged(`import { x } from "@fx/pipeline/src/plan/triage.js";`)).toBe(true);
    expect(flagged(`import { x } from "../../../packages/pipeline/src/plan/triage.js";`, join(repoRoot, "apps/web/app/x.ts"))).toBe(true);
    // and it leaves the legitimate neighbours alone
    expect(flagged(`import { runTriageStep } from "./plan/step.js";`)).toBe(false);
    expect(flagged(`import { x } from "./plan/index.js";`)).toBe(false);
    expect(flagged(`import { x } from "./triage.js";`, join(repoRoot, "packages/other/src/triage.ts"))).toBe(false);
  });

  it("the @fx/pipeline entry (and the plan entry) does not export triageIntake: callers must go through runTriageStep", async () => {
    const entry = await import("../../src/index.js");
    expect(Object.keys(entry)).not.toContain("triageIntake");
    expect(Object.keys(entry)).toContain("runTriageStep");
    const plan = await import("../../src/plan/index.js");
    expect(Object.keys(plan)).not.toContain("triageIntake");
  });
});

describe("#201 security review: the step reads author fields as OWN data properties, from a copy", () => {
  it("an author field inherited through Object.prototype (allowWritePermission) admits nobody", async () => {
    const accountId = await tenant();
    const { classifier, complete } = classifierSpy("small");
    (Object.prototype as Record<string, unknown>).allowWritePermission = true;
    try {
      const out = await runTriageStep(deps(accountId, classifier), {
        mode: "new",
        event: { login: "w", repoPermission: "write", allowlist: [], body: "x" },
        title: "Nope",
        sourceEventId: "evt-proto-1",
      });
      expect(out).toEqual({ status: "refused", reason: "untrusted_intake" });
    } finally {
      delete (Object.prototype as Record<string, unknown>).allowWritePermission;
    }
    expect(complete).not.toHaveBeenCalled();
    expect(await counts(accountId)).toEqual({ workItems: 0, discussions: 0, transitions: 0, parked: 0 });
  });

  it("inherited login / repoPermission / allowlist / body are not read either, and an accessor property is not invoked", async () => {
    const accountId = await tenant();
    const { classifier, complete } = classifierSpy("small");
    let getterCalls = 0;
    const inherited = Object.assign(Object.create({ ...TRUSTED_AUTHOR, body: "real work" }), {});
    const withGetter = {
      get login() {
        getterCalls++;
        return "owner";
      },
      repoPermission: "admin",
      allowlist: ["owner"],
      body: "b",
    };
    for (const event of [inherited, withGetter]) {
      const out = await runTriageStep(deps(accountId, classifier), { mode: "new", event, title: "t", sourceEventId: "evt-proto-2" } as never);
      expect(out).toEqual({ status: "refused", reason: "untrusted_intake" });
    }
    expect(getterCalls).toBe(0);
    expect(complete).not.toHaveBeenCalled();
  });

  it("the allowlist is copied first and the COPY is validated: H07 only ever sees strings, even from a Proxy that answers a string and then a non-string", async () => {
    const accountId = await tenant();
    const { classifier } = classifierSpy("small");
    // Check-then-read would validate "owner" and then copy the hostile value.
    let reads = 0;
    const allowlist = new Proxy(["owner"], {
      get(target, prop, receiver) {
        if (prop === "0") return reads++ === 0 ? "owner" : { toString: () => "owner" };
        return Reflect.get(target, prop, receiver);
      },
    });
    seenByH07.length = 0;
    await runTriageStep(deps(accountId, classifier), {
      mode: "new",
      event: { login: "owner", repoPermission: "read", allowlist, body: "b" },
      title: "t",
      sourceEventId: "evt-proxy-1",
    } as never);
    expect(seenByH07).toHaveLength(1);
    expect(seenByH07[0]!.allowlist.every((e) => typeof e === "string")).toBe(true);
    expect(reads).toBe(1);
  });

  it("a Proxy allowlist whose first read is already a non-string is refused before classification", async () => {
    const accountId = await tenant();
    const { classifier, complete } = classifierSpy("small");
    const allowlist = new Proxy(["owner"], { get: (t, p, r) => (p === "0" ? 42 : Reflect.get(t, p, r)) });
    const out = await runTriageStep(deps(accountId, classifier), {
      mode: "new",
      event: { login: "owner", repoPermission: "read", allowlist, body: "b" },
      title: "t",
      sourceEventId: "evt-proxy-3",
    } as never);
    expect(out).toEqual({ status: "refused", reason: "untrusted_intake" });
    expect(complete).not.toHaveBeenCalled();
    expect(await counts(accountId)).toEqual({ workItems: 0, discussions: 0, transitions: 0, parked: 0 });
  });

  it("an honest Proxy-wrapped allowlist still works (the copy is what H07 sees)", async () => {
    const accountId = await tenant();
    const { classifier } = classifierSpy("small");
    const allowlist = new Proxy(["owner"], {});
    const out = await runTriageStep(deps(accountId, classifier), {
      mode: "new",
      event: { login: "owner", repoPermission: "read", allowlist, body: "b" },
      title: "t",
      sourceEventId: "evt-proxy-2",
    } as never);
    expect(out).toMatchObject({ status: "triaged", category: "small" });
  });
});
