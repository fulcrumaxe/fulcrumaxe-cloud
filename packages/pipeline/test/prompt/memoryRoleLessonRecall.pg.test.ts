import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pgHarness } from "../helpers/pgHarness.js";
import { seedAccount, seedRepo, seedWorkItem } from "../build/helpers/seed.js";
import { nextGhInstallationId } from "@fx/db/test/helpers/seed.js";
import { createMemoryPort } from "../../src/prompt/memoryRecall.js";

/**
 * D#601 MEM-9 [pg]: an agent-proposed role lesson through the real retriever. Proposed: in no run's recall. Approved: recalled, as agent text (fenced).
 * Retired: out again at the next run. The retriever is MEM-3's, unchanged; this pins the three states for a role entry written by an agent.
 */
const h = pgHarness();

describe("agent-proposed role lessons in recall (D#601 MEM-9)", () => {
  it("a proposed lesson is never recalled; approval brings it in as agent text; retiring takes it out at the next run", async () => {
    const accountId = randomUUID();
    const repoId = randomUUID();
    const itemId = randomUUID();
    const installId = randomUUID();
    await seedAccount(h.admin, accountId);
    await h.admin.query("INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3, 'team')", [installId, accountId, nextGhInstallationId()]);
    await seedRepo(h.admin, accountId, repoId);
    await h.admin.query("UPDATE repos SET installation_id = $2, gh_node_id = 'R_kgDOMem9' WHERE id = $1", [repoId, installId]);
    await seedWorkItem(h.admin, accountId, itemId, repoId, { ghNumber: 91 });
    const id = randomUUID();
    const body = "run the linter before opening a pull request";
    await h.admin.query(
      `INSERT INTO memory_entries (id, account_id, scope, scope_ref, kind, body, author_kind, status, version, content_sha256, expires_at)
       VALUES ($1, $2, 'role', 'executor', 'convention', $3, 'agent', 'proposed', 1, $4, now() + interval '14 days')`,
      [id, accountId, body, createHash("sha256").update(body).digest("hex")],
    );
    const recalled = async () => {
      const port = createMemoryPort(h.runWriterPool, { liveSecrets: () => [] });
      const both = await Promise.all([
        port.recall({ accountId, repoId, workItemId: itemId, role: "executor", slot: "stable" } as never),
        port.recall({ accountId, repoId, workItemId: itemId, role: "executor", slot: "item" } as never),
      ]);
      return both.flat();
    };
    expect(await recalled()).toEqual([]);

    await h.admin.query("UPDATE memory_entries SET status = 'approved', approved_at = now(), expires_at = NULL WHERE id = $1", [id]);
    const live = await recalled();
    expect(live.map((e) => e.id)).toEqual([id]);
    expect(live[0]!.origin).toBe("agent");

    await h.admin.query("UPDATE memory_entries SET status = 'retired' WHERE id = $1", [id]);
    expect(await recalled()).toEqual([]);
  });
});
