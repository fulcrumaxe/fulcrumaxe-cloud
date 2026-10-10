import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COPY } from "@fulcrumaxe/runner-protocol";
import { seedF2, type F2Fixture } from "@fx/db/test/helpers/members.js";
import { CLOUD_VERIFIED_COPY_SHA256, getRepoMode } from "../src/index.js";
import { harness, respond, type Harness } from "./helpers.js";

/** [pg] D#6 R5b-2b-iii (C40): the state-read route behind the repo mode picker. Real rows, real row security. */
describe("GET /api/runners/repos/:id/execution-mode [pg]", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  const fresh = (): Promise<F2Fixture> => seedF2(h.admin);
  async function repo(f: F2Fixture, mode = "sandbox", owner: string | null = "Acme", name: string | null = "widgets"): Promise<string> {
    const id = randomUUID();
    await h.admin.query("INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name, execution_mode) VALUES ($1, $2, $3, 'team', $4, $5, $6)", [id, f.accountId, Math.floor(Math.random() * 1e12), owner, name, mode]);
    return id;
  }
  async function key(f: F2Fixture, status: string): Promise<void> {
    await h.admin.query("INSERT INTO model_connections (account_id, provider, key_ciphertext, key_nonce, wrapped_dek, kek_version, key_fingerprint, status) VALUES ($1, 'anthropic', $2, $3, $4, 1, $5, $6)", [
      f.accountId,
      Buffer.from("secret-ciphertext"),
      Buffer.from("n"),
      Buffer.from("w"),
      `fp-${randomUUID()}`,
      status,
    ]);
  }
  const get = (f: F2Fixture, userId: string, repoId: string) => respond(() => getRepoMode(h.deps(), { accountId: f.accountId, userId }, repoId));
  const body = (res: { body: unknown }) => res.body as Record<string, unknown>;

  it("answers the mode, the full name and the hash of the shipped cloud-verified wording; the hash is the sha256 of COPY.cloudVerified", async () => {
    const f = await fresh();
    const id = await repo(f, "runner_local");
    const res = await get(f, f.m1, id);
    expect(res.status).toBe(200);
    expect(res.headers?.["cache-control"]).toBe("no-store");
    expect(body(res)).toMatchObject({ repo_id: id, execution_mode: "runner_local", full_name: "Acme/widgets", copy_sha256: CLOUD_VERIFIED_COPY_SHA256 });
    expect(body(res).copy_sha256).toBe(createHash("sha256").update(COPY.cloudVerified, "utf8").digest("hex"));
    expect((body(res).copy as Record<string, string>).cloudVerifiedHelp).toBe(COPY.cloudVerified);
    expect((body(res).copy as Record<string, string>).keyRequired).toBe(COPY.keyRequired);
  });

  it("key_required is true with no key connected and with only a broken key", async () => {
    const f = await fresh();
    const id = await repo(f);
    expect(body(await get(f, f.o1, id)).key_required).toBe(true);
    await key(f, "broken");
    expect(body(await get(f, f.o1, id)).key_required).toBe(true);
  });

  it("key_required is false with an ok key or an unvalidated one, and says only a boolean: no key material is in the answer", async () => {
    for (const status of ["ok", "unvalidated"]) {
      const f = await fresh();
      const id = await repo(f);
      await key(f, status);
      const res = await get(f, f.a1, id);
      expect(body(res).key_required, status).toBe(false);
      const text = JSON.stringify(res.body);
      expect(text).not.toContain("secret-ciphertext");
      expect(text).not.toContain("fp-");
      expect(text).not.toContain("anthropic");
    }
  });

  it("another account's key does not count", async () => {
    const f = await fresh();
    const other = await fresh();
    await key(other, "ok");
    expect(body(await get(f, f.o1, await repo(f))).key_required).toBe(true);
  });

  it("any member reads it; can_change is true for an owner and an admin only", async () => {
    const f = await fresh();
    const id = await repo(f);
    expect(body(await get(f, f.m1, id)).can_change).toBe(false);
    expect(body(await get(f, f.o1, id)).can_change).toBe(true);
    expect(body(await get(f, f.a1, id)).can_change).toBe(true);
  });

  it("a user who is not a member of the account gets 403 and nothing about the repo", async () => {
    const f = await fresh();
    const outsider = await fresh();
    const id = await repo(f);
    const res = await get(f, outsider.o1, id);
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain("widgets");
  });

  it("another account's repo is 404 for a member, and so are a malformed id and an id that does not exist", async () => {
    const f = await fresh();
    const other = await fresh();
    const theirs = await repo(other);
    expect((await get(f, f.o1, theirs)).status).toBe(404);
    expect((await get(f, f.o1, "not-a-uuid")).status).toBe(404);
    expect((await get(f, f.o1, randomUUID())).status).toBe(404);
  });

  it("a repo with no stored name has a null full_name, never the word null in a string", async () => {
    const f = await fresh();
    const id = await repo(f, "sandbox", null, null);
    expect(body(await get(f, f.o1, id)).full_name).toBeNull();
  });
});
