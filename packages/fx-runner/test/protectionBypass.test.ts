import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { isProtectedDeployment, refusalError, signedPost } from "../src/cloud.js";
import { createRunnerClient } from "../src/daemon/client.js";
import { generateRunnerKey } from "../src/keys.js";
import { BYPASS_HEADER, bypassHeaders, bypassRefusalText, loadBypass, type BypassPlace } from "../src/protectionBypass.js";
import { CODE, useRig } from "./cli/harness.js";
import { VERCEL_PROTECTED_BODY, ownCloud401Response, vercelProtectedResponse } from "./helpers/vercelProtected.js";

// Built from parts at run time, so no scanner sees a literal that looks like a live key.
const SECRET = ["bp", "fixture", "AbCdEf0123456789"].join("-");
const uid = process.getuid!();
let dir: string;
let home: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fxr-bypass-"));
  // The user's home for these tests: the file lives under it, in the state directory, which is where the README says to put it.
  home = path.join(dir, "home");
  mkdirSync(path.join(home, ".fx-runner"), { recursive: true, mode: 0o700 });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function secretFile(content = `${SECRET}\n`, mode = 0o600, name = "bypass"): string {
  const file = path.join(home, ".fx-runner", name);
  writeFileSync(file, content, { mode });
  chmodSync(file, mode);
  return file;
}

const where = (over: Partial<BypassPlace> = {}): BypassPlace => ({ home, platform: "linux", ...over });
const load = (file: string | undefined, id: number | undefined, place: BypassPlace | undefined = where()) => loadBypass(file, id, place);

describe("loadBypass: the file", () => {
  it("unset or empty is unset", () => {
    expect(load(undefined, uid)).toEqual({ kind: "unset" });
    expect(load("", uid)).toEqual({ kind: "unset" });
  });

  it("a plain file of mine at 0600 or stricter gives the value, without its trailing newline", () => {
    expect(load(secretFile(), uid)).toEqual({ kind: "ok", secret: SECRET });
    expect(load(secretFile(SECRET, 0o400, "ro"), uid)).toEqual({ kind: "ok", secret: SECRET });
  });

  it("refuses a file others can read or write, whatever the bit", () => {
    for (const mode of [0o644, 0o640, 0o604, 0o660, 0o602, 0o666]) expect(load(secretFile(SECRET, mode, `m${mode}`), uid), mode.toString(8)).toEqual({ kind: "refused", code: "bypass_file_mode" });
  });

  it("refuses a file owned by someone else, and any file when the user id is unknown", () => {
    const file = secretFile();
    expect(load(file, uid + 1)).toEqual({ kind: "refused", code: "bypass_file_not_owned" });
    expect(load(file, undefined)).toEqual({ kind: "refused", code: "bypass_file_not_owned" });
  });

  it("refuses a link (even to a good file), a directory and a missing file", () => {
    const file = secretFile();
    const link = path.join(dir, "link");
    symlinkSync(file, link);
    expect(load(link, uid)).toEqual({ kind: "refused", code: "bypass_file_not_regular" });
    const sub = path.join(dir, "sub");
    mkdirSync(sub, { mode: 0o700 });
    expect(load(sub, uid)).toEqual({ kind: "refused", code: "bypass_file_not_regular" });
    expect(load(path.join(dir, "missing"), uid)).toEqual({ kind: "refused", code: "bypass_file_unreadable" });
  });

  it("refuses an empty value, one with spaces or control characters, a long one and a big file", () => {
    for (const [name, content] of [["empty", "\n"], ["space", "two words"], ["ctl", "a\u0001b"], ["nonascii", "café"], ["long", "x".repeat(257)], ["big", "x".repeat(5000)]] as const) {
      expect(load(secretFile(content, 0o600, name), uid), name).toEqual({ kind: "refused", code: "bypass_file_invalid" });
    }
  });

  it("a refusal never carries the value", () => {
    const result = load(secretFile(`${SECRET} with a space`, 0o600, "spaced"), uid);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});

describe("loadBypass: where the file lives", () => {
  const refused = { kind: "refused", code: "bypass_file_location" };
  /** A good file (mine, 0600, one clean value) at `file`, parents made. */
  function put(file: string): string {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${SECRET}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
    return file;
  }

  it("a file under the home directory is accepted, in the state directory or anywhere else there", () => {
    expect(load(put(path.join(home, ".fx-runner", "bypass")), uid)).toEqual({ kind: "ok", secret: SECRET });
    expect(load(put(path.join(home, "secrets", "staging", "bypass")), uid)).toEqual({ kind: "ok", secret: SECRET });
    // Beside the cache directories, not in one: still home, and the sandbox does not re-allow it.
    expect(load(put(path.join(home, ".cache", "other", "bypass")), uid)).toEqual({ kind: "ok", secret: SECRET });
    expect(load(put(path.join(home, ".cache", "fx-runner", "bypass")), uid)).toEqual({ kind: "ok", secret: SECRET });
  });

  it("a file outside the home directory is refused, in another directory and in the system temp directory", () => {
    expect(load(put(path.join(dir, "elsewhere", "bypass")), uid)).toEqual(refused);
    const inTmp = put(path.join(tmpdir(), `fxr-loc-${randomUUID()}`));
    try {
      expect(load(inTmp, uid)).toEqual(refused);
    } finally {
      rmSync(inTmp, { force: true });
    }
  });

  it("the home directory's own sibling that shares its name prefix is outside it", () => {
    expect(load(put(path.join(dir, "home-other", "bypass")), uid)).toEqual(refused);
  });

  it("a file under a directory the sandbox re-allows for reads is refused: workspaces, job temp directories and mirrors", () => {
    for (const root of ["workspaces", "tmp", "mirrors"]) {
      const base = path.join(home, ".cache", "fx-runner", root);
      expect(load(put(path.join(base, "bypass")), uid), root).toEqual(refused);
      expect(load(put(path.join(base, "job-1", "deep", "bypass")), uid), `${root} deep`).toEqual(refused);
    }
  });

  it("the re-allowed roots move with XDG_CACHE_HOME and with the platform, the way the job runner computes them", () => {
    expect(load(put(path.join(home, "xdg", "fx-runner", "workspaces", "bypass")), uid, where({ xdgCacheHome: path.join(home, "xdg") }))).toEqual(refused);
    expect(load(put(path.join(home, "Library", "Caches", "fx-runner", "tmp", "bypass")), uid, where({ platform: "darwin" }))).toEqual(refused);
    // The default Linux cache directory is not a re-allowed place on macOS, and the reverse.
    expect(load(put(path.join(home, ".cache", "fx-runner", "workspaces", "ok-on-mac")), uid, where({ platform: "darwin" }))).toEqual({ kind: "ok", secret: SECRET });
  });

  it("a link in a parent directory that leads out of the home directory is refused", () => {
    const outside = path.dirname(put(path.join(dir, "outside", "bypass")));
    symlinkSync(outside, path.join(home, "via-link"));
    expect(load(path.join(home, "via-link", "bypass"), uid)).toEqual(refused);
  });

  it("a link in a parent directory that leads into a re-allowed root is refused", () => {
    const base = path.dirname(put(path.join(home, ".cache", "fx-runner", "workspaces", "job-1", "bypass")));
    symlinkSync(base, path.join(home, "jobs"));
    expect(load(path.join(home, "jobs", "bypass"), uid)).toEqual(refused);
  });

  it("a link as the file itself is not regular, whatever it points to", () => {
    const target = put(path.join(dir, "outside", "bypass"));
    symlinkSync(target, path.join(home, ".fx-runner", "link"));
    expect(load(path.join(home, ".fx-runner", "link"), uid)).toEqual({ kind: "refused", code: "bypass_file_not_regular" });
  });

  it("a file whose real path is another file than the open handle is refused (a swap between the steps)", () => {
    const opened = put(path.join(home, ".fx-runner", "opened"));
    const other = put(path.join(home, ".fx-runner", "other"));
    expect(load(opened, uid, where({ realpath: () => other }))).toEqual(refused);
    // The same seam resolving to the right file is the happy path, so the mismatch above is what refused it.
    expect(load(opened, uid, where({ realpath: () => opened }))).toEqual({ kind: "ok", secret: SECRET });
  });

  it("a real path that cannot be resolved is refused", () => {
    const file = put(path.join(home, ".fx-runner", "bypass"));
    expect(load(file, uid, where({ realpath: () => { throw new Error(`gone: ${file}`); } }))).toEqual(refused);
  });

  it("no home directory, or a relative one, accepts no file", () => {
    const file = put(path.join(home, ".fx-runner", "bypass"));
    expect(load(file, uid, where({ home: undefined }))).toEqual(refused);
    expect(load(file, uid, where({ home: "relative/home" }))).toEqual(refused);
    expect(loadBypass(file, uid, undefined)).toEqual(refused);
  });

  it("a relative file path is refused", () => {
    put(path.join(home, ".fx-runner", "bypass"));
    expect(load(path.relative(process.cwd(), path.join(home, ".fx-runner", "bypass")), uid)).toEqual(refused);
  });

  it("the refusal text names the code and where the file must be, and carries no path or value", () => {
    const text = bypassRefusalText("bypass_file_location");
    expect(text).toContain("bypass_file_location");
    expect(text).toContain("home directory");
    expect(text).not.toContain(dir);
    expect(text).not.toContain(SECRET);
  });
});

describe("bypassHeaders: which requests carry it", () => {
  const origin = "https://cloud.example.test";
  it("the registered origin, exactly", () => {
    expect(bypassHeaders(SECRET, origin, `${origin}/api/runner/claim`)).toEqual({ [BYPASS_HEADER]: SECRET });
  });
  it("no other host, port, scheme or look-alike", () => {
    for (const url of [
      "https://github.com/x/y.git",
      "https://git-proxy.example.test/x",
      "https://cloud.example.test:8443/x",
      "http://cloud.example.test/x",
      "https://sub.cloud.example.test/x",
      "https://cloud.example.test.evil.test/x",
      "https://cloud.example.test@evil.test/x",
      "https://evil.test/?u=https://cloud.example.test",
      "not a url",
    ]) {
      expect(bypassHeaders(SECRET, origin, url), url).toEqual({});
    }
  });
  it("nothing when there is no secret", () => {
    expect(bypassHeaders(undefined, origin, `${origin}/x`)).toEqual({});
  });
});

interface Listener {
  origin: string;
  seen: Array<{ url: string; headers: IncomingHttpHeaders }>;
  server: Server;
}
async function listen(handler: (url: string, headers: IncomingHttpHeaders) => { status: number; headers?: Record<string, string>; body?: string }): Promise<Listener> {
  const seen: Listener["seen"] = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url ?? "", headers: req.headers });
    req.resume();
    const reply = handler(req.url ?? "", req.headers);
    res.writeHead(reply.status, { "content-type": "application/json", ...(reply.headers ?? {}) });
    res.end(reply.body ?? "{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, server };
}
const close = (l: Listener): Promise<void> => new Promise((resolve) => l.server.close(() => resolve()));

describe("signedPost over a real connection", () => {
  const key = generateRunnerKey();
  it("sends the header to the registered origin", async () => {
    const cloud = await listen(() => ({ status: 200 }));
    try {
      await signedPost({ origin: cloud.origin, path: "/api/runner/claim", body: {}, key, now: new Date(), fetchFn: fetch, bypass: SECRET });
      expect(cloud.seen[0]!.headers[BYPASS_HEADER]).toBe(SECRET);
    } finally {
      await close(cloud);
    }
  });

  it("without a secret sends no such header", async () => {
    const cloud = await listen(() => ({ status: 200 }));
    try {
      await signedPost({ origin: cloud.origin, path: "/api/runner/claim", body: {}, key, now: new Date(), fetchFn: fetch });
      expect(cloud.seen[0]!.headers[BYPASS_HEADER]).toBeUndefined();
    } finally {
      await close(cloud);
    }
  });

  it("a redirect from the cloud is not followed, so the header never reaches the other host", async () => {
    const other = await listen(() => ({ status: 200 }));
    const cloud = await listen(() => ({ status: 302, headers: { location: `${other.origin}/steal` } }));
    try {
      await expect(signedPost({ origin: cloud.origin, path: "/api/runner/claim", body: {}, key, now: new Date(), fetchFn: fetch, bypass: SECRET })).rejects.toThrow(/could not reach the cloud/);
      expect(cloud.seen).toHaveLength(1);
      expect(other.seen).toEqual([]);
    } finally {
      await close(cloud);
      await close(other);
    }
  });

  it("a different host on another port is a different origin: it gets nothing, even with the same secret in play", async () => {
    const cloud = await listen(() => ({ status: 200 }));
    const other = await listen(() => ({ status: 200 }));
    try {
      // The registered origin is `cloud`; a request URL on `other` (a git proxy, say) is judged against it.
      expect(bypassHeaders(SECRET, cloud.origin, `${other.origin}/x`)).toEqual({});
      const response = await fetch(`${other.origin}/x`, { headers: bypassHeaders(SECRET, cloud.origin, `${other.origin}/x`) });
      await response.arrayBuffer();
      expect(other.seen[0]!.headers[BYPASS_HEADER]).toBeUndefined();
    } finally {
      await close(cloud);
      await close(other);
    }
  });
});

describe("every cloud call goes through the one layer", () => {
  it("claim, heartbeat, events, done and git-ticket all carry the header, to the cloud's origin only", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: init?.headers as Record<string, string> });
      return new Response("{}", { status: 500, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const origin = "https://cloud.example.test";
    const client = createRunnerClient({ origin, key: generateRunnerKey(), now: () => new Date(), fetchFn, bypass: SECRET });
    const run = randomUUID();
    await client.claim();
    await client.heartbeat(run, 1);
    await client.events(run, 1, [{ seq: 0, ts: "2026-10-08T12:00:00.000Z", type: "tool_use", tool_name: "Read" }]);
    await client.done({ runId: run, leaseGeneration: 1 });
    await client.gitTicket(run, 1);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/api/runner/claim", "/api/runner/heartbeat", `/api/runner/runs/${run}/events`, `/api/runner/runs/${run}/done`, "/api/runner/git-ticket"].map((p) => p));
    for (const call of calls) {
      expect(new URL(call.url).origin).toBe(origin);
      expect(call.headers[BYPASS_HEADER]).toBe(SECRET);
    }
  });
});

describe("Vercel's protected-deployment 401", () => {
  it("is recognised in the real captured response", () => {
    expect(isProtectedDeployment(401, "Vercel", VERCEL_PROTECTED_BODY)).toBe(true);
    // The body decides: the header is not needed.
    expect(isProtectedDeployment(401, null, VERCEL_PROTECTED_BODY)).toBe(true);
  });

  it("either body signal alone is enough", () => {
    expect(isProtectedDeployment(401, null, { protection: { vercel_auth_enabled: true } })).toBe(true);
    expect(isProtectedDeployment(401, null, { error: { code: "401", message: "Protected deployment" } })).toBe(true);
  });

  it("the server header never decides alone", () => {
    expect(isProtectedDeployment(401, "Vercel", undefined)).toBe(false);
    expect(isProtectedDeployment(401, "vercel", "<html>")).toBe(false);
    expect(isProtectedDeployment(401, "Vercel", { error: { code: "401" } })).toBe(false);
    // Supporting only: a `protection` object (for example password protection) plus the Vercel header.
    expect(isProtectedDeployment(401, "Vercel", { protection: { vercel_auth_enabled: false, password_enabled: true } })).toBe(true);
  });

  it("is not a protection 401 when the status, the flag or the message is off", () => {
    expect(isProtectedDeployment(403, "Vercel", VERCEL_PROTECTED_BODY)).toBe(false);
    expect(isProtectedDeployment(401, null, { protection: { vercel_auth_enabled: false } })).toBe(false);
    expect(isProtectedDeployment(401, null, { protection: { vercel_auth_enabled: "true" } })).toBe(false);
    expect(isProtectedDeployment(401, null, { error: { message: "protected deployment" } })).toBe(false);
    expect(isProtectedDeployment(401, "nginx", undefined)).toBe(false);
    expect(isProtectedDeployment(401, null, null)).toBe(false);
  });

  it("our own cloud's 401 is not a protection 401, through signedPost and the refusal text", async () => {
    const key = generateRunnerKey();
    const reply = await signedPost({ origin: "https://cloud.example", path: "/api/runner/lease", body: {}, key, now: new Date(), fetchFn: (async () => ownCloud401Response()) as typeof fetch });
    expect(reply.status).toBe(401);
    expect(reply.protectedDeployment).toBe(false);
    const error = refusalError(reply);
    expect(error.message).toContain("runner_revoked");
    expect(error.message).not.toContain("Deployment Protection");
  });

  it("the real response through signedPost sets protectedDeployment", async () => {
    const key = generateRunnerKey();
    const reply = await signedPost({ origin: "https://cloud.example", path: "/api/runner/register", body: {}, key, now: new Date(), fetchFn: (async () => vercelProtectedResponse()) as typeof fetch });
    expect(reply.protectedDeployment).toBe(true);
  });

  it("the refusal text names the variable and never a value", () => {
    const error = refusalError({ status: 401, body: undefined, retryAfter: undefined, protectedDeployment: true });
    expect(error.message).toContain("FX_RUNNER_PROTECTION_BYPASS_FILE");
    expect(error.message).toContain("Vercel Deployment Protection");
  });
});

describe("the command line", () => {
  const rig = useRig();
  const io = (argv: string[], bypassFile: string | undefined, over: { uid?: number | undefined; fetchFn?: typeof fetch } = {}) => {
    let out = "";
    let err = "";
    return runCli({ argv, home, stateDirOverride: rig.dir, stdout: (t) => (out += t), stderr: (t) => (err += t), protectionBypassFile: bypassFile, uid: "uid" in over ? over.uid : uid, ...(over.fetchFn === undefined ? {} : { fetchFn: over.fetchFn }) }).then((code) => ({ code, out, err }));
  };
  const register = (file: string | undefined, over: Parameters<typeof io>[2] = {}) => io(["register", "--code", CODE, "--credential-mode", "api_key", "--cloud-url", rig.cloud.origin], file, over);

  it("register sends the header to the cloud and prints nothing of the value", async () => {
    const result = await register(secretFile());
    expect(result.code).toBe(0);
    expect(rig.cloud.seen[0]!.headers[BYPASS_HEADER]).toBe(SECRET);
    expect(result.out + result.err).not.toContain(SECRET);
  });

  it("revoke sends it too", async () => {
    const file = secretFile();
    expect((await register(file)).code).toBe(0);
    const result = await io(["revoke"], file);
    expect(result.code).toBe(0);
    expect(rig.cloud.seen.map((s) => s.headers[BYPASS_HEADER])).toEqual([SECRET, SECRET]);
  });

  it("the clean-up revoke after a mode mismatch carries it as well", async () => {
    rig.cloud.codeModes.set(CODE, "subscription");
    const result = await register(secretFile());
    expect(result.code).toBe(1);
    expect(rig.cloud.seen.map((s) => s.path)).toEqual(["/api/runner/register", "/api/runner/revoke"]);
    expect(rig.cloud.seen.map((s) => s.headers[BYPASS_HEADER])).toEqual([SECRET, SECRET]);
  });

  it("without the variable no header is sent", async () => {
    expect((await register(undefined)).code).toBe(0);
    expect(rig.cloud.seen[0]!.headers[BYPASS_HEADER]).toBeUndefined();
  });

  it("a file that fails its checks stops register and revoke before any request, with the closed code and no value", async () => {
    const cases: Array<[string, string, Parameters<typeof io>[2]]> = [
      ["mode", "bypass_file_mode", {}],
      ["owner", "bypass_file_not_owned", { uid: uid + 1 }],
      ["location", "bypass_file_location", {}],
    ];
    for (const [kind, code, over] of cases) {
      let file = secretFile(`${SECRET}\n`, kind === "mode" ? 0o644 : 0o600, kind);
      // A good file outside the home directory: the sandbox could not keep the agent from reading it.
      if (kind === "location") {
        mkdirSync(path.join(dir, "outside"), { recursive: true });
        file = path.join(dir, "outside", "bypass");
        writeFileSync(file, `${SECRET}\n`, { mode: 0o600 });
      }
      for (const argv of [["register", "--code", CODE, "--credential-mode", "api_key", "--cloud-url", rig.cloud.origin], ["revoke"], ["run"]]) {
        const result = await io(argv, file, over);
        expect(result.code, `${kind} ${argv[0]}`).toBe(1);
        expect(result.err).toContain(code);
        expect(result.err).toContain("FX_RUNNER_PROTECTION_BYPASS_FILE");
        expect(result.out + result.err).not.toContain(SECRET);
        // The text is fixed: not the file's path, and not the argument list.
        expect(result.err).not.toContain(dir);
        expect(result.err).not.toContain(home);
        expect(result.err).not.toContain(CODE);
      }
    }
    expect(rig.cloud.seen).toEqual([]);
  });

  it("a command that makes no cloud call does not care about the file", async () => {
    const result = await io(["status"], secretFile(`${SECRET}\n`, 0o644));
    expect(result.err).not.toContain("bypass_file");
  });

  it("the cloud's refusal and an unreachable cloud never echo the value", async () => {
    rig.cloud.force.push("rate_limit");
    const limited = await register(secretFile());
    expect(limited.code).toBe(1);
    expect(limited.out + limited.err).not.toContain(SECRET);
    const down = await register(secretFile(), { fetchFn: (async () => { throw new Error(`connect failed with header ${SECRET}`); }) as typeof fetch });
    expect(down.err).toContain("could not reach the cloud");
    expect(down.out + down.err).not.toContain(SECRET);
  });

  it("register against a protected deployment says so and names the variable", async () => {
    const fetchFn = (async () => vercelProtectedResponse()) as typeof fetch;
    const result = await register(undefined, { fetchFn });
    expect(result.code).toBe(1);
    expect(result.err).toContain("FX_RUNNER_PROTECTION_BYPASS_FILE");
    expect(result.err).toContain("Vercel Deployment Protection");
  });
});
