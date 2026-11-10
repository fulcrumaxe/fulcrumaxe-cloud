import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readVerifyAnswer, withAnswerFile } from "../../src/daemon/answerFile.js";
import { groundAnswer } from "../../src/verifyBrowser/ground.js";
import { IDENTITY_PATH, MAX_IDENTITY_BYTES, signedInAs, type IdentityResponse } from "../../src/verifyBrowser/identity.js";
import { parseBase } from "../../src/verifyBrowser/pin.js";
import { DEPLOY_VERIFIER_ROLE } from "@fulcrumaxe/runner-protocol";
import { tmpRoot } from "../helpers/tmpRoot.js";
import { rig, type FakePage } from "./harness.js";

/**
 * D#749 V2c-2b (security review of the playwright PR): the signed-in account is recorded by the SERVER, from the app's own identity route, and never by the model. The route is
 * `GET /api/cloud/auth/me` (apps/web/lib/shell/session-routes.ts; the login is its `username` field).
 */
const PAGES: Record<string, FakePage> = { "/": { text: "Dashboard\nCount: 3", elements: [{ name: "Add item", tag: "button" }] } };
const ENVELOPE = (extra: Record<string, unknown> = {}) => ({
  journeys: [{ id: "c1", result: "pass", steps: [{ did: "looked", dom_fact: "Count: 3", number: 3 }], console_errors: 0, undo_checked: true, reloaded: true }],
  ...extra,
});
const answerOf = (dir: string): Record<string, unknown> => JSON.parse(readFileSync(path.join(dir, "answer.json"), "utf8")) as Record<string, unknown>;

async function seen() {
  const r = rig(PAGES);
  await r.call("open", { path: "/" });
  await r.call("snapshot");
  return r;
}

describe("the server records who the session is signed in as", () => {
  it("writes the login the identity lookup gave as the top-level signed_in_as", async () => {
    const r = await seen();
    r.driver()!.login = "octo-cat";
    expect((await r.call("submit_answer", { envelope: ENVELOPE() })).isError).toBe(false);
    expect(answerOf(r.jobDir)).toEqual({ ...ENVELOPE(), signed_in_as: "octo-cat" });
    await r.server.stop();
  });

  it("leaves the field out when the lookup gives nothing", async () => {
    const r = await seen();
    r.driver()!.login = undefined;
    expect((await r.call("submit_answer", { envelope: ENVELOPE() })).isError).toBe(false);
    expect(Object.keys(answerOf(r.jobDir))).toEqual(["journeys"]);
    await r.server.stop();
  });

  it("leaves the field out when the lookup itself throws", async () => {
    const r = await seen();
    r.driver()!.identity = async () => {
      throw new Error("network down");
    };
    expect((await r.call("submit_answer", { envelope: ENVELOPE() })).isError).toBe(false);
    expect(Object.keys(answerOf(r.jobDir))).toEqual(["journeys"]);
    await r.server.stop();
  });

  it("refuses a signed_in_as the model supplies, as an object or as JSON text, and writes nothing; the server's own value is never replaced by it", async () => {
    const r = await seen();
    r.driver()!.login = "octo-cat";
    for (const envelope of [ENVELOPE({ signed_in_as: "the-admin" }), JSON.stringify(ENVELOPE({ signed_in_as: "the-admin" })), ENVELOPE({ signed_in_as: "" }), ENVELOPE({ signed_in_as: 7 })]) {
      const out = await r.call("submit_answer", { envelope });
      expect(out.isError).toBe(true);
      expect(out.text).toContain("signed_in_as_not_allowed");
    }
    expect(existsSync(path.join(r.jobDir, "answer.json"))).toBe(false);
    expect((await r.call("submit_answer", { envelope: ENVELOPE() })).isError).toBe(false);
    expect(answerOf(r.jobDir)["signed_in_as"]).toBe("octo-cat");
    await r.server.stop();
  });

  it("the envelope check takes signed_in_as only where the caller allows it, and then only a plain 1-100 character string", () => {
    const trace = { sawFact: () => true, sawNumber: () => true };
    expect(groundAnswer(ENVELOPE({ signed_in_as: "octo-cat" }), trace)).toEqual({ ok: false, reason: "signed_in_as_not_allowed" });
    expect(groundAnswer(ENVELOPE({ signed_in_as: "octo-cat" }), trace, { signedInAs: true }).ok).toBe(true);
    for (const bad of ["", "x".repeat(101), "a\nb", "a\u0000b", "a\u007fb", 7, null, ["a"]]) expect(groundAnswer(ENVELOPE({ signed_in_as: bad }), trace, { signedInAs: true }).ok, JSON.stringify(bad)).toBe(false);
    expect(groundAnswer(ENVELOPE({ signed_in_as: "x".repeat(100) }), trace, { signedInAs: true }).ok).toBe(true);
    expect(groundAnswer(ENVELOPE({ other: 1 }), trace, { signedInAs: true }).ok).toBe(false);
  });
});

describe("the identity lookup", () => {
  let app: Server;
  let other: Server;
  let base = "";
  let otherBase = "";
  /** What the next request to the app's identity path answers. */
  let reply: (res: import("node:http").ServerResponse) => void = () => undefined;
  beforeAll(async () => {
    other = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ username: "someone-else" }));
    });
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
    otherBase = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
    app = createServer((req, res) => {
      if (req.url !== IDENTITY_PATH) {
        res.statusCode = 404;
        return void res.end();
      }
      reply(res);
    });
    await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(app.address() as AddressInfo).port}/`;
  });
  afterAll(async () => {
    await new Promise((resolve) => app.close(resolve));
    await new Promise((resolve) => other.close(resolve));
  });

  /** The lookup over a real connection. `follow`: a client that follows redirects, to prove the answer's own address is checked too. */
  const lookup = (follow: boolean) => signedInAs(async (url) => {
    const res = await fetch(url, { redirect: follow ? "follow" : "manual" });
    const body = Buffer.from(await res.arrayBuffer());
    const adapted: IdentityResponse = { status: () => res.status, url: () => res.url, headers: () => Object.fromEntries(res.headers.entries()), body: async () => body };
    return adapted;
  }, parseBase(base)!);
  const json = (body: unknown, status = 200) => (res: import("node:http").ServerResponse) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };

  it("reads the login from the username field of the app's own answer", async () => {
    reply = json({ username: "octo-cat", email: "a@b.test", is_admin: true });
    expect(await lookup(false)).toBe("octo-cat");
  });

  it("a redirect to another origin gives no login, whether the client follows it or not", async () => {
    reply = (res) => {
      res.statusCode = 302;
      res.setHeader("location", `${otherBase}/api/cloud/auth/me`);
      res.end();
    };
    expect(await lookup(false)).toBeUndefined();
    expect(await lookup(true)).toBeUndefined();
  });

  it("a redirect that ends back on the same origin is still a redirect: no login", async () => {
    reply = (res) => {
      res.statusCode = 302;
      res.setHeader("location", `${IDENTITY_PATH}?again=1`);
      res.end();
    };
    expect(await lookup(true)).toBeUndefined();
  });

  it("an oversize body gives no login, with or without a declared length", async () => {
    const pad = "x".repeat(MAX_IDENTITY_BYTES + 10);
    reply = json({ username: "octo-cat", pad });
    expect(await lookup(false)).toBeUndefined();
    reply = (res) => {
      res.setHeader("transfer-encoding", "chunked");
      res.write(JSON.stringify({ username: "octo-cat" }).slice(0, -1));
      res.write(" ".repeat(MAX_IDENTITY_BYTES));
      res.end("}");
    };
    expect(await lookup(false)).toBeUndefined();
  });

  it("a non-200 answer, a body that is not an object, and a login that is not a plain 1-100 character string give no login", async () => {
    reply = json({ username: "octo-cat" }, 401);
    expect(await lookup(false)).toBeUndefined();
    for (const body of ["[]", "null", "not json", JSON.stringify({ username: "" }), JSON.stringify({ username: 5 }), JSON.stringify({ username: "a\nb" }), JSON.stringify({ username: "x".repeat(101) }), JSON.stringify({ name: "octo-cat" })]) {
      reply = json(body);
      expect(await lookup(false), body).toBeUndefined();
    }
  });
});

describe("the daemon reports the field", () => {
  const root = mkdtempSync(path.join(tmpRoot(), "signed-in-as-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const UID = process.getuid?.() ?? 0;
  const write = (runId: string, value: unknown, mode = 0o600) => {
    mkdirSync(path.join(root, runId), { recursive: true });
    writeFileSync(path.join(root, runId, "answer.json"), typeof value === "string" ? value : JSON.stringify(value), { mode });
    chmodSync(path.join(root, runId, "answer.json"), mode);
  };

  it("an answer file that holds signed_in_as is read with it, and a done run carries it in agentOutput", () => {
    write("run-with", ENVELOPE({ signed_in_as: "octo-cat" }));
    const answer = readVerifyAnswer(root, "run-with", UID);
    expect(answer).toEqual(ENVELOPE({ signed_in_as: "octo-cat" }));
    const done = withAnswerFile({ role: DEPLOY_VERIFIER_ROLE, browser_method: "playwright_runner" }, { status: "done", agentOutput: { journeys: "model text" } }, () => answer, "run-with");
    expect(done).toEqual({ status: "done", agentOutput: ENVELOPE({ signed_in_as: "octo-cat" }) });
  });

  it("a file without it is read without it; a file with a malformed one is no answer", () => {
    write("run-without", ENVELOPE());
    expect(readVerifyAnswer(root, "run-without", UID)).toEqual(ENVELOPE());
    for (const bad of ["", "x".repeat(101), "a\nb", 5]) {
      write("run-bad-login", ENVELOPE({ signed_in_as: bad }));
      expect(readVerifyAnswer(root, "run-bad-login", UID), JSON.stringify(bad)).toBeUndefined();
    }
  });
});
