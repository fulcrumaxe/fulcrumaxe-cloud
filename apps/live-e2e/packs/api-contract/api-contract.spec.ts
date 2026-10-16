// api-contract pack, row W21: the /api/v1 read surface, checked against the OpenAPI document the same deployment
// publishes. Read-only: GET requests only, as the owner session (and with none). Runs on the desktop project only; it
// has no browser. Pure checks live in expected.ts. A failure message names operations and JSON paths, never values.
import { expect, test } from "../../fixtures/session.js";
import type { ApiClient } from "../../src/client.js";
import { concretePath, listGetOperations, MUST_ANSWER_200, retryDelayMs, signedInViolations, signedOutViolations, type Operation } from "./expected.js";

test.use({ sessionRole: "owner" });
test.setTimeout(300_000);

const JSON_HEADERS = { accept: "application/json" };

async function loadOperations(api: ApiClient): Promise<Operation[]> {
  const res = await api.get("/api/v1/openapi.json", { headers: JSON_HEADERS });
  expect(res.status).toBe(200);
  return listGetOperations(JSON.parse(res.body));
}

/** One GET; a 429 is waited out once (the per-user session limit is 60 a minute), anything else is returned as it is. */
async function read(api: ApiClient, path: string) {
  const first = await api.get(path, { headers: JSON_HEADERS });
  if (first.status !== 429) return first;
  await new Promise((r) => setTimeout(r, retryDelayMs(first.headers.get("retry-after"))));
  return api.get(path, { headers: JSON_HEADERS });
}

test.describe("W21 the published document", () => {
  test("/api/v1/openapi.json is anonymous, cacheable, and lists the read surface", async ({ api }) => {
    const res = await api.get("/api/v1/openapi.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    const doc = JSON.parse(res.body) as { openapi?: string };
    expect(doc.openapi).toMatch(/^3\.1\./);
    const ops = listGetOperations(doc);
    expect(ops.length, "the document lists no GET operation").toBeGreaterThan(0);
    expect(ops.every((o) => o.template.startsWith("/api/v1/"))).toBe(true);
  });
});

test.describe("W21 signed out", () => {
  test("every documented GET answers 401 with the error envelope", async ({ api }) => {
    const ops = await loadOperations(api);
    const problems: string[] = [];
    for (const op of ops) {
      const res = await api.get(concretePath(op.template), { headers: JSON_HEADERS });
      problems.push(...signedOutViolations(op, res));
    }
    expect(problems).toEqual([]);
  });
});

test.describe("W21 signed in as the owner", () => {
  test("every GET that needs no id answers a documented status in the documented shape", async ({ api, session }) => {
    const ops = (await loadOperations(api)).filter((o) => !o.hasPathParam && !o.hasRequiredQuery && o.json);
    expect(ops.length, "no GET without an id").toBeGreaterThan(0);
    const me = JSON.parse((await read(session.api, "/api/cloud/auth/me")).body) as { workspace_access?: string };
    const open = me.workspace_access === "open";
    const problems: string[] = [];
    for (const op of ops) {
      const res = await read(session.api, op.template);
      problems.push(...signedInViolations(op, res, open && MUST_ANSWER_200.includes(op.template)));
    }
    expect(problems).toEqual([]);
  });

  test("an unknown id is refused with a documented 4xx and the error envelope, never served or a server fault", async ({ api, session }) => {
    const ops = (await loadOperations(api)).filter((o) => o.hasPathParam && !o.hasRequiredQuery && o.json);
    expect(ops.length, "no GET with an id").toBeGreaterThan(0);
    const problems: string[] = [];
    for (const op of ops) {
      const res = await read(session.api, concretePath(op.template));
      if (res.status === 200) problems.push(`${op.operationId}: the all-zero id was served`);
      else problems.push(...signedInViolations(op, res, false));
    }
    expect(problems).toEqual([]);
  });

  test("an out-of-range limit is a 422 naming the field", async ({ session }) => {
    const res = await read(session.api, "/api/v1/runs?limit=201");
    expect(res.status).toBe(422);
    const body = JSON.parse(res.body) as { error?: { code?: string }; details?: { path: string }[] };
    expect(body.error?.code).toBe("validation_failed");
    expect(body.details?.map((d) => d.path)).toContain("limit");
  });
});
