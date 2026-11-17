import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCloudPost } from "../../src/engineBridge/commands.js";
import { DECIDE_BODY_MAX_BYTES, serveDecideSocket, socketPathFor, type DecideSocket, type DecideSocketDeps } from "../../src/engineBridge/decideSocket.js";
import { generateRunnerKey } from "../../src/keys.js";
import { startFakeCommands, type FakeCommands } from "../helpers/strictEngineCommands.js";

const REPO = 77;
const uid = process.getuid?.();
const BODY = { repo_gh_id: REPO, decision_type: "engine_spawn", request_key: "spawn:abc", subject: { discussion: 12, role: "executor" } };

let runtime: string;
let cloud: FakeCommands;
let logs: string[];
let operate: boolean | undefined;
let socket: DecideSocket | undefined;
let paired: number[];
let socketPath: string;

beforeEach(async () => {
  runtime = mkdtempSync(path.join(tmpdir(), "fx-eb8b-rt-"));
  chmodSync(runtime, 0o700);
  socketPath = path.join(runtime, "fx-runner", "engine-bridge.sock");
  cloud = await startFakeCommands();
  logs = [];
  operate = undefined;
  paired = [REPO];
  socket = undefined;
});
afterEach(async () => {
  await socket?.close();
  await cloud.close();
  rmSync(runtime, { recursive: true, force: true });
});

async function start(over: Partial<DecideSocketDeps> = {}): Promise<DecideSocket> {
  const key = generateRunnerKey();
  cloud.trust(key.publicJwk);
  socket = await serveDecideSocket({
    socketPath,
    uid,
    post: createCloudPost({ origin: cloud.origin, key, now: () => new Date(), fetchFn: fetch }),
    pairedRepos: () => paired,
    operateEnabled: () => operate,
    log: (l) => logs.push(l),
    ...over,
  });
  return socket;
}

function call(method: string, url: string, body?: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method, path: url, headers: body === undefined ? {} : { "content-type": "application/json" } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    req.on("error", reject);
    req.end(body);
  });
}
const decide = (body: unknown = BODY) => call("POST", "/api/runner/engine/decide", JSON.stringify(body));

describe("the socket", () => {
  it("is mode 0600 in a 0700 directory, and a stale socket from an earlier run is replaced", async () => {
    mkdirSync(path.dirname(socketPath), { mode: 0o700 });
    // a process that listens and is killed leaves the socket file behind, as a crashed runner would
    spawnSync(process.execPath, ["-e", "require('node:net').createServer().listen(process.argv[1], () => process.kill(process.pid, 'SIGKILL'))", socketPath]);
    expect(lstatSync(socketPath).isSocket()).toBe(true);
    await start();
    expect(lstatSync(socketPath).isSocket()).toBe(true);
    expect(lstatSync(socketPath).mode & 0o777).toBe(0o600);
    expect(lstatSync(path.dirname(socketPath)).mode & 0o777).toBe(0o700);
    expect((await decide()).status).toBe(200);
  });

  it("makes the directory at 0700 when it is missing", async () => {
    await start();
    expect(lstatSync(path.dirname(socketPath)).mode & 0o777).toBe(0o700);
  });

  it("is refused in a directory open to the group or others, and in a link", async () => {
    mkdirSync(path.dirname(socketPath), { mode: 0o755 });
    chmodSync(path.dirname(socketPath), 0o755);
    await expect(start()).rejects.toThrow("open to other users");
    rmSync(path.dirname(socketPath), { recursive: true });
    const real = mkdtempSync(path.join(tmpdir(), "fx-eb8b-real-"));
    chmodSync(real, 0o700);
    symlinkSync(real, path.dirname(socketPath));
    await expect(start()).rejects.toThrow("not a plain directory");
    expect(() => lstatSync(path.join(real, "engine-bridge.sock"))).toThrow();
    rmSync(real, { recursive: true });
  });

  it("is refused where something that is not a socket is at the path, and leaves that file alone", async () => {
    mkdirSync(path.dirname(socketPath), { mode: 0o700 });
    writeFileSync(socketPath, "keep me", { mode: 0o600 });
    await expect(start()).rejects.toThrow("not a socket");
    expect(lstatSync(socketPath).isFile()).toBe(true);
  });

  it("is removed when it is closed, and its path comes from XDG_RUNTIME_DIR only when that is absolute", async () => {
    const s = await start();
    await s.close();
    socket = undefined;
    expect(() => lstatSync(socketPath)).toThrow();
    expect(socketPathFor({ XDG_RUNTIME_DIR: "/run/user/1000" })).toBe("/run/user/1000/fx-runner/engine-bridge.sock");
    expect(() => socketPathFor({})).toThrow();
    expect(() => socketPathFor({ XDG_RUNTIME_DIR: "relative" })).toThrow();
  });
});

describe("POST /api/runner/engine/decide", () => {
  it("forwards a valid request to the cloud in a signed request and returns the cloud's answer", async () => {
    await start();
    cloud.decideAnswer = { status: 200, body: { disposition: "ask", receipt_id: "5d1e0c2a-9b3f-4a7e-8c6d-2b4f6a8c0e1d", ask_id: null, answered: null, halted: false } };
    const answer = await decide();
    expect(answer).toEqual({ status: 200, body: cloud.decideAnswer.body });
    expect(cloud.decides).toEqual([BODY]);
  });

  it("refuses a repo this runner is not paired with, and sends nothing to the cloud", async () => {
    await start();
    expect(await decide({ ...BODY, repo_gh_id: REPO + 1 })).toEqual({ status: 403, body: { error: "wrong_repo" } });
    expect(cloud.decides).toEqual([]);
  });

  it("refuses while the last pull said operate is off, and sends nothing to the cloud", async () => {
    await start();
    operate = false;
    expect(await decide()).toEqual({ status: 403, body: { error: "operate_off" } });
    expect(cloud.decides).toEqual([]);
    operate = true;
    expect((await decide()).status).toBe(200);
  });

  it("refuses a body that is not exactly a decide request", async () => {
    await start();
    for (const bad of [{ ...BODY, extra: 1 }, { ...BODY, decision_type: "engine_nothing" }, { ...BODY, request_key: "has space" }, { repo_gh_id: REPO }, [], "x"]) {
      expect(await decide(bad)).toEqual({ status: 400, body: { error: "invalid_request" } });
    }
    expect(await call("POST", "/api/runner/engine/decide", "{not json")).toEqual({ status: 400, body: { error: "invalid_request" } });
    expect(cloud.decides).toEqual([]);
  });

  it("refuses a body over the cap, another path and another method", async () => {
    await start();
    const big = await call("POST", "/api/runner/engine/decide", "x".repeat(DECIDE_BODY_MAX_BYTES + 1)).catch(() => ({ status: 413 }));
    expect([413, 400]).toContain(big.status);
    expect(await call("POST", "/api/runner/engine/other", "{}")).toEqual({ status: 404, body: { error: "not_found" } });
    expect(await call("GET", "/api/runner/engine/decide")).toEqual({ status: 405, body: { error: "method_not_allowed" } });
    expect(cloud.decides).toEqual([]);
  });

  it("passes the cloud's refusal as one fixed word, and an unreachable or malformed cloud as 502", async () => {
    await start();
    cloud.decideAnswer = { status: 403, body: { error: "operate_off", detail: "secret text" } };
    expect(await decide()).toEqual({ status: 403, body: { error: "operate_off" } });
    cloud.decideAnswer = { status: 409, body: { error: "Not A Word: sk-test-secret" } };
    expect(await decide()).toEqual({ status: 409, body: { error: "cloud_error" } });
    cloud.decideAnswer = { status: 409, body: { error: "some_other_cloud_word" } };
    expect(await decide()).toEqual({ status: 409, body: { error: "cloud_error" } });
    cloud.faults.push({ status: 200, body: { nope: true } });
    expect(await decide()).toEqual({ status: 502, body: { error: "cloud_error" } });
    cloud.faults.push("drop");
    expect(await decide()).toEqual({ status: 502, body: { error: "cloud_unreachable" } });
    expect(logs.join("\n")).not.toContain("secret");
  });
});
