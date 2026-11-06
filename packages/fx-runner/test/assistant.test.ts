import { spawn } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { ALLOWED_TOOLS, startProxy, type Proxy } from "../src/assistant/proxy.js";
import { ASSISTANT_DIR, TOKEN_FILE, readAssistantToken, writeAssistantToken } from "../src/assistant/tokenFile.js";
import { saveRegistration } from "../src/config.js";
import { cleanEnv } from "../src/job/cleanEnv.js";
import { startAssistantCloud, tlsFetch, type AssistantCloud } from "./helpers/assistantCloud.js";
import { unixSocketsRefused } from "./helpers/needsHostSockets.js";

/** The proxy listens on a Unix socket; inside the runner's check or a job the sandbox refuses that family, so the tests that start it skip there and run everywhere else. */
const itProxy = unixSocketsRefused() ? it.skip : it;

const UID = process.getuid!();
const ITEM = "44444444-4444-4444-8444-444444444444";
const RUNNER = "55555555-5555-4555-8555-555555555555";
/** A planted secret and transcript line, built from parts so no token-shaped literal is in the source. */
const PLANTED = ["sk", "ant", "p1anted".repeat(5)].join("-");
const TRANSCRIPT = `${["the", "model", "said"].join(" ")} ${PLANTED}`;

const t0 = Date.parse("2026-11-02T12:00:00.000Z");
let clock = t0;
let cloud: AssistantCloud;
let root: string;
let state: string;
let proxy: Proxy | undefined;

const sleep = async (ms: number): Promise<void> => void (clock += ms);

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await runCli({ argv, home: undefined, stateDirOverride: state, uid: UID, now: () => new Date(clock), sleep, fetchFn: tlsFetch(cloud.ca), stdout: (x) => (out += x), stderr: (x) => (err += x) });
  return { code, out, err };
}

beforeEach(async () => {
  clock = t0;
  cloud = await startAssistantCloud(() => clock);
  root = mkdtempSync(path.join(tmpdir(), "fxr-asst-"));
  state = path.join(root, "state");
  mkdirSync(state, { mode: 0o700 });
  saveRegistration(state, { version: 1, cloud_origin: cloud.origin, runner_id: RUNNER, account_id: RUNNER, credential_mode: "subscription", jkt: "A".repeat(43), registered_at: new Date(clock).toISOString() });
});
afterEach(async () => {
  await proxy?.close();
  proxy = undefined;
  await cloud.close();
  rmSync(root, { recursive: true, force: true });
});

/** Links through the CLI: approve after `polls` pending answers. */
async function link(polls = 2): Promise<void> {
  let n = 0;
  const approving: typeof fetch = async (i, init) => {
    if (String(i).endsWith("/link/poll") && ++n > polls) cloud.approve();
    return tlsFetch(cloud.ca)(i, init);
  };
  let err = "";
  const code = await runCli({ argv: ["assistant", "link"], home: undefined, stateDirOverride: state, uid: UID, now: () => new Date(clock), sleep, fetchFn: approving, stdout: () => undefined, stderr: (x) => (err += x) });
  expect(err).toBe("");
  expect(code).toBe(0);
}

const startP = async (): Promise<Proxy> => (proxy = await startProxy({ stateDir: state, uid: UID, fetchFn: tlsFetch(cloud.ca), now: () => new Date(clock) }));

async function toolCall(p: Proxy, tool: string, args: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const http = await import("node:http");
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: p.socketPath, path: "/tool", method: "POST", headers: { authorization: `Bearer ${p.secret}` } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    req.on("error", reject);
    req.end(JSON.stringify({ tool, args }));
  });
}

describe("CC-7a-4 the link flow against the strict cloud fake, over real TLS", () => {
  it("shows the code, polls through pending, stores the token once at 0600 with the runner's client id", async () => {
    await link(2);
    const file = path.join(state, ASSISTANT_DIR, TOKEN_FILE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    const stored = readAssistantToken(state, UID);
    expect(stored.token).toBe(cloud.issuedToken());
    expect(stored.client_id).toBe(`runner-${RUNNER}`);
    expect(stored.token_id).toBe("11111111-1111-4111-8111-111111111111");
    expect(stored.origin).toBe(cloud.origin);
    const polls = cloud.seen.filter((s) => s.path.endsWith("/link/poll"));
    expect(polls).toHaveLength(3);
    expect(cloud.seen.every((s) => s.auth === undefined)).toBe(true);
  });

  it("prints the short code and where to approve it", async () => {
    let out = "";
    await runCli({ argv: ["assistant", "link"], home: undefined, stateDirOverride: state, uid: UID, now: () => new Date(clock), sleep, fetchFn: tlsFetch(cloud.ca), stdout: (x) => (out += x), stderr: () => undefined });
    expect(out).toContain("ABCD2345");
    expect(out).toContain(cloud.origin);
  });

  it("answers expired after 10 minutes of the fake clock, exits non-zero and stores nothing", async () => {
    const r = await run(["assistant", "link"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("assistant_link_expired");
    expect(r.err).toContain("assistant link");
    expect(clock - t0).toBeGreaterThanOrEqual(600_000);
    expect(() => lstatSync(path.join(state, ASSISTANT_DIR, TOKEN_FILE))).toThrow();
  });

  it("a second poll gets 409 and stores nothing", async () => {
    cloud.seen.length = 0;
    const fetchFn: typeof fetch = async (i, init) => {
      const r = await tlsFetch(cloud.ca)(i, init);
      if (String(i).endsWith("/link") && r.status === 201) cloud.redeemElsewhere();
      return r;
    };
    let err = "";
    const code = await runCli({ argv: ["assistant", "link"], home: undefined, stateDirOverride: state, uid: UID, now: () => new Date(clock), sleep, fetchFn, stdout: () => undefined, stderr: (x) => (err += x) });
    expect(code).not.toBe(0);
    expect(err).toContain("already redeemed");
    expect(() => lstatSync(path.join(state, ASSISTANT_DIR, TOKEN_FILE))).toThrow();
  });

  it("the fake really enforces the User-Agent: a call without ours is refused", async () => {
    const r = await tlsFetch(cloud.ca)(`${cloud.origin}/api/v1/assistant/link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_id: "x" }) });
    expect(r.status).toBe(400);
    await link(0);
    expect(cloud.seen.filter((s) => s.userAgent?.startsWith("fulcrumaxe-runner/")).length).toBeGreaterThan(1);
  });

  it("refuses an unknown subcommand and an unregistered machine", async () => {
    expect((await run(["assistant", "accept"])).code).toBe(2);
    rmSync(path.join(state, "registration.json"));
    expect((await run(["assistant", "link"])).err).toContain("not registered");
  });
});

describe("unlink, the undo path", () => {
  itProxy("revokes the token on the cloud, then removes the file; the proxy then has nothing to use", async () => {
    await link(0);
    cloud.seen.length = 0;
    const r = await run(["assistant", "unlink"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("revoked on the cloud");
    expect(cloud.seen.map((s) => `${s.method} ${s.path}`)).toEqual(["DELETE /api/v1/tokens/11111111-1111-4111-8111-111111111111"]);
    expect(cloud.seen[0]!.auth).toBe(`Bearer ${cloud.issuedToken()}`);
    expect(() => lstatSync(path.join(state, ASSISTANT_DIR, TOKEN_FILE))).toThrow();
    const p = await startP();
    expect((await toolCall(p, "list_corrections", { work_item_id: ITEM })).body.error).toBe("assistant_token_missing");
  });

  it("removes the file and says the token lapses when the cloud refuses the revoke or cannot be reached", async () => {
    await link(0);
    cloud.refuseRevoke = true;
    const refused = await run(["assistant", "unlink"]);
    expect(refused.code).toBe(0);
    expect(refused.out).toContain("expires within an hour");
    expect(refused.out).toContain("admin");
    expect(() => lstatSync(path.join(state, ASSISTANT_DIR, TOKEN_FILE))).toThrow();
    await link(0);
    let out = "";
    const offline: typeof fetch = async () => { throw new Error("offline"); };
    const code = await runCli({ argv: ["assistant", "unlink"], home: undefined, stateDirOverride: state, uid: UID, now: () => new Date(clock), sleep, fetchFn: offline, stdout: (x) => (out += x), stderr: () => undefined });
    expect(code).toBe(0);
    expect(out).toContain("expires within an hour");
    expect(() => lstatSync(path.join(state, ASSISTANT_DIR, TOKEN_FILE))).toThrow();
  });

  it("is safe to run twice, and removes a symlink in the token's place without following it", async () => {
    await link(0);
    expect((await run(["assistant", "unlink"])).code).toBe(0);
    cloud.seen.length = 0;
    const again = await run(["assistant", "unlink"]);
    expect(again.code).toBe(0);
    expect(again.out).toContain("No assistant token was stored");
    expect(cloud.seen).toHaveLength(0);
    const elsewhere = path.join(root, "keep");
    writeFileSync(elsewhere, "keep", { mode: 0o600 });
    symlinkSync(elsewhere, path.join(state, ASSISTANT_DIR, TOKEN_FILE));
    expect((await run(["assistant", "unlink"])).code).toBe(0);
    expect(readFileSync(elsewhere, "utf8")).toBe("keep");
    expect(() => lstatSync(path.join(state, ASSISTANT_DIR, TOKEN_FILE))).toThrow();
  });
});

describe("hardening", () => {
  it("bounds the poll by a local ceiling when the code's expiry is a day away", async () => {
    cloud.farExpiry = true;
    const r = await run(["assistant", "link"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("assistant_link_expired");
    expect(clock - t0).toBeLessThanOrEqual(15 * 60_000 + 30_000);
  });

  it("refuses to start the proxy when the state directory is open to others or is a link", async () => {
    chmodSync(state, 0o755);
    await expect(startProxy({ stateDir: state, uid: UID, fetchFn: tlsFetch(cloud.ca), now: () => new Date(clock) })).rejects.toThrow(/assistant_token_unsafe/);
    chmodSync(state, 0o700);
    const via = path.join(root, "via");
    symlinkSync(state, via);
    await expect(startProxy({ stateDir: via, uid: UID, fetchFn: tlsFetch(cloud.ca), now: () => new Date(clock) })).rejects.toThrow(/assistant_token_unsafe/);
    expect(readdirSync(state).filter((n) => n.startsWith("assistant-proxy-"))).toEqual([]);
  });

  itProxy("logs a fixed code and closes cleanly when the server fails after it started", async () => {
    const lines: string[] = [];
    proxy = await startProxy({ stateDir: state, uid: UID, fetchFn: tlsFetch(cloud.ca), now: () => new Date(clock), log: (l) => lines.push(l) });
    const dir = path.dirname(proxy.socketPath);
    proxy.server.emit("error", new Error(`secret-path-${PLANTED}`));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^assistant_link_failed: /);
    expect(lines[0]).not.toContain(PLANTED);
    expect(() => lstatSync(dir)).toThrow();
  });
});

describe("CC-7a-3 the token file", () => {
  const stored = () => ({ token: "t".repeat(10), token_id: "id-1", expires_at: new Date(clock + 3_600_000).toISOString(), repo_id: RUNNER, client_id: "c", origin: "https://x.test" });

  it("refuses a file wider than 0600 and tells the person to re-link", () => {
    writeAssistantToken(state, UID, stored());
    chmodSync(path.join(state, ASSISTANT_DIR, TOKEN_FILE), 0o644);
    expect(() => readAssistantToken(state, UID)).toThrow(/assistant_token_unsafe.*assistant link/);
    chmodSync(path.join(state, ASSISTANT_DIR, TOKEN_FILE), 0o640);
    expect(() => readAssistantToken(state, UID)).toThrow(/assistant_token_unsafe/);
  });

  it("refuses a symlinked token path and a symlinked directory, and writes through neither", () => {
    mkdirSync(path.join(state, ASSISTANT_DIR), { mode: 0o700 });
    const elsewhere = path.join(root, "elsewhere");
    writeFileSync(elsewhere, JSON.stringify(stored()), { mode: 0o600 });
    symlinkSync(elsewhere, path.join(state, ASSISTANT_DIR, TOKEN_FILE));
    expect(() => readAssistantToken(state, UID)).toThrow(/assistant_token_unsafe/);
    writeAssistantToken(state, UID, { ...stored(), token: "n".repeat(10) });
    expect(lstatSync(path.join(state, ASSISTANT_DIR, TOKEN_FILE)).isSymbolicLink()).toBe(false);
    expect(readFileSync(elsewhere, "utf8")).not.toContain("n".repeat(10));
    rmSync(path.join(state, ASSISTANT_DIR), { recursive: true });
    mkdirSync(path.join(root, "realdir"), { mode: 0o700 });
    symlinkSync(path.join(root, "realdir"), path.join(state, ASSISTANT_DIR));
    expect(() => readAssistantToken(state, UID)).toThrow(/assistant_token_unsafe/);
    expect(() => writeAssistantToken(state, UID, stored())).toThrow(/assistant_token_unsafe/);
  });

  itProxy("says missing when nothing is stored, a damaged file is unsafe, and the proxy refuses on either without calling the cloud", async () => {
    expect(() => readAssistantToken(state, UID)).toThrow(/assistant_token_missing/);
    writeAssistantToken(state, UID, stored());
    writeFileSync(path.join(state, ASSISTANT_DIR, TOKEN_FILE), "not json", { mode: 0o600 });
    expect(() => readAssistantToken(state, UID)).toThrow(/assistant_token_unsafe/);
    const p = await startP();
    const r = await toolCall(p, "list_corrections", { work_item_id: ITEM });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("assistant_token_unsafe");
    expect(cloud.seen).toHaveLength(0);
  });
});

describe("CC-7a-2 the proxy allowlist", () => {
  it("is exactly the corrections list, draft_correction and the six read tools", () => {
    expect([...ALLOWED_TOOLS]).toEqual(["list_corrections", "draft_correction", "get_item", "get_run_activity", "get_run", "get_run_events", "get_plan", "get_receipts"]);
  });

  itProxy("refuses every other tool name locally; the cloud receives 0 requests", async () => {
    await link(0);
    cloud.seen.length = 0;
    const p = await startP();
    const names = ["accept_correction", "approve", "approve_item", "merge", "merge_pr", "cancel_run", "halt_resume", "lift_halt", "reject_correction", "get_work_item", "list_runs", "get_spec", "LIST_CORRECTIONS", "list_corrections ", "list_corrections_accept", "__proto__", "constructor", ""];
    for (const name of names) {
      const r = await toolCall(p, name, { work_item_id: ITEM, kind: "pause", body: "x" });
      expect(r.status, name).toBe(403);
      expect(r.body.error, name).toBe("assistant_tool_refused");
    }
    expect(cloud.seen).toHaveLength(0);
  });

  itProxy("refuses a request without the session secret, and a path other than /tool", async () => {
    await link(0);
    cloud.seen.length = 0;
    const p = await startP();
    const http = await import("node:http");
    const status = (headers: Record<string, string>, url: string) => new Promise<number>((resolve) => { const r = http.request({ socketPath: p.socketPath, path: url, method: "POST", headers }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }); r.end("{}"); });
    expect(await status({}, "/tool")).toBe(403);
    expect(await status({ authorization: "Bearer wrong" }, "/tool")).toBe(403);
    expect(await status({ authorization: `Bearer ${p.secret}` }, "/other")).toBe(403);
    expect(cloud.seen).toHaveLength(0);
  });

  itProxy("lists corrections and drafts one through the real routes, adding the token itself", async () => {
    await link(0);
    cloud.seen.length = 0;
    const p = await startP();
    const list = await toolCall(p, "list_corrections", { work_item_id: ITEM });
    expect(list.status).toBe(200);
    const draft = await toolCall(p, "draft_correction", { work_item_id: ITEM, kind: "question", body: "why did this stop?" });
    expect(draft.status).toBe(201);
    expect(cloud.seen.map((s) => `${s.method} ${s.path}`)).toEqual([`GET /api/v1/work-items/${ITEM}/corrections`, `POST /api/v1/work-items/${ITEM}/corrections`]);
    expect(cloud.seen.every((s) => s.auth === `Bearer ${cloud.issuedToken()}`)).toBe(true);
    expect(JSON.stringify([list, draft])).not.toContain(cloud.issuedToken()!);
    expect((await toolCall(p, "draft_correction", { work_item_id: "../x", kind: "question", body: "x" })).status).toBe(400);
    expect((await toolCall(p, "draft_correction", { work_item_id: ITEM, kind: "question" })).status).toBe(400);
    expect(cloud.seen).toHaveLength(2);
  });
});

describe("CC-7a-6 a dead token", () => {
  itProxy("answers re-link on a 401 and sends nothing more with that token; a new link works again", async () => {
    await link(0);
    cloud.seen.length = 0;
    const p = await startP();
    cloud.revokeToken();
    const first = await toolCall(p, "list_corrections", { work_item_id: ITEM });
    expect(first.status).toBe(401);
    expect(first.body.error).toBe("assistant_relink");
    expect(String(first.body.message)).toContain("assistant link");
    expect(cloud.seen).toHaveLength(1);
    expect((await toolCall(p, "draft_correction", { work_item_id: ITEM, kind: "question", body: "x" })).body.error).toBe("assistant_relink");
    expect(cloud.seen).toHaveLength(1);
    expect(readAssistantToken(state, UID).token).toBe(cloud.issuedToken()); // nothing was deleted silently
    await link(0);
    expect((await toolCall(p, "list_corrections", { work_item_id: ITEM })).status).toBe(200);
  });

  itProxy("answers re-link without calling the cloud once the token's own time has passed", async () => {
    await link(0);
    cloud.seen.length = 0;
    const p = await startP();
    clock += 3_600_001;
    expect((await toolCall(p, "list_corrections", { work_item_id: ITEM })).body.error).toBe("assistant_relink");
    expect(cloud.seen).toHaveLength(0);
  });
});

describe("CC-7a-1 and CC-7a-5 the real child process, and every request body", () => {
  itProxy("never holds the token in its environment, argv or any file under its working directory, and no request body carries the transcript", async () => {
    await link(0);
    cloud.seen.length = 0;
    const token = cloud.issuedToken()!;
    const p = await startP();
    const cwd = path.join(root, "work");
    mkdirSync(path.join(cwd, "sub"), { recursive: true });
    writeFileSync(path.join(cwd, "transcript.jsonl"), `${JSON.stringify({ text: TRANSCRIPT })}\n`);
    const script = [
      "const http=require('node:http'),fs=require('node:fs');",
      "const out={env:process.env,argv:process.argv,cmdline:fs.readFileSync('/proc/self/cmdline','utf8')};",
      "const req=http.request({socketPath:process.env.FX_ASSISTANT_PROXY_SOCKET,path:'/tool',method:'POST',headers:{authorization:'Bearer '+process.env.FX_ASSISTANT_PROXY_SECRET}},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>{out.status=res.statusCode;console.log(JSON.stringify(out))})});",
      `req.end(JSON.stringify({tool:'draft_correction',args:{work_item_id:'${ITEM}',kind:'question',body:'is this the right Spec?'}}));`,
    ].join("");
    // Asynchronous on purpose: the proxy lives in this process and must keep answering while the child runs.
    const proc = spawn(process.execPath, ["-e", script, "--", "a-visible-arg"], { cwd, env: { ...cleanEnv({ mode: "subscription" }), ...p.env } });
    const io = { stdout: "", stderr: "" };
    proc.stdout.on("data", (c: Buffer) => (io.stdout += c));
    proc.stderr.on("data", (c: Buffer) => (io.stderr += c));
    const child = { ...io, status: await new Promise<number | null>((resolve) => proc.on("close", resolve)) };
    child.stdout = io.stdout;
    child.stderr = io.stderr;
    expect(child.status).toBe(0);
    const seenByChild = JSON.parse(child.stdout) as { env: Record<string, string>; argv: string[]; cmdline: string; status: number };
    expect(seenByChild.status).toBe(201); // the child really used the proxy
    expect(JSON.stringify(seenByChild)).not.toContain(token);
    expect(child.stdout + child.stderr).not.toContain(token);
    expect(Object.keys(seenByChild.env)).toEqual(expect.arrayContaining(["FX_ASSISTANT_PROXY_SOCKET", "FX_ASSISTANT_PROXY_SECRET"]));
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    for (const file of walk(cwd)) expect(readFileSync(file, "utf8"), file).not.toContain(token);
    // The session secret opens the proxy only; it is not the cloud token and the cloud refuses it.
    const direct = await tlsFetch(cloud.ca)(`${cloud.origin}/api/v1/work-items/${ITEM}/corrections`, { headers: { authorization: `Bearer ${p.secret}`, "user-agent": cloud.seen[0]!.userAgent! } });
    expect(direct.status).toBe(401);
    // C8: every serialised request body, and nothing that is not the model's own correction text.
    for (const s of cloud.seen) {
      expect(s.body).not.toContain(PLANTED);
      expect(s.body).not.toContain(TRANSCRIPT);
      expect(s.body).not.toContain(token);
      expect(s.path).not.toContain(PLANTED);
    }
    expect(cloud.seen.find((s) => s.method === "POST")!.body).toBe(JSON.stringify({ kind: "question", body: "is this the right Spec?" }));
  });
});
