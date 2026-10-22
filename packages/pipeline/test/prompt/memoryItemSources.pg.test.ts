import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { writeReceipt } from "@fx/db/src/receiptWriter.js";
import { writeRunStatus } from "@fx/runner";
import { createCorrection, decideCorrection, type CorrectionCtx } from "@fx/core/src/corrections/index.js";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { getRunContext } from "@fx/core/src/runs/contextPanel.js";
import { listMemory } from "@fx/core/src/memory/view.js";
import { pgHarness } from "../helpers/pgHarness.js";
import { seedAccount, seedRepo, seedWorkItem } from "../build/helpers/seed.js";
import { renderMemorySlot, type MemoryEntry } from "../../src/prompt/assemblePrompt.js";
import { createMemoryPort, CUT_MARKER, type RecallSkip } from "../../src/prompt/memoryRecall.js";
import { recordRunItemSources } from "../../src/prompt/runContextInputs.js";
import { startBuildForItem } from "../../src/advance/build.js";
import type { AdvanceRunOutcome, AdvanceRunPorts, AdvanceRunRequest, AdvanceRunStart } from "../../src/advance/runPorts.js";

/**
 * D#601 MEM-8b [pg]: what a run is given besides ordinary entries, over real Postgres (the `memory_item_sources` view, row security, the real definers
 * for notes and receipts, the real run-status writer for the handoff note's event). Rows that no definer can make (a note in every kind and status) are
 * inserted by the superuser connection.
 */
const h = pgHarness();
let receiptPool: Pool;
const INVOKER_LOGIN = "fx_receipt_invoker_mem8b_test";
const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

beforeAll(async () => {
  await h.admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${INVOKER_LOGIN}') THEN
    CREATE ROLE ${INVOKER_LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$`);
  await h.admin.query(`GRANT app_user, receipt_writer_invoker TO ${INVOKER_LOGIN}`);
  const u = new URL(process.env.PIPELINE_DATABASE_URL_APP_USER!);
  u.username = INVOKER_LOGIN;
  u.password = "";
  receiptPool = createPool(u.toString());
});
afterAll(async () => {
  await receiptPool.end();
});

interface World {
  accountId: string;
  repoId: string;
  itemId: string;
  adminId: string;
}

async function world(): Promise<World> {
  const accountId = randomUUID();
  const repoId = randomUUID();
  const itemId = randomUUID();
  await seedAccount(h.admin, accountId);
  await seedRepo(h.admin, accountId, repoId);
  await h.admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [repoId]);
  await seedWorkItem(h.admin, accountId, itemId, repoId, { ghNumber: 41 });
  const adminId = randomUUID();
  await h.admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [adminId, `${adminId}@example.test`]);
  await h.admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'admin')", [accountId, adminId]);
  return { accountId, repoId, itemId, adminId };
}

const newRun = async (w: World, status = "running"): Promise<string> => {
  const id = randomUUID();
  await h.admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'executor', 'production', $4)`, [id, w.accountId, w.itemId, status]);
  return id;
};

/** A correction row in any kind and status (the definers only make the legal ones). */
async function putNote(w: World, o: { body: string; kind?: string; status?: string; origin?: string; appliedRun?: string | null; appliedAt?: string }): Promise<string> {
  const id = randomUUID();
  const status = o.status ?? "applied";
  const stamped = status === "applied" || status === "superseded";
  await h.admin.query(
    `INSERT INTO work_item_corrections (id, account_id, work_item_id, origin, kind, body, status, decided_via, content_hash, decided_at, applied_at, applied_run_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, encode(sha256(convert_to($6, 'UTF8')), 'hex'), $9, $10, $11)`,
    [id, w.accountId, w.itemId, o.origin ?? "person", o.kind ?? "run_note", o.body, status, status === "proposed" ? null : "workspace", status === "proposed" ? null : new Date(), stamped ? (o.appliedAt ?? new Date().toISOString()) : null, stamped ? (o.appliedRun ?? null) : null],
  );
  return id;
}

/** A cloud run that checkpointed through the real status writer, and a handoff row taken through the legal edges to `state`. */
async function putHandoff(w: World, o: { summary: string; state?: string; from?: string; child?: string | null }): Promise<{ eventId: string; runId: string }> {
  const runId = await newRun(w);
  await writeRunStatus(h.runWriterPool, { accountId: w.accountId, runId, from: "running", to: "timed_out", checkpoint: { reason: "agent_checkpoint", summary: o.summary, ccSessionId: null, meteredUsd: 1, extensionsUsed: 0 } });
  const eventId = (await h.admin.query<{ id: string }>(`SELECT id FROM run_events WHERE run_id = $1 AND kind = 'checkpoint'`, [runId])).rows[0]!.id;
  const from = o.from ?? "cloud";
  await h.admin.query(
    `INSERT INTO run_handoffs (account_id, run_id, item_id, from_side, to_side, deadline, reserve_until, requested_by) VALUES ($1, $2, $3, $4, $5, now(), now(), $6)`,
    [w.accountId, runId, w.itemId, from, from === "cloud" ? "runner" : "cloud", w.adminId],
  );
  const state = o.state ?? "handed_off";
  const path: Record<string, string[]> = { requested: [], checkpointing: ["checkpointing"], handed_off: ["checkpointing", "handed_off"], forced: ["forced"], cancelled: ["cancelled"], failed: ["failed"] };
  for (const s of path[state]!) await h.admin.query("UPDATE run_handoffs SET state = $2 WHERE run_id = $1", [runId, s]);
  if (o.child) await h.admin.query("UPDATE run_handoffs SET child_run_id = $2 WHERE run_id = $1", [runId, o.child]);
  return { eventId, runId };
}

const skips: RecallSkip[] = [];
const port = () => createMemoryPort(h.runWriterPool, { onSkip: (s) => skips.push(s) });
const recall = (w: World, slot: "stable" | "item", runId?: string): Promise<readonly MemoryEntry[]> =>
  port().recall({ accountId: w.accountId, repoId: w.repoId, workItemId: w.itemId, role: "executor", slot, ...(runId ? { runId } : {}) });
const sourcesOf = async (w: World, runId?: string) => (await recall(w, "item", runId)).filter((e) => e.source !== undefined);

describe("memory item sources (D#601 MEM-8b)", () => {
  describe("acceptance 3: which corrections are recalled", () => {
    it("recalls only applied run notes: never another kind, and never a proposed, accepted, rejected or superseded note", async () => {
      const w = await world();
      const good = await putNote(w, { body: "keep the migration order" });
      for (const kind of ["question", "spec_amend", "new_item", "pause", "priority"]) await putNote(w, { body: `a ${kind} stays out`, kind });
      for (const status of ["proposed", "accepted", "rejected", "superseded"]) await putNote(w, { body: `a ${status} note stays out`, status });
      const got = await sourcesOf(w);
      expect(got.map((e) => e.id)).toEqual([`correction:${good}`]);
      expect(got[0]).toMatchObject({ version: 1, source: { kind: "correction", cut: false, sha256: sha("keep the migration order") } });
    });

    it("takes at most 5 notes, newest first (acceptance 7)", async () => {
      const w = await world();
      const ids: string[] = [];
      for (let i = 0; i < 7; i += 1) ids.push(await putNote(w, { body: `note number ${i}`, appliedAt: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString() }));
      const got = await sourcesOf(w);
      expect(new Set(got.map((e) => e.id))).toEqual(new Set(ids.slice(2).map((id) => `correction:${id}`)));
    });

    it("stops with the item and comes back with it (acceptance 8, derived from the stage now)", async () => {
      const w = await world();
      await putNote(w, { body: "a note for an open item" });
      expect(await sourcesOf(w)).toHaveLength(1);
      await h.admin.query("UPDATE work_items SET stage = 'merged' WHERE id = $1", [w.itemId]);
      expect(await sourcesOf(w)).toEqual([]);
      await h.admin.query("UPDATE work_items SET stage = 'in_progress' WHERE id = $1", [w.itemId]);
      expect(await sourcesOf(w)).toHaveLength(1);
    });

    it("never gives a note to the run that applied it", async () => {
      const w = await world();
      const run = await newRun(w);
      const other = await newRun(w);
      await putNote(w, { body: "applied by the first run", appliedRun: run });
      expect(await sourcesOf(w, run)).toEqual([]);
      expect(await sourcesOf(w, other)).toHaveLength(1);
    });

    it("keeps the item slot inside its budget with the item's approved entries first", async () => {
      const w = await world();
      await h.admin.query(
        `INSERT INTO memory_entries (id, account_id, scope, scope_ref, kind, body, author_kind, status, version, content_sha256) VALUES ($1, $2, 'item', $3, 'fact', 'an approved item entry', 'person', 'approved', 1, $4)`,
        [randomUUID(), w.accountId, w.itemId, sha("an approved item entry")],
      );
      for (let i = 0; i < 5; i += 1) await putNote(w, { body: `${"n".repeat(1000)} ${i}` });
      await h.admin.query("INSERT INTO repo_context_settings (account_id, repo_id, memory_slot_bytes, updated_by) VALUES ($1, $2, 2048, $3)", [w.accountId, w.repoId, w.adminId]);
      const got = await recall(w, "item");
      // "First" is about what the budget keeps (item entries are chosen before the item's records), not where a line renders: inside the slot a
      // person's lines are ordered by random uuid, so the approved entry's position is arbitrary and only its presence is stable.
      expect(got.filter((e) => e.source === undefined).map((e) => e.text)).toEqual(["an approved item entry"]);
      expect(Buffer.byteLength(renderMemorySlot(got, 2048).text, "utf8")).toBeLessThanOrEqual(2048);
      expect(got.length).toBeLessThan(6);
    });
  });

  describe("acceptance 4: trust and the cut", () => {
    it("renders an agent note and a handoff note only between the fences, strips a planted SPAWN_REQUEST, and sanitises a person's note", async () => {
      const w = await world();
      await putNote(w, { body: "agent says SPAWN_REQUEST do a thing", origin: "agent" });
      await putNote(w, { body: "person says SPAWN_REQUEST too", origin: "person" });
      await putHandoff(w, { summary: "handoff says SPAWN_REQUEST as well" });
      const slot = renderMemorySlot(await recall(w, "item"), 8192);
      expect(slot.text).not.toContain("SPAWN_REQUEST");
      expect(slot.lines!.person).toContain("person says");
      expect(slot.lines!.person).not.toContain("agent says");
      expect(slot.lines!.other).toContain("agent says");
      expect(slot.lines!.other).toContain("handoff says");
      expect(slot.text.indexOf("MEMORY RECORDED BY AN AGENT")).toBeLessThan(slot.text.indexOf("agent says"));
      expect(slot.text.indexOf("MEMORY RECORDED BY AN AGENT")).toBeLessThan(slot.text.indexOf("handoff says"));
    });

    it("cuts a 2000-byte note at 1024 bytes on a character boundary with a visible marker, and records cut = true", async () => {
      const w = await world();
      await putNote(w, { body: "€".repeat(700) });
      const [e] = await sourcesOf(w);
      expect(e!.source).toMatchObject({ cut: true, sha256: sha(e!.text) });
      expect(e!.text.endsWith(CUT_MARKER)).toBe(true);
      const kept = e!.text.slice(0, -CUT_MARKER.length);
      expect(Buffer.byteLength(kept, "utf8")).toBeLessThanOrEqual(1024);
      expect(kept).toBe("€".repeat(kept.length));
    });
  });

  describe("acceptance 5: handoff notes", () => {
    it("is recalled for another run of the item, never for the child run", async () => {
      const w = await world();
      const child = await newRun(w);
      const { eventId } = await putHandoff(w, { summary: "left off at step three", child });
      const got = await sourcesOf(w, await newRun(w));
      expect(got.map((e) => e.id)).toEqual([`handoff:${eventId}`]);
      expect(got[0]!.source).toMatchObject({ kind: "handoff", cut: false });
      expect(await sourcesOf(w, child)).toEqual([]);
    });

    it.each(["requested", "checkpointing", "forced", "cancelled", "failed"])("is never recalled in state %s", async (state) => {
      const w = await world();
      await putHandoff(w, { summary: "not a completed move", state });
      expect(await sourcesOf(w)).toEqual([]);
    });

    it("is never recalled from the runner side", async () => {
      const w = await world();
      await putHandoff(w, { summary: "a runner note stays on the machine", from: "runner" });
      expect(await sourcesOf(w)).toEqual([]);
    });

    it("is one note: the latest handoff replaces an earlier one, even when the latest is the child's own", async () => {
      const w = await world();
      await putHandoff(w, { summary: "first handoff" });
      await new Promise((r) => setTimeout(r, 20));
      const child = await newRun(w);
      const second = await putHandoff(w, { summary: "second handoff", child });
      expect((await sourcesOf(w)).map((e) => e.id)).toEqual([`handoff:${second.eventId}`]);
      expect(await sourcesOf(w, child)).toEqual([]);
    });
  });

  describe("acceptance 6: a promoted receipt is a reference, rendered live", () => {
    async function promoted(w: World, chosen: string): Promise<{ entryId: string; receiptId: string }> {
      const runId = await newRun(w);
      const r = await withTenant(receiptPool, w.accountId, w.adminId, (c) =>
        writeReceipt(c, { class: "human_over_the_loop", runId, workItemId: w.itemId, decisionType: "test_strategy_choice", chosen, rejectedAlternative: "none", dialVersion: 4, quotedInputs: [{ trust: "trusted", storedBody: "plain" }] }),
      );
      if (r.store !== "decision_receipts") throw new Error("expected the durable store");
      const entryId = await withTenant(h.pureAppUserPool, w.accountId, w.adminId, async (c) => (await c.query<{ r: string }>("SELECT memory_promote_receipt($1::uuid, $2::uuid) AS r", [w.accountId, r.id])).rows[0]!.r);
      return { entryId, receiptId: r.id };
    }

    it("renders the receipt's text inside the fence, after the fixed label", async () => {
      const w = await world();
      const { entryId } = await promoted(w, "use_the_slow_path");
      const [e] = await recall(w, "stable");
      expect(e).toMatchObject({ id: entryId, origin: "agent" });
      expect(e!.text).toMatch(/^Decision test_strategy_choice \(receipt [0-9a-f]{8}\) use_the_slow_path$/);
      const slot = renderMemorySlot([e!], 8192);
      expect(slot.lines!.person).toBe("");
      expect(slot.lines!.other).toContain("use_the_slow_path");
    });

    it("cuts the receipt's text at 512 bytes with the marker (the real writer allows 128 characters, so the row is widened by the owner here)", async () => {
      const w = await world();
      const { receiptId } = await promoted(w, "short_choice");
      await h.admin.query("UPDATE decision_receipts SET chosen = $2 WHERE id = $1", [receiptId, "€".repeat(400)]);
      const [e] = await recall(w, "stable");
      const text = e!.text.slice(e!.text.indexOf(") ") + 2);
      expect(text.endsWith(CUT_MARKER)).toBe(true);
      expect(Buffer.byteLength(text.slice(0, -CUT_MARKER.length), "utf8")).toBeLessThanOrEqual(512);
    });

    it("skips the entry with receipt_missing once the receipt is deleted by the database owner, throws nothing, and the Memory tab says so", async () => {
      const w = await world();
      const { entryId, receiptId } = await promoted(w, "the_only_copy");
      expect(await recall(w, "stable")).toHaveLength(1);
      await h.admin.query("DELETE FROM decision_receipts WHERE id = $1", [receiptId]);
      skips.length = 0;
      expect(await recall(w, "stable")).toEqual([]);
      expect(skips).toEqual([{ id: entryId, reason: "receipt_missing" }]);
      const list = await listMemory({ pool: h.pureAppUserPool, principal: { accountId: w.accountId, userId: w.adminId } } as never);
      expect(list.groups.flatMap((g) => g.entries.map((x) => x.title))).toEqual(["Receipt no longer available"]);
    });
  });

  describe("acceptance 1 and 2 through the build step", () => {
    class Runs implements AdvanceRunPorts {
      readonly requests: AdvanceRunRequest[] = [];
      private readonly byStep = new Map<string, string>();
      constructor(private readonly w: World) {}
      async startRun(req: AdvanceRunRequest): Promise<AdvanceRunStart> {
        this.requests.push(req);
        const known = this.byStep.get(req.step);
        if (known) return { ok: true, runId: known };
        const id = randomUUID();
        await h.admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, $4, 'production', 'running')`, [id, this.w.accountId, this.w.itemId, req.role]);
        this.byStep.set(req.step, id);
        return { ok: true, runId: id };
      }
      async findStep(prefix: string): Promise<{ step: string; runId: string } | null> {
        for (const [step, runId] of this.byStep) if (step === prefix || (step.startsWith(`${prefix}:n`) && step.length === prefix.length + 18)) return { step, runId };
        return null;
      }
      async outcome(): Promise<AdvanceRunOutcome> {
        return { status: "running", done: false, envelope: null };
      }
      async cancel(): Promise<void> {}
    }
    const count = (text: string, needle: string): number => text.split(needle).length - 1;

    it("an edited applied note: the replacement is recalled and the old one is not; each text appears once; no memory entry holds either", async () => {
      const w = await world();
      await h.admin.query(`INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind, frontmatter) VALUES ($1, $2, 1, 'Do the thing.', $3, 'system', '{}'::jsonb)`, [w.accountId, w.itemId, sha("Do the thing.")]);
      const runs = new Runs(w);
      const ctx: CorrectionCtx = { pool: h.pureAppUserPool, principal: { accountId: w.accountId, userId: w.adminId } };
      const accept = async (body: string) => {
        const c = await createCorrection(ctx, { workItemId: w.itemId, kind: "run_note", body });
        await decideCorrection(ctx, { id: c.id, to: "accepted", via: "workspace" });
        return c.id;
      };
      const build = async (approval: string) => {
        await h.admin.query("UPDATE work_items SET stage = 'spec_ready' WHERE id = $1", [w.itemId]);
        const out = await startBuildForItem(h.runWriterPool, w.accountId, w.itemId, approval, runs);
        if (out.status !== "started") throw new Error(`build refused: ${JSON.stringify(out)}`);
        return { runId: out.runId, prompt: runs.requests.at(-1)!.prompt };
      };
      const recorded = async (runId: string) => (await h.admin.query("SELECT source_kind, source_id, content_sha256, cut FROM run_context_item_sources WHERE run_id = $1", [runId])).rows;

      // Accepted and not yet applied: the driver puts the note in the prompt once; recall adds nothing, and nothing is recorded.
      const first = await accept("zq_first_wording of the note");
      const r1 = await build("a1");
      expect(count(r1.prompt, "zq_first_wording")).toBe(1);
      expect(await recorded(r1.runId)).toEqual([]);
      // Applied now: a later run recalls it, once (the driver has nothing left to inject), and records it by id and hash.
      const r2 = await build("a2");
      expect(count(r2.prompt, "zq_first_wording")).toBe(1);
      expect(await recorded(r2.runId)).toEqual([{ source_kind: "correction", source_id: first, content_sha256: sha("zq_first_wording of the note"), cut: false }]);

      // The person edits it: the old note is superseded and a replacement is accepted, applied by one run and recalled by the next.
      await decideCorrection(ctx, { id: first, to: "superseded", via: "workspace" });
      const second = await accept("zq_second_wording of the note");
      const r3 = await build("a3");
      expect(count(r3.prompt, "zq_second_wording")).toBe(1);
      expect(r3.prompt).not.toContain("zq_first_wording");
      const r4 = await build("a4");
      expect(count(r4.prompt, "zq_second_wording")).toBe(1);
      expect(r4.prompt).not.toContain("zq_first_wording");
      expect(await recorded(r4.runId)).toEqual([{ source_kind: "correction", source_id: second, content_sha256: sha("zq_second_wording of the note"), cut: false }]);
      expect((await h.admin.query("SELECT count(*)::int AS n FROM memory_entries WHERE account_id = $1 AND (body LIKE '%zq_first%' OR body LIKE '%zq_second%')", [w.accountId])).rows[0].n).toBe(0);

      // A replay of the run that applied the second note does not give it back to that run.
      const replay = await build("a3");
      expect(replay.runId).toBe(r3.runId);
      expect(replay.prompt).not.toContain("zq_second_wording");
    });
  });

  describe("the run panel lists the records", () => {
    it("lists a correction and a handoff note by label, with no text or hash", async () => {
      const w = await world();
      const note = await putNote(w, { body: "private text of the note" });
      const { eventId, runId: from } = await putHandoff(w, { summary: "private text of the handoff" });
      const run = await newRun(w, "succeeded");
      await h.admin.query(
        `INSERT INTO run_context_ledger (account_id, run_id, sections, tool_output_bytes, compactions, basis) VALUES ($1, $2, '[]'::jsonb, '{}'::jsonb, 0, 'partial')`,
        [w.accountId, run],
      );
      await withTenant(h.runWriterPool, w.accountId, (c) =>
        recordRunItemSources(c, w.accountId, run, [
          { kind: "correction", id: note, sha256: sha("private text of the note"), cut: false },
          { kind: "handoff", id: eventId, sha256: sha("private text of the handoff"), cut: true },
        ]),
      );
      const panel = await getRunContext({ pool: h.pureAppUserPool, principal: { accountId: w.accountId, userId: w.adminId } } as never, run);
      expect(panel.item_sources).toHaveLength(2);
      expect(panel.item_sources).toContainEqual({ kind: "correction", id: note, label: `Correction ${note.slice(0, 8)}`, cut: false });
      expect(panel.item_sources).toContainEqual({ kind: "handoff", id: eventId, label: `Handoff note from run ${from.slice(0, 8)}`, cut: true });
      expect(JSON.stringify(panel)).not.toContain("private text");
      expect(JSON.stringify(panel)).not.toContain(sha("private text of the note"));
    });
  });
});
