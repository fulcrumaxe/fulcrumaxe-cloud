import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { insertAgentRun } from "../src/runStatusWriter.js";
import { pgHarness } from "./helpers/pgHarness.js";
import { seedAccount } from "./helpers/seed.js";

// D#2 H-EXPO: with the shipped catalogue (empty in v1) the row is still
// non-null: an empty features map and a digest, never NULL.
const db = pgHarness();

it("a run created under the shipped catalogue still carries a non-null exposure and digest", async () => {
  const accountId = randomUUID();
  await seedAccount(db.admin, accountId);
  const id = randomUUID();
  await insertAgentRun(db.runWriterPool, { id, accountId, role: "executor", runtime: "production" });
  const { rows } = await db.admin.query(`SELECT resolved_exposure, exposure_digest FROM agent_runs WHERE id = $1`, [id]);
  expect(rows[0].resolved_exposure).toEqual({ accountId, features: {} });
  expect(rows[0].exposure_digest).toMatch(/^[0-9a-f]{64}$/);
});
