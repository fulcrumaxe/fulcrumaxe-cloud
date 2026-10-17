/**
 * The session commands end to end through `main`: the encrypted store on disk, the app's session surface (FakeApp,
 * session-helpers.ts) and GitHub's Issues API over real TLS (the strict local fake: User-Agent, Bearer, JSON). The
 * `sudo` calls of `capture-session --live-user` go through a recording runner: the argument lists are checked, the
 * real `sudo` is never run. Not faked: a real second Unix user, so the owner of the installed file is the runner's.
 */
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startStrictGithubServer, type LocalTlsServer } from "../../../packages/github/test/helpers/localTlsServer.js";
import { ghError, type GhReply, type GhRequest } from "../../../packages/github/test/helpers/strictGithub.js";
import { main, type Io } from "../src/cli.js";
import { LAPSE_REASON_CODES, sessionIssueTitle } from "../src/issues.js";
import type { CaptureBrowser, Launcher } from "../src/sessions.js";
import { parseClaims } from "../src/sessions.js";
import { withRemoteLock, type CommandResult } from "../src/sessions-cli.js";
import { decryptRoles, encryptRoles, putRole, readStore, removeRole, storePath } from "../src/store.js";
import { BYPASS_VALUE, FakeApp, signSession } from "./session-helpers.js";
import { makeIo, scratchRoot, tmpDir } from "./helpers.js";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const D = 86_400_000;
const H = 3_600_000;
const keyBytes = randomBytes(32);
const KEY = keyBytes.toString("base64");
const mk = (startAgo: number, seenAgo: number, sid = "s1") => signSession({ sid, sessionStart: NOW - startAgo, lastSeenAt: NOW - seenAgo });
const STAGING = "https://staging.example.test";
const TOKEN = "test-bearer-not-a-real-credential-0002";
const REPO = "owner/name";

interface Issue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: "open" | "closed";
  comments: string[];
}
function json(status: number, body: unknown): GhReply {
  return { status, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body) };
}
class FakeGithub {
  issues: Issue[] = [];
  /** Every call that changes anything (POST, PATCH). A summary-only outcome must leave this at 0. */
  writes = 0;
  route = (req: GhRequest): GhReply => {
    if (req.headers["authorization"] !== `Bearer ${TOKEN}`) return ghError(401, "Bad credentials");
    if (req.method !== "GET") this.writes += 1;
    const m = /^\/repos\/([^/]+\/[^/]+)\/issues(?:\/(\d+)(?:\/(comments))?)?$/.exec(req.path);
    if (!m || m[1] !== REPO) return ghError(404, "Not Found");
    const body = req.body === "" ? {} : (JSON.parse(req.body) as Record<string, unknown>);
    const issue = m[2] === undefined ? undefined : this.issues.find((i) => i.number === Number(m[2]));
    if (m[2] === undefined && req.method === "GET") {
      const want = new URLSearchParams(req.query ?? "").get("labels") ?? "";
      return json(200, this.issues.filter((i) => i.state === "open" && want.split(",").every((l) => i.labels.includes(l))));
    }
    if (m[2] === undefined && req.method === "POST") {
      const made: Issue = { number: this.issues.length + 1, title: String(body["title"]), body: String(body["body"]), labels: body["labels"] as string[], state: "open", comments: [] };
      this.issues.push(made);
      return json(201, { number: made.number });
    }
    if (issue === undefined) return ghError(404, "Not Found");
    if (m[3] === "comments") {
      issue.comments.push(String(body["body"]));
      return json(201, { id: 1 });
    }
    if (req.method === "PATCH") {
      if (typeof body["body"] === "string") issue.body = body["body"];
      if (typeof body["state"] === "string") issue.state = body["state"] as "open" | "closed";
      return json(200, { number: issue.number });
    }
    return ghError(405, "Method Not Allowed");
  };
}

let server: LocalTlsServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function setup(extra: Record<string, string | undefined> = {}) {
  const home = tmpDir();
  const root = scratchRoot([]);
  const app = new FakeApp(STAGING, () => NOW);
  const { io, out, err } = makeIo(root, { HOME: home, LIVE_E2E_SESSION_KEY: KEY, VERCEL_AUTOMATION_BYPASS_SECRET: BYPASS_VALUE, ...extra });
  const full: Io = { ...io, fetch: app.fetch, now: () => NOW };
  return { home, io: full, out, err, app, file: storePath(home, "staging") };
}

const fakeLauncher =
  (cookie: string): Launcher =>
  async () =>
    ({ cookie: async () => cookie, close: async () => undefined }) satisfies CaptureBrowser;

describe("capture-session", () => {
  it("stores only the app cookie, encrypted, for the caller, and never prints it", async () => {
    const { io, out, err, home, file } = setup();
    const c = mk(0, 0);
    expect(await main(["capture-session", "--target", "staging", "--role", "owner"], { ...io, launcher: fakeLauncher(c) })).toBe(0);
    expect(readStore(file, "staging", keyBytes)).toEqual({ owner: c });
    expect(readFileSync(file, "utf8")).not.toContain(c.split(".")[1] as string);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect([...out, ...err].join("\n")).not.toContain(c);
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith("live-e2e-capture-") || n.startsWith("live-e2e-install-"))).toEqual([]);
    expect(home).toContain(tmpdir());
  });

  it("adds a role without dropping the others, and a second capture of the same role replaces it", async () => {
    const { io, file } = setup();
    const a = mk(0, 0, "a");
    const b = mk(0, 0, "b");
    const b2 = mk(0, -1000, "b2"); // a later capture is newer; an equal or older one never replaces the stored cookie
    for (const [role, c] of [["owner", a], ["member", b], ["member", b2]] as const) {
      expect(await main(["capture-session", "--target", "staging", "--role", role], { ...io, launcher: fakeLauncher(c) })).toBe(0);
    }
    expect(readStore(file, "staging", keyBytes)).toEqual({ owner: a, member: b2 });
  });

  it("refuses a role the target does not use, an unknown role, a missing or malformed key, and stores nothing", async () => {
    const { io, err, file } = setup();
    const launcher = fakeLauncher(mk(0, 0));
    expect(await main(["capture-session", "--target", "staging", "--role", "canary"], { ...io, launcher })).toBe(1);
    expect(await main(["capture-session", "--target", "staging", "--role", "admin"], { ...io, launcher })).toBe(1);
    expect(await main(["capture-session", "--target", "staging", "--role", "owner"], { ...io, env: { ...io.env, LIVE_E2E_SESSION_KEY: undefined }, launcher })).toBe(1);
    expect(await main(["capture-session", "--target", "staging", "--role", "owner"], { ...io, env: { ...io.env, LIVE_E2E_SESSION_KEY: "short" }, launcher })).toBe(1);
    expect(await main(["capture-session", "--target", "staging"], { ...io, launcher })).toBe(2);
    expect(err.join("\n")).toContain("canary role is not used on staging");
    expect(existsSync(file)).toBe(false);
  });

  it("with --live-user EVERY sudo call runs as that user (no root step), the ciphertext goes over stdin to a umask-077 cat, nothing is staged in the owner's temp folder, and the roles it reads as that user are merged", async () => {
    const { io, err, home } = setup();
    const liveHome = `${home}/live-home`;
    const live = storePath(liveHome, "staging");
    const existing = mk(3 * D, 2 * H, "old");
    const calls: string[][] = [];
    const staged: { roles?: Record<string, string>; tmp?: string } = {};
    const run = (command: string, args: string[], input?: string): CommandResult => {
      calls.push([command, ...args]);
      if (command === "getent") return { status: 0, stdout: `liveuser:x:999:998::${liveHome}:/bin/sh\n`, stderr: "" };
      if (args.includes("stat")) return { status: 0, stdout: "directory\n", stderr: "" };
      if (args.includes("cat")) return { status: 0, stdout: encrypted(existing), stderr: "" };
      if (args.includes("sh")) {
        staged.tmp = args[args.length - 1];
        staged.roles = decryptRoles(input ?? "", "staging", keyBytes);
      }
      return { status: 0, stdout: "", stderr: "" };
    };
    const encrypted = (c: string) => encryptRoles({ owner: c }, "staging", keyBytes);
    const c = mk(0, 0, "new");
    expect(await main(["capture-session", "--target", "staging", "--role", "revoke", "--live-user", "liveuser"], { ...io, run, launcher: fakeLauncher(c) })).toBe(0);
    const sudo = calls.filter((a) => a[0] === "sudo");
    expect(sudo.length).toBeGreaterThan(0);
    for (const call of sudo) expect(call.slice(0, 4), call.join(" ")).toEqual(["sudo", "-n", "-u", "liveuser"]);
    expect(calls).toContainEqual(["sudo", "-n", "-u", "liveuser", "cat", live]);
    expect(calls).toContainEqual(["sudo", "-n", "-u", "liveuser", "mkdir", "-p", "-m", "0700", dirname(live)]);
    expect(calls).toContainEqual(["sudo", "-n", "-u", "liveuser", "sh", "-c", 'set -C; umask 077; cat > "$1"', "sh", staged.tmp as string]);
    expect(staged.tmp).toMatch(new RegExp(`^${live.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.[0-9a-f]+\\.tmp$`));
    expect(calls).toContainEqual(["sudo", "-n", "-u", "liveuser", "mv", "-fT", staged.tmp as string, live]);
    expect(staged.roles).toEqual({ owner: existing, revoke: c });
    expect(calls.some((a) => a.includes("-o") || a.includes("-g"))).toBe(false); // no chown, no chgrp: the file is made by its owner
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith("live-e2e-install-"))).toEqual([]);
    expect(err).toEqual([]);
  });

  it("reads the existing store BEFORE the browser opens: a rotated key or a corrupt file fails fast and no sign-in is wasted", async () => {
    const { io, err, file } = setup();
    let launched = 0;
    const launcher: Launcher = async () => {
      launched += 1;
      return { cookie: async () => mk(0, 0), close: async () => undefined };
    };
    await putRole(file, "staging", randomBytes(32), "owner", mk(0, 0)); // written under another key
    expect(await main(["capture-session", "--target", "staging", "--role", "member"], { ...io, launcher })).toBe(1);
    writeFileSync(file, "{not json", { mode: 0o600 });
    expect(await main(["capture-session", "--target", "staging", "--role", "member"], { ...io, launcher })).toBe(1);
    expect(err.join("\n")).toContain("cannot be decrypted");
    // The same through sudo: the store as the live user reads is garbage.
    const run = (command: string, args: string[]): CommandResult =>
      command === "getent" ? { status: 0, stdout: "u:x:1:1::/home/u:/bin/sh\n", stderr: "" } : args.includes("stat") ? { status: 0, stdout: "directory\n", stderr: "" } : args.includes("cat") ? { status: 0, stdout: "garbage", stderr: "" } : { status: 0, stdout: "", stderr: "" };
    expect(await main(["capture-session", "--target", "staging", "--role", "member", "--live-user", "u"], { ...io, run, launcher })).toBe(1);
    expect(launched).toBe(0);
  });

  describe("a capture races a job's write-back (the newest cookie per role wins, under the store lock)", () => {
    /** A `sudo` that really runs the command (as the current user, which stands in for the live user), so the lock folder and the install are real. */
    function realSudo(liveHome: string) {
      const me = userInfo().username;
      const calls: string[][] = [];
      const run = (command: string, args: string[], input?: string): CommandResult => {
        calls.push([command, ...args]);
        if (command === "getent") return { status: 0, stdout: `${me}:x:1:1::${liveHome}:/bin/sh\n`, stderr: "" };
        // Only `sudo -n -u <user> <command...>` is understood: anything else (a root `sudo`, a bare command) fails the test.
        if (command !== "sudo" || args[0] !== "-n" || args[1] !== "-u" || args[2] !== me) return { status: 99, stdout: "", stderr: "unexpected command" };
        const argv = args.slice(3);
        const r = spawnSync(argv[0] as string, argv.slice(1), { encoding: "utf8", ...(input !== undefined ? { input } : {}) });
        return { status: r.status, stdout: r.stdout, stderr: r.stderr };
      };
      return { run, calls, me };
    }

    it("a write-back that lands after the pre-check but before the install is not overwritten by the older captured cookie", async () => {
      const { io, home } = setup();
      const liveHome = `${home}/live-home`;
      const live = storePath(liveHome, "staging");
      const { run, me } = realSudo(liveHome);
      await putRole(live, "staging", keyBytes, "owner", mk(3 * D, 6 * H, "stored"));
      const captured = mk(0, 3 * H, "captured-earlier");
      const jobWroteBack = mk(0, 0, "job");
      const launcher: Launcher = async () => {
        // The job's write-back and a keep-alive of another role land while the owner is still signing in.
        await putRole(live, "staging", keyBytes, "owner", jobWroteBack);
        await putRole(live, "staging", keyBytes, "member", mk(3 * D, H, "member"));
        return { cookie: async () => captured, close: async () => undefined };
      };
      expect(await main(["capture-session", "--target", "staging", "--role", "owner", "--live-user", me], { ...io, run, launcher })).toBe(0);
      const stored = readStore(live, "staging", keyBytes);
      expect(stored["owner"]).toBe(jobWroteBack);
      expect(Object.keys(stored).sort()).toEqual(["member", "owner"]);
      expect(existsSync(`${live}.lock`)).toBe(false);
    });

    /** No `sudo` call without `-u <user>` (nothing runs as root), in any of the runs above or below. */
    const allAsUser = (calls: string[][], user: string): boolean => calls.filter((c) => c[0] === "sudo").every((c) => c[1] === "-n" && c[2] === "-u" && c[3] === user) && calls.some((c) => c[0] === "sudo");

    it("a newer capture replaces the stored one, takes the live user's lock, and releases it", async () => {
      const { io, home } = setup();
      const liveHome = `${home}/live-home`;
      const live = storePath(liveHome, "staging");
      const { run, calls, me } = realSudo(liveHome);
      await putRole(live, "staging", keyBytes, "owner", mk(3 * D, 6 * H, "stored"));
      const captured = mk(0, -1000, "recaptured");
      expect(await main(["capture-session", "--target", "staging", "--role", "owner", "--live-user", me], { ...io, run, launcher: fakeLauncher(captured) })).toBe(0);
      expect(readStore(live, "staging", keyBytes)["owner"]).toBe(captured);
      expect(calls.some((c) => c.includes("mkdir") && c.includes(`${live}.lock`))).toBe(true);
      expect(existsSync(`${live}.lock`)).toBe(false);
      expect(allAsUser(calls, me)).toBe(true);
      expect(statSync(live).mode & 0o777).toBe(0o600);
      expect(readdirSync(dirname(live))).toEqual(["sessions-staging.enc"]); // no temp file left beside the store
    });

    it("a symbolic link at any level of the live user's store path (.local, .local/state, live-e2e) is refused before the browser opens, and the link's target is left untouched", async () => {
      for (const level of [1, 2, 3]) {
        const { io, home, err } = setup();
        const liveHome = `${home}/live-home-${level}`;
        const live = storePath(liveHome, "staging");
        const { run, calls, me } = realSudo(liveHome);
        const victim = `${home}/victim-${level}`;
        mkdirSync(victim, { mode: 0o755 });
        chmodSync(victim, 0o755);
        writeFileSync(`${victim}/keep`, "x");
        const parts = [`${liveHome}/.local`, `${liveHome}/.local/state`, dirname(live)];
        mkdirSync(liveHome);
        for (const real of parts.slice(0, level - 1)) mkdirSync(real);
        symlinkSync(victim, parts[level - 1] as string);
        let launched = 0;
        const launcher: Launcher = async () => {
          launched += 1;
          return { cookie: async () => mk(0, 0), close: async () => undefined };
        };
        expect(await main(["capture-session", "--target", "staging", "--role", "owner", "--live-user", me], { ...io, run, launcher }), `level ${level}`).toBe(1);
        expect(err.join("\n")).toContain("symbolic link");
        expect(launched).toBe(0);
        expect(readdirSync(victim)).toEqual(["keep"]);
        expect(readFileSync(`${victim}/keep`, "utf8")).toBe("x");
        expect(statSync(victim).mode & 0o777).toBe(0o755);
        expect(allAsUser(calls, me)).toBe(true);
      }
    });

    it("a link at the store file itself is not written through: the capture refuses it up front and the link target is left as it was", async () => {
      const { io, home } = setup();
      const liveHome = `${home}/live-home`;
      const live = storePath(liveHome, "staging");
      const { run, calls, me } = realSudo(liveHome);
      mkdirSync(dirname(live), { recursive: true, mode: 0o700 });
      const victim = `${home}/victim-file`;
      writeFileSync(victim, "untouched");
      symlinkSync(victim, live);
      // The pre-check reads the store through the link (as the live user, harmless) and finds garbage: refused up front.
      expect(await main(["capture-session", "--target", "staging", "--role", "owner", "--live-user", me], { ...io, run, launcher: fakeLauncher(mk(0, 0)) })).toBe(1);
      expect(readFileSync(victim, "utf8")).toBe("untouched");
      expect(allAsUser(calls, me)).toBe(true);
    });

    it("a first capture on a fresh live home (the home exists, the store folder does not) makes the folder, takes the lock and leaves none", async () => {
      const { io, home } = setup();
      const liveHome = `${home}/live-home`;
      const live = storePath(liveHome, "staging");
      const { run, calls, me } = realSudo(liveHome);
      mkdirSync(liveHome);
      expect(existsSync(dirname(live))).toBe(false);
      const started = Date.now();
      const captured = mk(0, 0, "first");
      expect(await main(["capture-session", "--target", "staging", "--role", "owner", "--live-user", me], { ...io, run, launcher: fakeLauncher(captured) })).toBe(0);
      expect(Date.now() - started).toBeLessThan(5000); // not the 10 s lock wait running out
      expect(readStore(live, "staging", keyBytes)["owner"]).toBe(captured);
      expect(statSync(dirname(live)).mode & 0o777).toBe(0o700);
      expect(existsSync(`${live}.lock`)).toBe(false);
      expect(readdirSync(dirname(live))).toEqual(["sessions-staging.enc"]);
      expect(allAsUser(calls, me)).toBe(true);
    });

    it("reclaims a stale lock left by a crashed writer, and refuses a lock that is a symbolic link", async () => {
      const { io, home } = setup();
      const liveHome = `${home}/live-home`;
      const live = storePath(liveHome, "staging");
      const { run, me } = realSudo(liveHome);
      await putRole(live, "staging", keyBytes, "member", mk(3 * D, H, "member"));
      mkdirSync(`${live}.lock`);
      const old = new Date(Date.now() - 120_000);
      utimesSync(`${live}.lock`, old, old);
      expect(await main(["capture-session", "--target", "staging", "--role", "owner", "--live-user", me], { ...io, run, launcher: fakeLauncher(mk(0, 0)) })).toBe(0);
      expect(Object.keys(readStore(live, "staging", keyBytes)).sort()).toEqual(["member", "owner"]);
      expect(existsSync(`${live}.lock`)).toBe(false);
      symlinkSync(tmpdir(), `${live}.lock`);
      const refused = setup();
      const started = Date.now();
      expect(await main(["capture-session", "--target", "staging", "--role", "owner", "--live-user", me], { ...refused.io, run, launcher: fakeLauncher(mk(0, 0)) })).toBe(1);
      // The refusal text, not the 10 s wait running out: a fresh link would also end in exit 1 by timeout.
      expect(refused.err.join("\n")).toContain("lock is a symbolic link");
      expect(refused.err.join("\n")).not.toContain("locked by another writer");
      expect(Date.now() - started).toBeLessThan(5000);
    });

    it("on the owner's own home, a write-back that lands during the sign-in is not overwritten either", async () => {
      const { io, file } = setup();
      const jobWroteBack = mk(0, 0, "job");
      const launcher: Launcher = async () => {
        await putRole(file, "staging", keyBytes, "owner", jobWroteBack);
        return { cookie: async () => mk(0, 2 * H, "captured-earlier"), close: async () => undefined };
      };
      expect(await main(["capture-session", "--target", "staging", "--role", "owner"], { ...io, launcher })).toBe(0);
      expect(readStore(file, "staging", keyBytes)["owner"]).toBe(jobWroteBack);
    });
  });

  it("a user name that is not plain, or a failing sudo, stores nothing and exits 1", async () => {
    const { io, err } = setup();
    expect(await main(["capture-session", "--target", "staging", "--role", "owner", "--live-user", "x; rm -rf /"], { ...io, launcher: fakeLauncher(mk(0, 0)) })).toBe(1);
    const failing = (command: string): CommandResult =>
      command === "getent" ? { status: 0, stdout: "u:x:1:1::/home/u:/bin/sh\n", stderr: "" } : command === "id" ? { status: 0, stdout: "g\n", stderr: "" } : { status: 1, stdout: "", stderr: "sudo: a password is required" };
    expect(await main(["capture-session", "--target", "staging", "--role", "owner", "--live-user", "u"], { ...io, run: failing, launcher: fakeLauncher(mk(0, 0)) })).toBe(1);
    expect(err.join("\n")).toContain("cannot inspect the session store folder of u");
    // With the folders fine and only `cat` failing, the read failure is named.
    const catFails = (command: string, args: string[]): CommandResult =>
      command === "getent" ? { status: 0, stdout: "u:x:1:1::/home/u:/bin/sh\n", stderr: "" } : args.includes("stat") ? { status: 0, stdout: "directory\n", stderr: "" } : { status: 1, stdout: "", stderr: "cat: Permission denied" };
    const again = setup();
    expect(await main(["capture-session", "--target", "staging", "--role", "owner", "--live-user", "u"], { ...again.io, run: catFails, launcher: fakeLauncher(mk(0, 0)) })).toBe(1);
    expect(again.err.join("\n")).toContain("cannot read the existing store as u");
  });
});

describe("withRemoteLock (the lock the owner's capture takes as the live user)", () => {
  /** A runner for `sudo -n -u u ...`: `mkdir` of the lock always fails (held), `stat` answers as scripted. */
  const held = (stat: (path: string) => CommandResult) => {
    const calls: string[][] = [];
    const run = (command: string, args: string[]): CommandResult => {
      calls.push([command, ...args]);
      // The loop is synchronous, so a loop that ignored its deadline would hang the run instead of failing a test.
      if (calls.length > 500) throw new Error("runaway loop: withRemoteLock ignored its deadline");
      const argv = args.slice(3);
      // `mkdir -p` of the store folder succeeds and the store's folders are plain; only the lock folder is held.
      if (argv[0] === "mkdir") return argv.includes("-p") ? { status: 0, stdout: "", stderr: "" } : { status: 1, stdout: "", stderr: "File exists" };
      if (argv[0] === "stat") {
        const path = argv[argv.length - 1] as string;
        return path.endsWith(".lock") ? stat(path) : { status: 0, stdout: "directory\n", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    };
    return { run, calls };
  };
  const freshDir = (): CommandResult => ({ status: 0, stdout: `${Math.floor(Date.now() / 1000)} directory\n`, stderr: "" });

  it("a held fresh lock ends at the deadline with the lock message", () => {
    const { run } = held(freshDir);
    expect(() => withRemoteLock("u", "/h/s.enc", run, () => "x", { waitMs: 120 })).toThrow("locked by another writer");
  });

  it("a stat that fails for any reason except 'no such file' is an error at once, not a loop of sudo calls", () => {
    const { run, calls } = held(() => ({ status: 1, stdout: "", stderr: "sudo: a password is required" }));
    expect(() => withRemoteLock("u", "/h/s.enc", run, () => "x", { waitMs: 5000 })).toThrow("cannot inspect the session store lock");
    expect(calls.length).toBeLessThan(15); // the folder is made and checked first, then the failing lock stat ends it
  });

  it("a lock that keeps vanishing (stat: no such file, mkdir: exists) still ends at the deadline and sleeps between passes", () => {
    const { run, calls } = held(() => ({ status: 1, stdout: "", stderr: "stat: cannot statx '/h/s.enc.lock': No such file or directory" }));
    const started = Date.now();
    expect(() => withRemoteLock("u", "/h/s.enc", run, () => "x", { waitMs: 200 })).toThrow("locked by another writer");
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    // 200 ms at 25 ms per pass is about 8 passes of two calls; a spinning loop would make thousands.
    expect(calls.length).toBeLessThan(60);
  });

  it("the store folder is made (as the user) before the first lock attempt, and looked at again after", () => {
    const { run, calls } = held(freshDir);
    expect(() => withRemoteLock("u", "/h/.local/state/live-e2e/s.enc", run, () => "x", { waitMs: 60 })).toThrow("locked by another writer");
    const argvs = calls.map((c) => c.slice(4));
    const iMkdirP = argvs.findIndex((a) => a[0] === "mkdir" && a.includes("-p") && a.includes("/h/.local/state/live-e2e"));
    const iLock = argvs.findIndex((a) => a[0] === "mkdir" && a.includes("/h/.local/state/live-e2e/s.enc.lock"));
    expect(iMkdirP).toBeGreaterThanOrEqual(0);
    expect(iMkdirP).toBeLessThan(iLock);
    expect(argvs.slice(iMkdirP + 1, iLock).some((a) => a[0] === "stat")).toBe(true); // assertPlainRemote again
    expect(calls.every((c) => c[0] === "sudo" && c.slice(0, 4).join(" ") === "sudo -n -u u")).toBe(true);
  });

  it("a link swapped in for the store folder between the first look and the mkdir is refused on the second look", () => {
    let mkdirDone = false;
    const run = (_c: string, args: string[]): CommandResult => {
      const argv = args.slice(3);
      if (argv[0] === "mkdir") mkdirDone = true;
      if (argv[0] === "stat") return { status: 0, stdout: mkdirDone && argv[argv.length - 1] === "/h/live-e2e" ? "symbolic link\n" : "directory\n", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };
    expect(() => withRemoteLock("u", "/h/live-e2e/s.enc", run, () => "x", { waitMs: 60 })).toThrow("symbolic link");
  });

  it("a stale lock is reclaimed through the guard once, and a fresh lock swapped in under the guard is not deleted", () => {
    const calls: string[][] = [];
    let lockStatCalls = 0;
    const run = (command: string, args: string[]): CommandResult => {
      calls.push([command, ...args]);
      if (calls.length > 500) throw new Error("runaway loop: withRemoteLock ignored its deadline");
      const argv = args.slice(3);
      if (argv[0] === "mkdir") return { status: argv.includes("-p") || argv[argv.length - 1]?.endsWith(".reclaim") ? 0 : 1, stdout: "", stderr: "" };
      if (argv[0] === "stat" && !String(argv[argv.length - 1]).endsWith(".lock")) return { status: 0, stdout: "directory\n", stderr: "" };
      if (argv[0] === "stat") {
        lockStatCalls += 1;
        // First look: stale. Re-check under the guard: another process has put a fresh lock there.
        return { status: 0, stdout: `${Math.floor(Date.now() / 1000) - (lockStatCalls === 1 ? 600 : 1)} directory\n`, stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    };
    expect(() => withRemoteLock("u", "/h/s.enc", run, () => "x", { waitMs: 100 })).toThrow("locked by another writer");
    expect(calls.some((c) => c.includes("rm") && c.includes("/h/s.enc.lock"))).toBe(false);
  });
});

describe("sessions keep-alive, status, forget", () => {
  it("keep-alive refreshes every stored role, prints states and no cookie, and appends nothing to the summary when all is well", async () => {
    const { io, out, err, file, app } = setup();
    const c = mk(2 * D, 5 * H);
    await putRole(file, "staging", keyBytes, "owner", c);
    const summary = `${tmpDir()}/summary.md`;
    expect(await main(["sessions", "keep-alive", "--target", "staging", "--summary", summary], io)).toBe(0);
    expect(out).toContain("session owner: ok");
    expect(parseClaims(readStore(file, "staging", keyBytes)["owner"] as string)?.lastSeenAt).toBe(NOW);
    // The only place the value is printed is the runner's mask command.
    expect([...out, ...err].filter((l) => !l.startsWith("::add-mask::")).join("\n")).not.toContain(c.split(".")[1] as string);
    expect(out.filter((l) => l.startsWith("::add-mask::")).length).toBeGreaterThan(0);
    expect(existsSync(summary)).toBe(false);
    expect(app.seen).toHaveLength(1);
  });

  it("a lapsed role opens ONE issue (needs-owner + live-e2e, with the capture command), refreshes it in place the next night, and closes it after a new capture", async () => {
    const fake = new FakeGithub();
    server = await startStrictGithubServer(fake.route);
    const { io, out, file } = setup({ GITHUB_TOKEN: TOKEN, GITHUB_API_URL: `https://127.0.0.1:${server.port}` });
    const withGh: Io = { ...io, githubCa: server.ca };
    await putRole(file, "staging", keyBytes, "owner", mk(5 * D, 30 * H));
    await putRole(file, "staging", keyBytes, "member", mk(5 * D, 31 * H));
    const argv = ["sessions", "keep-alive", "--target", "staging", "--repo", REPO, "--run-url", "https://example.test/run/9"];
    expect(await main(argv, withGh)).toBe(0);
    expect(out).toEqual(expect.arrayContaining(["session owner: lapsed", "session member: lapsed"]));
    expect(fake.issues.map((i) => i.title)).toEqual([sessionIssueTitle("owner"), sessionIssueTitle("member")]);
    expect(fake.issues[0]?.labels).toEqual(["live-e2e", "needs-owner"]);
    expect(fake.issues[0]?.body).toContain("capture-session --target staging --role owner");
    expect(fake.issues[0]?.body).toContain("https://example.test/run/9");
    expect(await main(argv, withGh)).toBe(0);
    expect(fake.issues).toHaveLength(2);
    expect(fake.issues.every((i) => i.comments.length === 0 && i.state === "open")).toBe(true);
    await putRole(file, "staging", keyBytes, "owner", mk(5 * D, H));
    expect(await main(argv, withGh)).toBe(0);
    expect(fake.issues[0]?.state).toBe("closed");
    expect(fake.issues[0]?.comments).toEqual(["The session is usable again."]);
    expect(fake.issues[1]?.state).toBe("open");
  });

  it("a new lapse leaves one scrubbed team-log line; the same lapse the next run adds none; no team-log issue means a summary line and no failure", async () => {
    const fake = new FakeGithub();
    server = await startStrictGithubServer(fake.route);
    const { io, file } = setup({ GITHUB_TOKEN: TOKEN, GITHUB_API_URL: `https://127.0.0.1:${server.port}` });
    const withGh: Io = { ...io, githubCa: server.ca };
    await putRole(file, "staging", keyBytes, "owner", mk(5 * D, 30 * H));
    const summary = `${tmpDir()}/summary.md`;
    const argv = ["sessions", "keep-alive", "--target", "staging", "--repo", REPO, "--run-url", "https://example.test/run/9", "--summary", summary];
    // No team-log issue yet: the line lands in the job summary.
    expect(await main(argv, withGh)).toBe(0);
    expect(readFileSync(summary, "utf8")).toContain("live-e2e: red target=staging tier=none trigger=keepalive packs=session:owner run=https://example.test/run/9");
    // Close the lapse issue and open the log: a fresh lapse is reported there.
    fake.issues[0]!.state = "closed";
    fake.issues.push({ number: 9, title: "Team log", body: "", labels: ["team-log"], state: "open", comments: [] });
    expect(await main(argv, withGh)).toBe(0);
    expect(fake.issues[1]?.comments).toHaveLength(1);
    expect(fake.issues[1]?.comments[0]).toMatch(/^\[\d\d:\d\d\] live-e2e: red target=staging tier=none trigger=keepalive packs=session:owner run=https:\/\/example\.test\/run\/9$/);
    // The same lapse again: the lapse issue is unchanged, so the log gets nothing more.
    expect(await main(argv, withGh)).toBe(0);
    expect(fake.issues[1]?.comments).toHaveLength(1);
  });

  it("an outage opens no issue (error says nothing about the session), and a role never captured gets none either", async () => {
    const fake = new FakeGithub();
    server = await startStrictGithubServer(fake.route);
    const { io, app, file } = setup({ GITHUB_TOKEN: TOKEN, GITHUB_API_URL: `https://127.0.0.1:${server.port}` });
    await putRole(file, "staging", keyBytes, "owner", mk(2 * D, H));
    app.outage = 503;
    expect(await main(["sessions", "keep-alive", "--target", "staging", "--repo", REPO], { ...io, githubCa: server.ca })).toBe(0);
    expect(fake.issues).toEqual([]);
  });

  it("adds the 30-day warning and the lapse line to the job summary", async () => {
    const { io, file } = setup();
    await putRole(file, "staging", keyBytes, "owner", mk(29 * D, H));
    await putRole(file, "staging", keyBytes, "member", mk(2 * D, 40 * H));
    const summary = `${tmpDir()}/summary.md`;
    expect(await main(["sessions", "keep-alive", "--target", "staging", "--summary", summary], io)).toBe(0);
    const text = readFileSync(summary, "utf8");
    expect(text).toContain("owner reaches its 30-day limit in 1 day(s)");
    expect(text).toContain("Session lapsed (member): lapsed");
  });

  it("status reads without a request; forget removes one role and keeps the rest", async () => {
    const { io, out, file, app } = setup();
    await putRole(file, "staging", keyBytes, "owner", mk(2 * D, H));
    await putRole(file, "staging", keyBytes, "revoke", mk(2 * D, H));
    expect(await main(["sessions", "status", "--target", "staging"], io)).toBe(0);
    expect(out).toEqual(["owner: ok", "revoke: ok"]);
    expect(app.seen).toHaveLength(0);
    expect(await main(["sessions", "forget", "--target", "staging", "--role", "revoke"], io)).toBe(0);
    expect(Object.keys(readStore(file, "staging", keyBytes))).toEqual(["owner"]);
  });

  it("with no key the keep-alive exits 0 with one summary line; a malformed key exits non-zero naming the variable", async () => {
    const { io, out, app } = setup();
    const summary = `${tmpDir()}/summary.md`;
    expect(await main(["sessions", "keep-alive", "--target", "staging", "--summary", summary], { ...io, env: { ...io.env, LIVE_E2E_SESSION_KEY: undefined } })).toBe(0);
    expect(out).toEqual(["Session keep-alive skipped: LIVE_E2E_SESSION_KEY is not set in this environment; every session need is skipped."]);
    expect(readFileSync(summary, "utf8")).toContain("LIVE_E2E_SESSION_KEY is not set");
    const bad = setup();
    expect(await main(["sessions", "keep-alive", "--target", "staging"], { ...bad.io, env: { ...bad.io.env, LIVE_E2E_SESSION_KEY: "short" } })).not.toBe(0);
    expect(bad.err.join("\n")).toContain("LIVE_E2E_SESSION_KEY");
    expect(app.seen).toEqual([]);
  });

  it("an unreadable store (a rotated key) is one issue with the way out and no crash; reading again closes it", async () => {
    const fake = new FakeGithub();
    server = await startStrictGithubServer(fake.route);
    const { io, out, file } = setup({ GITHUB_TOKEN: TOKEN, GITHUB_API_URL: `https://127.0.0.1:${server.port}` });
    await putRole(file, "staging", randomBytes(32), "owner", mk(2 * D, H)); // written under another key
    const argv = ["sessions", "keep-alive", "--target", "staging", "--repo", REPO];
    expect(await main(argv, { ...io, githubCa: server.ca })).toBe(0);
    expect(out.join("\n")).toContain("session store unreadable");
    expect(fake.issues.map((i) => i.title)).toEqual(["live-e2e: session store unreadable"]);
    expect(fake.issues[0]?.labels).toEqual(["live-e2e", "needs-owner"]);
    expect(await main(argv, { ...io, githubCa: server.ca })).toBe(0);
    expect(fake.issues).toHaveLength(1);
    rmSync(file);
    await putRole(file, "staging", keyBytes, "owner", mk(2 * D, H));
    expect(await main(argv, { ...io, githubCa: server.ca })).toBe(0);
    expect(fake.issues[0]?.state).toBe("closed");
  });

  it("a second lapse for the same reason adds nothing; a changed reason updates the issue and comments on it", async () => {
    const fake = new FakeGithub();
    server = await startStrictGithubServer(fake.route);
    const { io, file } = setup({ GITHUB_TOKEN: TOKEN, GITHUB_API_URL: `https://127.0.0.1:${server.port}` });
    const argv = ["sessions", "keep-alive", "--target", "staging", "--repo", REPO];
    await putRole(file, "staging", keyBytes, "owner", mk(5 * D, 30 * H));
    await main(argv, { ...io, githubCa: server.ca });
    await main(argv, { ...io, githubCa: server.ca });
    expect(fake.issues[0]?.comments).toEqual([]);
    await removeRole(file, "staging", keyBytes, "owner");
    await putRole(file, "staging", keyBytes, "owner", mk(31 * D, H));
    await main(argv, { ...io, githubCa: server.ca });
    expect(fake.issues).toHaveLength(1);
    expect(fake.issues[0]?.comments).toEqual([expect.stringContaining("now: expired")]);
  });

  it("usage and key errors exit 2 or 1 with a message and no stack", async () => {
    const { io, err } = setup();
    expect(await main(["sessions", "nope", "--target", "staging"], io)).toBe(2);
    expect(await main(["sessions", "keep-alive"], io)).toBe(2);
    expect(await main(["sessions", "status", "--target", "staging"], { ...io, env: { ...io.env, LIVE_E2E_SESSION_KEY: undefined } })).toBe(2);
    expect(err.join("\n")).toContain("LIVE_E2E_SESSION_KEY is not set");
  });
});

describe("lapse issues and the job summary (R-441-T3-18, T3 eval lines 4 and 6)", () => {
  /** Everything a reader of the logs, summary or issues could see, minus the runner's own mask commands. */
  const visible = (fake: FakeGithub, out: string[], err: string[], summary: string): string =>
    [...fake.issues.flatMap((i) => [i.title, i.body, ...i.comments]), ...out.filter((l) => !l.startsWith("::add-mask::")), ...err, summary].join("\n");
  const expectNoCookie = (text: string, cookie: string): void => {
    expect(text).not.toContain(cookie);
    for (const part of cookie.split(".")) expect(text).not.toContain(part);
  };
  const reasonLine = (i: Issue | undefined): string | undefined => /^Reason code: (\S+)$/m.exec(i?.body ?? "")?.[1];

  async function ghSetup(extra: Record<string, string | undefined> = {}) {
    const fake = new FakeGithub();
    server = await startStrictGithubServer(fake.route);
    const s = setup({ GITHUB_TOKEN: TOKEN, GITHUB_API_URL: `https://127.0.0.1:${server.port}`, ...extra });
    const summaryFile = `${tmpDir()}/summary.md`;
    const argv = ["sessions", "keep-alive", "--target", "staging", "--repo", REPO, "--run-url", "https://example.test/run/9", "--summary", summaryFile];
    const ca = server.ca;
    const run = (io: Io = s.io): Promise<number> => main(argv, { ...io, githubCa: ca });
    const summary = (): string => (existsSync(summaryFile) ? readFileSync(summaryFile, "utf8") : "");
    return { ...s, fake, run, summary };
  }

  it("the issue body carries a machine-readable reason-code line from a fixed list, for each way a session lapses", async () => {
    const g = await ghSetup();
    await putRole(g.file, "staging", keyBytes, "owner", mk(5 * D, 30 * H)); // idle over 24 h
    await putRole(g.file, "staging", keyBytes, "member", mk(31 * D, H)); // past the 30-day limit
    await putRole(g.file, "staging", keyBytes, "outsider", mk(2 * D, H, "dead")); // the app turns it away
    g.app.revoked.add("dead");
    expect(await g.run()).toBe(0);
    const byRole = (role: string) => g.fake.issues.find((i) => i.title === sessionIssueTitle(role));
    expect(reasonLine(byRole("owner"))).toBe("idle");
    expect(reasonLine(byRole("member"))).toBe("past-limit");
    expect(reasonLine(byRole("outsider"))).toBe("app-rejected");
    expect(LAPSE_REASON_CODES).toEqual({ lapsed: "idle", expired: "past-limit", malformed: "malformed", rejected: "app-rejected" });
  });

  it("a dead session is the app's real EMPTY 401: one issue, a summary line, and the planted cookie nowhere a reader can see", async () => {
    const g = await ghSetup();
    const planted = mk(2 * D, H, "dead");
    await putRole(g.file, "staging", keyBytes, "owner", planted);
    g.app.revoked.add("dead");
    expect(await g.run()).toBe(0);
    // The stand-in answered the empty 401 the real route answers (empty401 in apps/web/lib/shell/session-routes.ts).
    expect(g.out).toContain("session owner: rejected");
    expect(g.fake.issues).toHaveLength(1);
    expect(g.fake.issues[0]?.labels).toEqual(["live-e2e", "needs-owner"]);
    expect(g.summary()).toContain("Session lapsed (owner): rejected");
    expectNoCookie(visible(g.fake, g.out, g.err, g.summary()), planted);
  });

  it("the same reason on the next check writes nothing at all", async () => {
    const g = await ghSetup();
    await putRole(g.file, "staging", keyBytes, "owner", mk(2 * D, H, "dead"));
    g.app.revoked.add("dead");
    await g.run();
    const writes = g.fake.writes;
    const body = g.fake.issues[0]?.body;
    expect(await g.run()).toBe(0);
    expect(await g.run()).toBe(0);
    expect(g.fake.writes).toBe(writes);
    expect(g.fake.issues).toHaveLength(1);
    expect(g.fake.issues[0]?.comments).toEqual([]);
    expect(g.fake.issues[0]?.body).toBe(body);
  });

  it("a changed reason adds exactly one comment and updates the recorded code; repeating the new reason adds none", async () => {
    const g = await ghSetup();
    await putRole(g.file, "staging", keyBytes, "owner", mk(2 * D, H, "dead"));
    g.app.revoked.add("dead");
    await g.run();
    expect(reasonLine(g.fake.issues[0])).toBe("app-rejected");
    await removeRole(g.file, "staging", keyBytes, "owner");
    const idle = mk(5 * D, 30 * H, "idle");
    await putRole(g.file, "staging", keyBytes, "owner", idle);
    await g.run();
    expect(g.fake.issues).toHaveLength(1);
    expect(g.fake.issues[0]?.comments).toEqual([expect.stringContaining("now: lapsed")]);
    expect(reasonLine(g.fake.issues[0])).toBe("idle");
    await g.run();
    expect(g.fake.issues[0]?.comments).toHaveLength(1);
    expectNoCookie(visible(g.fake, g.out, g.err, g.summary()), idle);
  });

  it("wording can change without a new comment: an open issue is compared on its reason-code line only", async () => {
    const g = await ghSetup();
    await putRole(g.file, "staging", keyBytes, "owner", mk(5 * D, 30 * H));
    await g.run();
    const issue = g.fake.issues[0] as Issue;
    issue.body = issue.body.replace(/^The stored session.*$/m, "An older headline, worded differently.");
    await g.run();
    expect(issue.comments).toEqual([]);
    expect(issue.body).toContain("An older headline, worded differently.");
  });

  it("a lapse after the issue was closed opens a NEW issue (the old one is closed and stays closed)", async () => {
    const g = await ghSetup();
    await putRole(g.file, "staging", keyBytes, "owner", mk(2 * D, H, "dead"));
    g.app.revoked.add("dead");
    await g.run();
    g.app.revoked.delete("dead");
    expect(await g.run()).toBe(0); // the app accepts the session again: the issue closes
    expect(g.fake.issues[0]?.state).toBe("closed");
    expect(g.fake.issues[0]?.comments).toEqual(["The session is usable again."]);
    g.app.revoked.add("dead");
    expect(await g.run()).toBe(0);
    expect(g.fake.issues).toHaveLength(2);
    expect(g.fake.issues.map((i) => i.state)).toEqual(["closed", "open"]);
    expect(g.fake.issues[0]?.comments).toHaveLength(1);
    expect(g.fake.issues[1]?.comments).toEqual([]);
    expect(reasonLine(g.fake.issues[1])).toBe("app-rejected");
  });

  describe("'the app could not be reached' is a summary line and never an issue or a comment", () => {
    type G = Awaited<ReturnType<typeof ghSetup>>;
    const cases: { name: string; env?: Record<string, string>; arrange: (g: G) => Io }[] = [
      { name: "a network error", arrange: (g) => ({ ...g.io, fetch: async () => Promise.reject(new TypeError("fetch failed")) }) },
      {
        name: "a 5xx from the app",
        arrange: (g) => {
          g.app.outage = 503;
          return g.io;
        },
      },
      { name: "Vercel's protection wall (an HTML 401, here from a rotated bypass secret)", env: { VERCEL_AUTOMATION_BYPASS_SECRET: "rotated-away-bypass-secret-0003" }, arrange: (g) => g.io },
    ];
    for (const c of cases) {
      it(c.name, async () => {
        const g = await ghSetup(c.env ?? {});
        const planted = mk(2 * D, H, "healthy");
        await putRole(g.file, "staging", keyBytes, "owner", planted);
        // An issue already open for this role must not be commented on either.
        g.fake.issues.push({ number: 1, title: sessionIssueTitle("owner"), body: "x\n\nReason code: idle\n", labels: ["live-e2e", "needs-owner"], state: "open", comments: [] });
        const io = c.arrange(g);
        expect(await g.run(io)).toBe(0);
        expect(g.out).toContain("session owner: error");
        expect(g.summary()).toContain("Session owner: the app could not be reached or answered unexpectedly; the stored session was left as it is.");
        expect(g.summary()).not.toContain("Session lapsed"); // an unreachable app says nothing about the session
        expect(g.fake.writes).toBe(0);
        expect(g.fake.issues).toHaveLength(1);
        expect(g.fake.issues[0]?.comments).toEqual([]);
        expect(g.fake.issues[0]?.state).toBe("open");
        expect(readStore(g.file, "staging", keyBytes)["owner"]).toBe(planted);
        expectNoCookie([...g.out.filter((l) => !l.startsWith("::add-mask::")), ...g.err, g.summary()].join("\n"), planted);
      });
    }
  });
});
