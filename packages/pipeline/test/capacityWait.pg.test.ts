import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pgHarness } from "./helpers/pgHarness.js";
import { seedAccount } from "./build/helpers/seed.js";
import { startBuildForItem } from "../src/advance/buildTesting.js";
import { readBuildWaitReason } from "../src/advance/buildSlots.js";
import { CAPACITY_WAIT, readReservationPause } from "../src/advance/reservationPauses.js";
import type { AdvanceRunPorts, AdvanceRunRequest } from "../src/advance/runPorts.js";

/**
 * D#483 S5-k3b-2b [pg]: the build start's answer `waiting_for_capacity` is a wait, not a refusal, over real rows; and the reason stays outside the spend pause
 * reader and the build-slot reader (S5k3b-8, "reasons stay apart"). Nothing returns it yet: a fake starter does.
 */
const h = pgHarness();

async function seedItem(): Promise<{ a: string; w: string }> {
  const a = randomUUID();
  await seedAccount(h.admin, a);
  const r = randomUUID();
  await h.admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, execution_mode, gh_owner, gh_name) VALUES ($1, $2, $3, 'team', 'sandbox', 'acme', $4)`, [r, a, Math.floor(Math.random() * 1_000_000_000), `w${r.slice(0, 8)}`]);
  const w = randomUUID();
  await h.admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, state, provenance, gh_number, stage, priority) VALUES ($1, $2, $3, 'feature', 'running', 'internal', $4, 'spec_ready', 2)`, [w, a, r, Math.floor(Math.random() * 100_000) + 1]);
  await h.admin.query(`INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, 'Do the thing.', encode(sha256(convert_to('Do the thing.', 'UTF8')), 'hex'), 'system')`, [a, w]);
  return { a, w };
}

const fact = (a: string, w: string, code: string) => h.admin.query(`INSERT INTO work_item_driver_events (account_id, work_item_id, kind, stage, code, dedupe_key) VALUES ($1, $2, 'stage_waiting', 'build', $3, $4)`, [a, w, code, randomUUID()]);

describe("S5k3b-2b: the build start meets a capacity answer", () => {
  it("is refused as the wait itself (not start_<reason>), starts nothing and leaves the item where it was", async () => {
    const { a, w } = await seedItem();
    const requests: AdvanceRunRequest[] = [];
    const ports: AdvanceRunPorts = {
      async startRun(req) {
        requests.push(req);
        return { ok: false as const, reason: CAPACITY_WAIT };
      },
      async outcome() {
        return { status: "running", done: false, envelope: null };
      },
      async cancel() {},
    };
    expect(await startBuildForItem(h.runWriterPool, a, w, randomUUID(), ports)).toEqual({ status: "refused", reason: CAPACITY_WAIT });
    expect(requests).toHaveLength(1);
    const row = (await h.admin.query<{ stage: string; halted_at: Date | null }>("SELECT stage, halted_at FROM work_items WHERE id = $1", [w])).rows[0]!;
    expect(row).toMatchObject({ stage: "spec_ready", halted_at: null });
  });

  it("the wait fact is no spend pause and no slot wait: readReservationPause and readBuildWaitReason stay null", async () => {
    const { a, w } = await seedItem();
    await fact(a, w, CAPACITY_WAIT);
    expect(await readReservationPause(h.runWriterPool, a, w)).toBeNull();
    expect(await readBuildWaitReason(h.runWriterPool, a, w)).toBeNull();
    // The same fact shape with a spend pause is read, so the null above is the reason's, not the fixture's.
    await fact(a, w, "item_cap_reached");
    expect(await readReservationPause(h.runWriterPool, a, w)).toBe("item_cap_reached");
  });
});
