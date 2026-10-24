import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pgHarness } from "../helpers/pgHarness.js";
import { seedAccount, seedRepo, seedWorkItem } from "../build/helpers/seed.js";
import { createMemoryPort, type RecallSkip } from "../../src/prompt/memoryRecall.js";

/**
 * D#601 MEM-RECALL-RESCAN [pg]: recall checks stored text against today's live secret values. Entries are written straight into the table by the
 * superuser connection, then moved between statuses the way a restore, a renewal and a restore from retired do (status only, no re-scan).
 */
const h = pgHarness();
let counter = 0;
const TOKEN = ["ghs", "LiveInstallationTokenValue0123456789abcdef"].join("_");

async function world() {
  counter += 1;
  const accountId = randomUUID();
  const repoId = randomUUID();
  const itemId = randomUUID();
  const installId = randomUUID();
  const installation = 9_300_000 + counter;
  const nodeId = `R_kgDORescan${counter}`;
  await seedAccount(h.admin, accountId);
  await h.admin.query("INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3, 'team')", [installId, accountId, installation]);
  await seedRepo(h.admin, accountId, repoId);
  await h.admin.query("UPDATE repos SET installation_id = $2, gh_node_id = $3 WHERE id = $1", [repoId, installId, nodeId]);
  await seedWorkItem(h.admin, accountId, itemId, repoId, { ghNumber: 90 + counter });
  return { accountId, repoId, itemId, repoRef: `${nodeId}@${installation}` };
}
type World = Awaited<ReturnType<typeof world>>;

async function put(w: World, scope: "repo" | "item", body: string, status = "approved"): Promise<string> {
  const id = randomUUID();
  await h.admin.query(
    `INSERT INTO memory_entries (id, account_id, scope, scope_ref, kind, body, author_kind, status, version, content_sha256, deleted_at)
     VALUES ($1, $2, $3, $4, 'convention', $5, 'person', $6, 1, $7, $8)`,
    [id, w.accountId, scope, scope === "repo" ? w.repoRef : w.itemId, body, status, createHash("sha256").update(body).digest("hex"), status === "deleted" ? new Date() : null],
  );
  return id;
}
const setStatus = (id: string, status: string) => h.admin.query("UPDATE memory_entries SET status = $2, deleted_at = NULL WHERE id = $1", [id, status]);

function recallWith(w: World, slot: "stable" | "item", liveSecrets: () => string[] | Promise<string[]>) {
  const skips: RecallSkip[] = [];
  const port = createMemoryPort(h.runWriterPool, { onSkip: (s) => skips.push(s), liveSecrets });
  return { skips, run: () => port.recall({ accountId: w.accountId, repoId: w.repoId, workItemId: w.itemId, role: "executor", slot }) };
}

describe("memory recall re-checks stored text (D#601 MEM-RECALL-RESCAN)", () => {
  it("does not recall an entry restored after delete whose text now holds a live token, and counts it", async () => {
    const w = await world();
    const clean = await put(w, "repo", "run pnpm test before you push");
    const id = await put(w, "repo", `deploy with token ${TOKEN} from CI`, "deleted");
    await setStatus(id, "approved");
    const r = recallWith(w, "stable", () => [TOKEN]);
    expect((await r.run()).map((e) => e.id)).toEqual([clean]);
    expect(r.skips).toEqual([{ id, reason: "secret_rescan" }]);
  });

  it("does not recall a renewed entry (expired, then approved) or one restored from retired when it holds a live token", async () => {
    const w = await world();
    const renewed = await put(w, "repo", `the key is ${TOKEN}`, "expired");
    const retired = await put(w, "item", `the key is ${TOKEN}`, "retired");
    await setStatus(renewed, "approved");
    await setStatus(retired, "approved");
    const stable = recallWith(w, "stable", () => [TOKEN]);
    expect(await stable.run()).toEqual([]);
    expect(stable.skips).toEqual([{ id: renewed, reason: "secret_rescan" }]);
    const item = recallWith(w, "item", () => [TOKEN]);
    expect(await item.run()).toEqual([]);
    expect(item.skips).toEqual([{ id: retired, reason: "secret_rescan" }]);
  });

  it("does not recall text that still has a credential shape, even when no live token matches", async () => {
    const w = await world();
    const id = await put(w, "repo", `use ${["ghp", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_")} for the mirror`);
    const r = recallWith(w, "stable", () => []);
    expect(await r.run()).toEqual([]);
    expect(r.skips).toEqual([{ id, reason: "secret_rescan" }]);
  });

  it("still recalls a clean entry, and counts nothing", async () => {
    const w = await world();
    const id = await put(w, "repo", "tests live next to the code");
    const r = recallWith(w, "stable", () => [TOKEN]);
    expect((await r.run()).map((e) => e.id)).toEqual([id]);
    expect(r.skips).toEqual([]);
  });

  it("recalls no memory when the live-secrets source fails, with a fixed note that never holds entry text", async () => {
    const w = await world();
    await put(w, "repo", "tests live next to the code");
    await put(w, "item", "keep the loader's public name");
    for (const slot of ["stable", "item"] as const) {
      const r = recallWith(w, slot, () => {
        throw new Error(`lookup failed for ${TOKEN}`);
      });
      expect(await r.run()).toEqual([]);
      expect(r.skips).toEqual([{ id: "-", reason: "secrets_unavailable" }]);
      expect(JSON.stringify(r.skips)).not.toContain("loader");
      expect(JSON.stringify(r.skips)).not.toContain(TOKEN);
    }
    const rejected = recallWith(w, "stable", () => Promise.reject(new Error("down")));
    expect(await rejected.run()).toEqual([]);
  });

  it("recalls nothing from a port built without a live-secrets source (the type refuses it; a caller that gets past the type is treated as unavailable)", async () => {
    const w = await world();
    await put(w, "repo", "tests live next to the code");
    await put(w, "item", "keep the loader's public name");
    const skips: RecallSkip[] = [];
    // @ts-expect-error liveSecrets is required: omitting it does not compile
    const port = createMemoryPort(h.runWriterPool, { onSkip: (s) => skips.push(s) });
    for (const slot of ["stable", "item"] as const) {
      expect(await port.recall({ accountId: w.accountId, repoId: w.repoId, workItemId: w.itemId, role: "executor", slot })).toEqual([]);
    }
    expect(skips).toEqual([
      { id: "-", reason: "secrets_unavailable" },
      { id: "-", reason: "secrets_unavailable" },
    ]);
  });

  it("reports a skipped entry's id and a fixed reason only, never its text", async () => {
    const w = await world();
    await put(w, "repo", `the key is ${TOKEN}`);
    const r = recallWith(w, "stable", () => [TOKEN]);
    await r.run();
    expect(JSON.stringify(r.skips)).not.toContain(TOKEN);
    expect(JSON.stringify(r.skips)).not.toContain("the key");
  });
});
