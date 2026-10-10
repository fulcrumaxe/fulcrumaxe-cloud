import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Fetcher } from "tuf-js";
import { TufClient, tufDir, type TufOutcome } from "../../src/update/tuf.js";
import type { TufBuildConfig } from "../../src/update/buildConfig.js";
import { buildRepo, damageSigned, inHours, makeKey, makeKeys, type BuiltRepo, type KeySet, type RepoSpec } from "../fixtures/tufRepo.js";
import { startTufServer, type TufServer } from "../fixtures/tufServer.js";

/**
 * The real `tuf-js` client against metadata built by `@tufjs/models` and served over real TLS (D#6 R6-2a). Every attack TUF defends
 * against has a test that makes the attack and expects a refusal that leaves nothing behind.
 */

const TARGET = "v1.0.0/fx-runner-linux-x64";
const CONTENT = Buffer.from("fx-runner release v1.0.0\n".repeat(64));
const sha256 = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanups.splice(0)) await fn();
});

interface World {
  keys: KeySet;
  repo: BuiltRepo;
  server: TufServer;
  stateDir: string;
  build: TufBuildConfig;
  client(build?: TufBuildConfig): TufClient;
  /** Serve another repository's metadata and files in place of the current ones. */
  serve(next: BuiltRepo): void;
}

async function world(spec: Partial<RepoSpec> = {}, keys: KeySet = makeKeys()): Promise<World> {
  const repo = buildRepo({ root: { version: 1, keys }, targets: [{ path: TARGET, content: CONTENT }], ...spec });
  const server = await startTufServer(repo);
  const stateDir = mkdtempSync(path.join(tmpdir(), "fx-tuf-"));
  cleanups.push(async () => {
    await server.close();
    rmSync(stateDir, { recursive: true, force: true });
  });
  const build: TufBuildConfig = { root: repo.rootText, metadataBaseUrl: server.metadataBase, targetBaseUrl: server.targetBase };
  return {
    keys,
    repo,
    server,
    stateDir,
    build,
    client: (over = build) => new TufClient({ stateDir, build: over, ca: server.ca }),
    serve: (next) => {
      server.metadata.clear();
      server.files.clear();
      for (const [k, v] of next.metadata) server.metadata.set(k, v);
      for (const [k, v] of next.files) server.files.set(k, v);
    },
  };
}

function expectRefused(outcome: TufOutcome, code?: string): void {
  expect(outcome.ok).toBe(false);
  if (outcome.ok) return;
  expect(outcome.state).toBe("refused");
  if (code !== undefined && outcome.state === "refused") expect(outcome.code).toBe(code);
}

const downloadedFiles = (w: World): string[] => (existsSync(path.join(tufDir(w.stateDir), "targets")) ? readdirSync(path.join(tufDir(w.stateDir), "targets")) : []);
const cachedRootVersion = (w: World): number => (JSON.parse(readFileSync(path.join(tufDir(w.stateDir), "root.json"), "utf8")) as { signed: { version: number } }).signed.version;

describe("acceptance 1: a valid update verifies", () => {
  it("returns a private file with the signed bytes, over consistent-snapshot names", async () => {
    const w = await world();
    const outcome = await w.client().fetchTarget(TARGET);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.sha256).toBe(sha256(CONTENT));
    expect(outcome.length).toBe(CONTENT.length);
    expect(outcome.remotePath).toBe(TARGET);
    expect(readFileSync(outcome.file).equals(CONTENT)).toBe(true);
    expect(path.dirname(outcome.file)).toBe(path.join(tufDir(w.stateDir), "targets"));
    expect(statSync(outcome.file).mode & 0o077).toBe(0);
    expect(statSync(tufDir(w.stateDir)).mode & 0o077).toBe(0);
    // The names the release repository serves: N.root.json until a 404, timestamp.json, N.snapshot.json, N.targets.json.
    expect(w.server.requests).toEqual(expect.arrayContaining(["A /metadata/2.root.json", "A /metadata/timestamp.json", "A /metadata/1.snapshot.json", "A /metadata/1.targets.json", `A /targets/${TARGET}`]));
    expect(w.server.requests).not.toContain("A /metadata/snapshot.json");
  });

  it("works again from the saved metadata, with an unchanged timestamp", async () => {
    const w = await world();
    expect((await w.client().fetchTarget(TARGET)).ok).toBe(true);
    expect((await w.client().fetchTarget(TARGET)).ok).toBe(true);
  });

  it("accepts a role whose threshold of 2 is met by two of its three keys, and refuses one valid signature", async () => {
    const keys = makeKeys(3);
    const ok = await world({ root: { version: 1, keys, thresholds: { targets: 2 } }, signWith: { targets: keys.targets.slice(0, 2) } }, keys);
    expect((await ok.client().fetchTarget(TARGET)).ok).toBe(true);
    const short = await world({ root: { version: 1, keys, thresholds: { targets: 2 } }, signWith: { targets: keys.targets.slice(0, 1) } }, keys);
    expectRefused(await short.client().fetchTarget(TARGET), "bad_signature");
    expect(downloadedFiles(short)).toEqual([]);
  });

  it("returns target_not_found for a file the signed metadata does not list", async () => {
    const w = await world();
    expectRefused(await w.client().fetchTarget("v9.9.9/fx-runner-linux-x64"), "target_not_found");
  });
});

describe("root rotation", () => {
  const rotated = () => {
    const old = makeKeys();
    const next = makeKeys();
    return { old, next };
  };

  it("follows a rotation signed by the old and the new root keys, and then trusts only the new keys", async () => {
    const { old, next } = rotated();
    const w = await world({ root: { version: 1, keys: old }, rotations: [{ version: 2, keys: next, signers: [...old.root, ...next.root] }] }, old);
    const outcome = await w.client().fetchTarget(TARGET);
    expect(outcome.ok).toBe(true);
    expect(cachedRootVersion(w)).toBe(2);
    // The next run starts from the build's version 1 root, and keeps the saved version 2.
    expect((await w.client().fetchTarget(TARGET)).ok).toBe(true);
    expect(cachedRootVersion(w)).toBe(2);
  });

  it("refuses a rotation the old root keys did not sign", async () => {
    const { old, next } = rotated();
    const w = await world({ root: { version: 1, keys: old }, rotations: [{ version: 2, keys: next, signers: next.root }] }, old);
    expectRefused(await w.client().fetchTarget(TARGET), "bad_signature");
    expect(cachedRootVersion(w)).toBe(1);
  });

  it("refuses a rotation the new root keys did not sign", async () => {
    const { old, next } = rotated();
    const w = await world({ root: { version: 1, keys: old }, rotations: [{ version: 2, keys: next, signers: old.root }] }, old);
    expectRefused(await w.client().fetchTarget(TARGET), "bad_signature");
    expect(cachedRootVersion(w)).toBe(1);
  });

  it("refuses metadata signed by a key the rotation removed", async () => {
    const { old, next } = rotated();
    const w = await world({ root: { version: 1, keys: old }, rotations: [{ version: 2, keys: next, signers: [...old.root, ...next.root] }], signWith: { timestamp: old.timestamp, snapshot: old.snapshot, targets: old.targets } }, old);
    expectRefused(await w.client().fetchTarget(TARGET), "bad_signature");
    expect(downloadedFiles(w)).toEqual([]);
  });

  it("refuses a root that skips a version", async () => {
    const { old, next } = rotated();
    const w = await world({ root: { version: 1, keys: old }, rotations: [{ version: 3, keys: next, signers: [...old.root, ...next.root] }] }, old);
    w.server.metadata.set("2.root.json", w.server.metadata.get("3.root.json")!);
    expectRefused(await w.client().fetchTarget(TARGET), "rollback");
  });
});

describe("acceptance 2: a metadata version rollback is refused", () => {
  const keys = makeKeys();

  it("refuses an older timestamp than the one already trusted, and still works with the real one afterwards", async () => {
    const w = await world({ timestampVersion: 5, snapshotVersion: 5, targetsVersion: 5 }, keys);
    expect((await w.client().fetchTarget(TARGET)).ok).toBe(true);
    const older = buildRepo({ root: { version: 1, keys }, timestampVersion: 4, snapshotVersion: 4, targetsVersion: 4, targets: [{ path: TARGET, content: Buffer.from("older release") }] });
    w.serve(older);
    expectRefused(await w.client().fetchTarget(TARGET), "rollback");
    w.serve(w.repo);
    expect((await w.client().fetchTarget(TARGET)).ok).toBe(true);
  });

  it("refuses a newer timestamp that lists an older snapshot", async () => {
    const w = await world({ timestampVersion: 5, snapshotVersion: 5, targetsVersion: 5 }, keys);
    expect((await w.client().fetchTarget(TARGET)).ok).toBe(true);
    w.serve(buildRepo({ root: { version: 1, keys }, timestampVersion: 6, snapshotVersion: 4, targetsVersion: 5, targets: [{ path: TARGET, content: CONTENT }] }));
    expectRefused(await w.client().fetchTarget(TARGET), "rollback");
  });

  it("refuses a newer snapshot that lists an older targets version", async () => {
    const w = await world({ timestampVersion: 5, snapshotVersion: 5, targetsVersion: 5 }, keys);
    expect((await w.client().fetchTarget(TARGET)).ok).toBe(true);
    w.serve(buildRepo({ root: { version: 1, keys }, timestampVersion: 6, snapshotVersion: 6, targetsVersion: 4, targets: [{ path: TARGET, content: CONTENT }] }));
    expectRefused(await w.client().fetchTarget(TARGET), "rollback");
  });

  it("refuses a snapshot whose number is not the one the timestamp names", async () => {
    const w = await world({ timestampVersion: 2, snapshotVersion: 2, timestampListsSnapshotVersion: 3, targetsVersion: 2 }, keys);
    w.server.metadata.set("3.snapshot.json", w.server.metadata.get("2.snapshot.json")!);
    expectRefused(await w.client().fetchTarget(TARGET));
  });

  it("refuses targets whose version is not the one the snapshot lists", async () => {
    const w = await world({ targetsVersion: 3, snapshotListsTargetsVersion: 4 }, keys);
    w.server.metadata.set("4.targets.json", w.server.metadata.get("3.targets.json")!);
    expectRefused(await w.client().fetchTarget(TARGET), "rollback");
  });

  it("refuses an old root served as the next one", async () => {
    const w = await world({}, keys);
    w.server.metadata.set("2.root.json", w.server.metadata.get("1.root.json")!);
    expectRefused(await w.client().fetchTarget(TARGET), "rollback");
  });
});

describe("acceptance 3: expired metadata (freeze) pauses updates", () => {
  const dateOf = (iso: string): string => new Date(iso).toISOString().slice(0, 10);

  for (const role of ["timestamp", "snapshot", "targets", "root"] as const) {
    it(`pauses on an expired ${role}, naming the date, and installs nothing`, async () => {
      const expires = inHours(-72);
      const keys = makeKeys();
      const w = await world(role === "root" ? { root: { version: 1, keys, expires } } : { expires: { [role]: expires } }, keys);
      const outcome = await w.client().fetchTarget(TARGET);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.state).toBe("paused");
      if (outcome.state !== "paused") return;
      expect(outcome.code).toBe("metadata_expired");
      expect(outcome.expiredOn).toBe(dateOf(expires));
      expect(outcome.message).toBe(`updates paused: release metadata expired on ${dateOf(expires)}`);
      expect(downloadedFiles(w)).toEqual([]);
    });
  }

  it("resumes once the release metadata is renewed", async () => {
    const keys = makeKeys();
    const w = await world({ expires: { timestamp: inHours(-5) } }, keys);
    expect((await w.client().fetchTarget(TARGET)).ok).toBe(false);
    w.serve(buildRepo({ root: { version: 1, keys }, timestampVersion: 2, targets: [{ path: TARGET, content: CONTENT }] }));
    expect((await w.client().fetchTarget(TARGET)).ok).toBe(true);
  });

  it("does not use a saved timestamp past its expiry in place of the server's", async () => {
    const keys = makeKeys();
    const w = await world({ expires: { timestamp: inHours(-1) } }, keys);
    await w.client().fetchTarget(TARGET);
    // The server now only offers the same expired timestamp (a replay): still paused, never "the saved one will do".
    const outcome = await w.client().fetchTarget(TARGET);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.state).toBe("paused");
  });
});

describe("acceptance 4: a bad signature is refused", () => {
  it("refuses targets signed by a key the root does not name", async () => {
    const w = await world({ signWith: { targets: [makeKey()] } });
    expectRefused(await w.client().fetchTarget(TARGET), "bad_signature");
    expect(downloadedFiles(w)).toEqual([]);
  });

  it("refuses a timestamp signed with another role's key", async () => {
    const keys = makeKeys();
    const w = await world({ signWith: { timestamp: keys.snapshot } }, keys);
    expectRefused(await w.client().fetchTarget(TARGET), "bad_signature");
  });

  it("refuses a snapshot signed with another role's key", async () => {
    const keys = makeKeys();
    const w = await world({ signWith: { snapshot: keys.targets } }, keys);
    expectRefused(await w.client().fetchTarget(TARGET));
  });

  it("refuses targets changed after they were signed", async () => {
    const w = await world();
    const name = "1.targets.json";
    w.server.metadata.set(name, damageSigned(w.server.metadata.get(name)!, `"length":${CONTENT.length}`, `"length":${CONTENT.length + 1}`));
    expectRefused(await w.client().fetchTarget(TARGET));
    expect(downloadedFiles(w)).toEqual([]);
  });

  it("refuses a timestamp changed after it was signed", async () => {
    const w = await world();
    const bytes = w.server.metadata.get("timestamp.json")!;
    const version = '"version":1';
    w.server.metadata.set("timestamp.json", damageSigned(bytes, version, '"version":9'));
    expectRefused(await w.client().fetchTarget(TARGET), "bad_signature");
  });

  it("refuses a snapshot that is not the bytes the timestamp hashes", async () => {
    const w = await world();
    w.server.metadata.set("1.snapshot.json", damageSigned(w.server.metadata.get("1.snapshot.json")!, "targets.json", "targets.json "));
    expectRefused(await w.client().fetchTarget(TARGET));
  });

  it("refuses a build whose own root is not signed by its keys", async () => {
    const w = await world();
    const forged = w.repo.rootText.replace(/"expires":"[^"]+"/, '"expires":"2099-01-01T00:00:00Z"');
    expectRefused(await w.client({ ...w.build, root: forged }).fetchTarget(TARGET));
  });

  it("refuses a request that metadata which is not JSON", async () => {
    const w = await world();
    w.server.metadata.set("timestamp.json", Buffer.from("<html>not metadata</html>"));
    expectRefused(await w.client().fetchTarget(TARGET));
  });
});

describe("acceptance 5: a target that does not match its signed hash or length is refused", () => {
  it("refuses the same length with other content", async () => {
    const w = await world();
    w.server.files.set(TARGET, Buffer.alloc(CONTENT.length, 0x41));
    expectRefused(await w.client().fetchTarget(TARGET), "target_mismatch");
    expect(downloadedFiles(w)).toEqual([]);
  });

  it("refuses a shorter file", async () => {
    const w = await world();
    w.server.files.set(TARGET, CONTENT.subarray(0, CONTENT.length - 1));
    expectRefused(await w.client().fetchTarget(TARGET), "target_mismatch");
    expect(downloadedFiles(w)).toEqual([]);
  });

  it("stops reading a file that is longer than signed instead of taking it all", async () => {
    const w = await world();
    w.server.files.set(TARGET, Buffer.concat([CONTENT, Buffer.alloc(8 * 1024 * 1024, 0x42)]));
    expectRefused(await w.client().fetchTarget(TARGET), "target_mismatch");
    expect(downloadedFiles(w)).toEqual([]);
  });

  it("refuses a signed length that the content does not have, even with the right hash", async () => {
    const w = await world({ targets: [{ path: TARGET, content: CONTENT, length: CONTENT.length + 5 }] });
    expectRefused(await w.client().fetchTarget(TARGET), "target_mismatch");
  });

  it("refuses a file with a wrong signed hash", async () => {
    const w = await world({ targets: [{ path: TARGET, content: CONTENT, hashes: { sha256: "0".repeat(64) } }] });
    expectRefused(await w.client().fetchTarget(TARGET), "target_mismatch");
  });

  it("refuses a target the metadata describes without a SHA-256", async () => {
    const sha512 = createHash("sha512").update(CONTENT).digest("hex");
    const w = await world({ targets: [{ path: TARGET, content: CONTENT, hashes: { sha512 } }] });
    expectRefused(await w.client().fetchTarget(TARGET), "invalid_metadata");
    expect(downloadedFiles(w)).toEqual([]);
  });

  it("does not leave an earlier verified file in place of a later failed download", async () => {
    const w = await world();
    const first = await w.client().fetchTarget(TARGET);
    expect(first.ok).toBe(true);
    w.server.files.set(TARGET, Buffer.alloc(CONTENT.length, 0x43));
    expectRefused(await w.client().fetchTarget(TARGET), "target_mismatch");
    expect(downloadedFiles(w)).toEqual([]);
  });

  it("refuses metadata larger than its limit (endless data)", async () => {
    const w = await world();
    w.server.metadata.set("timestamp.json", Buffer.alloc(3 * 1024 * 1024, 0x20));
    expectRefused(await w.client().fetchTarget(TARGET));
  });

  it("answers download_failed when the file is missing", async () => {
    const w = await world();
    w.server.files.delete(TARGET);
    expectRefused(await w.client().fetchTarget(TARGET), "download_failed");
  });
});

describe("acceptance 6: redirects", () => {
  it("follows a target's redirect to another https origin (GitHub's release CDN)", async () => {
    const w = await world();
    w.server.redirects.set(`/targets/${TARGET}`, `${w.server.originB}/files/${TARGET}`);
    const outcome = await w.client().fetchTarget(TARGET);
    expect(outcome.ok).toBe(true);
    expect(w.server.requests).toEqual(expect.arrayContaining([`A /targets/${TARGET}`, `B /files/${TARGET}`]));
  });

  it("follows a metadata file's redirect too", async () => {
    const w = await world();
    w.server.files.set("md/timestamp.json", w.server.metadata.get("timestamp.json")!);
    w.server.redirects.set("/metadata/timestamp.json", `${w.server.originB}/files/md/timestamp.json`);
    expect((await w.client().fetchTarget(TARGET)).ok).toBe(true);
    expect(w.server.requests).toContain("B /files/md/timestamp.json");
  });

  it("still checks the hash of a file that arrived through a redirect", async () => {
    const w = await world();
    w.server.files.set("evil", Buffer.alloc(CONTENT.length, 0x44));
    w.server.redirects.set(`/targets/${TARGET}`, `${w.server.originB}/files/evil`);
    expectRefused(await w.client().fetchTarget(TARGET), "target_mismatch");
  });

  it("refuses a hop to http: before connecting to it", async () => {
    const w = await world();
    w.server.redirects.set(`/targets/${TARGET}`, `${w.server.plainOrigin}/files/${TARGET}`);
    expectRefused(await w.client().fetchTarget(TARGET), "redirect_refused");
    expect(w.server.plainHits.count).toBe(0);
    expect(downloadedFiles(w)).toEqual([]);
  });

  it("refuses an http: hop in the middle of a chain of https hops", async () => {
    const w = await world();
    w.server.files.set("x", CONTENT);
    w.server.redirects.set(`/targets/${TARGET}`, `${w.server.originA}/targets/hop`);
    w.server.redirects.set("/targets/hop", `${w.server.plainOrigin}/x`);
    expectRefused(await w.client().fetchTarget(TARGET), "redirect_refused");
    expect(w.server.plainHits.count).toBe(0);
  });

  it("refuses a redirect loop after a few hops", async () => {
    const w = await world();
    w.server.redirects.set(`/targets/${TARGET}`, `${w.server.originA}/targets/${TARGET}`);
    expectRefused(await w.client().fetchTarget(TARGET), "redirect_refused");
    expect(w.server.requests.filter((r) => r === `A /targets/${TARGET}`).length).toBeLessThanOrEqual(7);
  });

  it("refuses a redirect to an address with credentials", async () => {
    const w = await world();
    w.server.redirects.set(`/targets/${TARGET}`, `https://user:pass@127.0.0.1:${new URL(w.server.originB).port}/files/${TARGET}`);
    expectRefused(await w.client().fetchTarget(TARGET), "redirect_refused");
  });

  it("answers download_failed when the redirect target is missing", async () => {
    const w = await world();
    w.server.redirects.set(`/targets/${TARGET}`, `${w.server.originB}/files/missing`);
    expectRefused(await w.client().fetchTarget(TARGET), "download_failed");
  });

  it("does not trust a certificate it was not given", async () => {
    const w = await world();
    const stranger = new TufClient({ stateDir: w.stateDir, build: w.build });
    expectRefused(await stranger.fetchTarget(TARGET), "download_failed");
  });

  it("refuses a plain-http base address without any request", async () => {
    const w = await world();
    const outcome = await w.client({ ...w.build, metadataBaseUrl: `${w.server.plainOrigin}/metadata/` }).fetchTarget(TARGET);
    expectRefused(outcome, "url_not_allowed");
    expect(w.server.plainHits.count).toBe(0);
    expect(w.server.requests).toEqual([]);
  });
});

describe("acceptance 7: without a root, no network call", () => {
  it("makes no call, writes nothing and says updates are not configured", async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "fx-tuf-off-"));
    cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
    const calls: string[] = [];
    const counting: Fetcher = {
      downloadFile: (async (url: string) => {
        calls.push(url);
        throw new Error("no network in this test");
      }) as Fetcher["downloadFile"],
      downloadBytes: async (url: string) => {
        calls.push(url);
        throw new Error("no network in this test");
      },
    };
    const httpsGet = vi.spyOn(https, "get");
    const httpsRequest = vi.spyOn(https, "request");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    for (const build of [
      { root: undefined, metadataBaseUrl: "https://example.invalid/m/", targetBaseUrl: "https://example.invalid/t/" },
      { root: undefined, metadataBaseUrl: undefined, targetBaseUrl: undefined },
      { root: "{}", metadataBaseUrl: undefined, targetBaseUrl: "https://example.invalid/t/" },
    ] satisfies TufBuildConfig[]) {
      const client = new TufClient({ stateDir, build, fetcher: counting });
      expect(client.configured).toBe(false);
      const outcome = await client.fetchTarget(TARGET);
      expect(outcome).toEqual({ ok: false, state: "not_configured", message: "updates are not configured in this build" });
    }
    expect(calls).toEqual([]);
    expect(httpsGet).not.toHaveBeenCalled();
    expect(httpsRequest).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(existsSync(tufDir(stateDir))).toBe(false);
  });

  it("is what the shipped build says: the trusted root is compiled in, the locations are not chosen, so updates stay off", async () => {
    const { TUF_BUILD } = await import("../../src/update/buildConfig.js");
    const { TRUSTED_ROOT_TEXT } = await import("../../src/update/trustedRoot.js");
    const { tufConfigured } = await import("../../src/update/tuf.js");
    expect(TUF_BUILD).toEqual({ root: TRUSTED_ROOT_TEXT, metadataBaseUrl: undefined, targetBaseUrl: undefined });
    expect(Object.isFrozen(TUF_BUILD)).toBe(true);
    expect(tufConfigured(TUF_BUILD)).toBe(false);
  });

  it("ignores a root.json that sits in the state directory when the build has none", async () => {
    const w = await world();
    const tuf = tufDir(w.stateDir);
    await w.client().fetchTarget(TARGET);
    expect(existsSync(path.join(tuf, "root.json"))).toBe(true);
    const off = new TufClient({ stateDir: w.stateDir, build: { root: undefined, metadataBaseUrl: w.server.metadataBase, targetBaseUrl: w.server.targetBase }, ca: w.server.ca });
    const before = w.server.requests.length;
    expect((await off.fetchTarget(TARGET)).ok).toBe(false);
    expect(w.server.requests.length).toBe(before);
  });
});

describe("the saved root and the target name", () => {
  it("replaces a saved root that cannot be read with the build's", async () => {
    const w = await world();
    await w.client().fetchTarget(TARGET);
    writeFileSync(path.join(tufDir(w.stateDir), "root.json"), "{ not json");
    expect((await w.client().fetchTarget(TARGET)).ok).toBe(true);
    expect(cachedRootVersion(w)).toBe(1);
  });

  it("takes a newer root from the build over the saved one", async () => {
    const keys = makeKeys();
    const w = await world({ root: { version: 1, keys } }, keys);
    await w.client().fetchTarget(TARGET);
    const v2 = buildRepo({ root: { version: 2, keys }, targets: [{ path: TARGET, content: CONTENT }] });
    const outcome = await w.client({ ...w.build, root: v2.rootText }).fetchTarget(TARGET);
    expect(outcome.ok).toBe(true);
    expect(cachedRootVersion(w)).toBe(2);
  });

  for (const bad of ["../etc/passwd", "/abs/path", "a/../b", "a//b", "v1/%2e%2e/x", "v1/x?y=1", "v1/x#f", "v1\\x", "", ".hidden/x", "a/.b", "x".repeat(300)]) {
    it(`refuses the target name ${JSON.stringify(bad.slice(0, 30))} before any request`, async () => {
      const w = await world();
      expectRefused(await w.client().fetchTarget(bad), "bad_target_path");
      expect(w.server.requests).toEqual([]);
    });
  }
});
