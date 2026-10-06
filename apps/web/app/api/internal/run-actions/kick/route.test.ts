import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { signKick } from "@fx/pipeline";
import { middleware } from "../../../../../middleware";

const started = vi.fn();
vi.mock("workflow/api", () => ({ start: (...args: unknown[]) => started(...args) }));

import { setWorkerWiringForTests } from "../../../../../lib/worker";
import { POST } from "./route";

/**
 * D#2 H14c-3b C2 at the HTTP layer: a bare 401 or a bare 202, the workflow started only for a
 * valid signature and a configured worker. The signature cases are in
 * packages/pipeline/test/runActions.test.ts; this covers the route wiring and R6 (middleware
 * lets the request through untouched).
 */
const SECRET = "kick-test-secret";
const ID = "11111111-1111-4111-8111-111111111111";
const BODY = JSON.stringify({ actionId: ID });
const URL = "https://example.test/api/internal/run-actions/kick";
const now = () => Math.floor(Date.now() / 1000);

function kick(body: string, header: string | null): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (header !== null) headers.set("x-fx-kick", header);
  return new Request(URL, { method: "POST", headers, body });
}
const signed = (body = BODY, t = now()) => `t=${t},sig=${signKick(SECRET, t, body)}`;

beforeEach(() => {
  started.mockReset();
  process.env.RUN_ACTION_KICK_SECRET = SECRET;
});
afterEach(() => {
  delete process.env.RUN_ACTION_KICK_SECRET;
  setWorkerWiringForTests();
});

describe("POST /api/internal/run-actions/kick", () => {
  it("a bad or missing or stale signature is a bare 401: no body, no workflow", async () => {
    for (const header of [null, `t=${now()},sig=${"0".repeat(64)}`, signed(BODY, now() - 600), signed("{}")]) {
      const res = await POST(kick(BODY, header));
      expect(res.status).toBe(401);
      expect(await res.text()).toBe("");
    }
    expect(started).not.toHaveBeenCalled();
  });

  it("with no kick secret configured everything is 401", async () => {
    delete process.env.RUN_ACTION_KICK_SECRET;
    expect((await POST(kick(BODY, signed()))).status).toBe(401);
  });

  it("while the worker provider is null (this PR) a valid kick is a bare 202 and performs nothing", async () => {
    const res = await POST(kick(BODY, signed()));
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
    expect(started).not.toHaveBeenCalled();
  });

  it("with a configured provider a valid kick is a bare 202 and starts the workflow with the id as its only argument", async () => {
    setWorkerWiringForTests({ provider: () => ({}) as never });
    const res = await POST(kick(BODY, signed()));
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
    expect(started).toHaveBeenCalledTimes(1);
    expect(started.mock.calls[0]![1]).toEqual([ID]);
  });

  it("a workflow start that throws is still a 202", async () => {
    setWorkerWiringForTests({ provider: () => ({}) as never });
    started.mockRejectedValueOnce(new Error("queue down"));
    expect((await POST(kick(BODY, signed()))).status).toBe(202);
  });

  it("R6: the middleware passes the kick through (no cookie, no Authorization: no CSRF or session step acts)", async () => {
    const req = new NextRequest(URL, { method: "POST", headers: { "content-type": "application/json", "x-fx-kick": signed() }, body: BODY });
    const res = await middleware(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });
});
