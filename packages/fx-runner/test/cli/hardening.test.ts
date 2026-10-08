import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REGISTRATION_FILE, writePrivateFile } from "../../src/config.js";
import { CODE, useRig } from "./harness.js";

const rig = useRig();
const stateFiles = (): string[] => (existsSync(rig.dir) ? readdirSync(rig.dir).sort() : []);
afterEach(() => vi.useRealTimers());

describe("the reply is read through a byte cap", () => {
  it("stops pulling a long reply near 64 KiB instead of buffering it all", async () => {
    const chunk = new Uint8Array(1024).fill(120);
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= 10 * 1024 * 1024) return controller.close();
        pulled += chunk.length;
        controller.enqueue(chunk);
      },
    });
    const fetchFn = (async () => new Response(body, { status: 500 })) as unknown as typeof fetch;
    const result = await rig.run(["register", "--code", CODE, "--credential-mode", "api_key", "--cloud-url", rig.cloud.origin], { fetchFn });
    expect(result.code).toBe(1);
    expect(pulled).toBeLessThanOrEqual(64 * 1024 + 2 * chunk.length);
    expect(stateFiles()).toEqual([]);
  });
});

describe("a registration file from disk is checked again", () => {
  it("refuses a saved cloud_origin that is not a plain https (or loopback http) origin", async () => {
    await rig.register();
    const file = path.join(rig.dir, REGISTRATION_FILE);
    const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
    for (const origin of ["http://example.com", "https://example.com/path", "https://user:pw@example.com", "ftp://example.com", "nonsense"]) {
      writeFileSync(file, JSON.stringify({ ...saved, cloud_origin: origin }), { mode: 0o600 });
      const status = await rig.run(["status"]);
      expect(status.code, origin).toBe(1);
      expect(status.err, origin).toContain("damaged");
      expect((await rig.run(["revoke"])).code, origin).toBe(1);
    }
    // only the registration itself was ever sent: nothing went to a swapped-in address
    expect(rig.cloud.seen.length).toBe(1);
  });
});

describe("temporary files", () => {
  it("have a name the clock does not give away: a file planted at the clock-derived name does not stop the write", () => {
    mkdirSync(rig.dir, { recursive: true, mode: 0o700 });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T12:00:00Z"));
    const planted = path.join(rig.dir, `probe.${Date.now().toString(36)}.tmp`);
    writeFileSync(planted, "planted", { mode: 0o600 });
    writePrivateFile(rig.dir, "probe", "real");
    expect(readFileSync(path.join(rig.dir, "probe"), "utf8")).toBe("real");
    expect(readFileSync(planted, "utf8")).toBe("planted");
  });
});

describe("one register at a time", () => {
  it("two runs started together register once; the other is refused and sends nothing", async () => {
    const argv = ["register", "--code", CODE, "--credential-mode", "api_key", "--cloud-url", rig.cloud.origin];
    const [a, b] = await Promise.all([rig.run(argv), rig.run(argv)]);
    expect([a.code, b.code].sort()).toEqual([0, 1]);
    expect(rig.cloud.runners.size).toBe(1);
    expect(rig.cloud.seen.length).toBe(1);
    expect(stateFiles()).toEqual(["registration.json", "runner-key.pem"]);
  });

  it("a lock left by a dead run blocks for two minutes, then stops blocking, and is removed afterwards", async () => {
    mkdirSync(rig.dir, { recursive: true, mode: 0o700 });
    const lock = path.join(rig.dir, "register.lock");
    writeFileSync(lock, "", { mode: 0o600 });
    const blocked = await rig.register();
    expect(blocked.code).toBe(1);
    expect(blocked.err).toContain("another fx-runner register is running");
    expect(rig.cloud.seen).toEqual([]);
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(lock, old, old);
    expect((await rig.register()).code).toBe(0);
    expect(stateFiles()).toEqual(["registration.json", "runner-key.pem"]);
  });

  it("the lock is released when register fails", async () => {
    rig.cloud.force.push("rate_limit");
    expect((await rig.register()).code).toBe(1);
    expect(stateFiles()).toEqual([]);
  });
});

describe("the fake cloud orders its checks like the real handler", () => {
  it("answers a register with a bad message 400 even when it is unsigned, and a well-formed unsigned one 401", async () => {
    const bad = await fetch(`${rig.cloud.origin}/api/runner/register`, { method: "POST", body: JSON.stringify({ code: "nope" }) });
    expect(bad.status).toBe(400);
    const jwk = { kty: "OKP", crv: "Ed25519", x: "A".repeat(43) };
    const unsigned = await fetch(`${rig.cloud.origin}/api/runner/register`, { method: "POST", body: JSON.stringify({ code: CODE, public_key_jwk: jwk }) });
    expect(unsigned.status).toBe(401);
  });
});
