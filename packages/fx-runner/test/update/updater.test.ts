import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAutoUpdate } from "../../src/update/updater.js";
import { UPDATE_STATE_FILE, installedVersions, linkedVersion, loadUpdateState, saveUpdateState, versionBinary } from "../../src/update/versions.js";
import { program, sha256, updateWorld } from "../helpers/updateWorld.js";

const T = (v: string, platform = "linux-x64"): string => `v${v}/fx-runner-${platform}`;

describe("check: which version the verified metadata offers", () => {
  it("takes the newest version for this platform and ignores other platforms, odd names and non-versions", async () => {
    const w = updateWorld();
    for (const name of [T("1.1.0"), T("1.10.0"), T("1.9.0"), T("9.9.9", "darwin-arm64"), "v2.0.0-rc1/fx-runner-linux-x64", "v3.0/fx-runner-linux-x64", "x/../v7.0.0/fx-runner-linux-x64", "release-manifest.json"]) w.tuf.add(name, Buffer.from("x"));
    const result = await w.updater.check();
    expect(result).toEqual({ ok: true, current: "1.0.0", available: "1.10.0" });
    expect(loadUpdateState(w.stateDir).available).toBe("1.10.0");
    expect(loadUpdateState(w.stateDir).lastCheck).toBe(w.clock.now.toISOString());
  });

  it("an expired timestamp is 'paused' with the date, recorded for doctor, and installs nothing", async () => {
    const w = updateWorld();
    w.tuf.listOutcome = { ok: false, state: "paused", code: "metadata_expired", expiredOn: "2026-10-01", message: "updates paused: release metadata expired on 2026-10-01" };
    const result = await w.updater.applyLatest();
    expect(result).toEqual({ ok: false, code: "paused", message: "updates paused: release metadata expired on 2026-10-01" });
    expect(loadUpdateState(w.stateDir).paused).toBe("release metadata expired on 2026-10-01");
    expect(w.tuf.fetchCalls).toEqual([]);
  });
});

describe("applying a newer version", () => {
  it("stages 0755 under versions/<v>, checks it starts, switches the link by rename, keeps the old one as previous", async () => {
    const w = updateWorld();
    const next = program("1.1.0");
    w.tuf.add(T("1.1.0"), next);
    const result = await w.updater.applyLatest();
    expect(result).toEqual({ ok: true, message: "Updated to 1.1.0.", version: "1.1.0" });
    expect(w.tuf.fetchCalls).toEqual([T("1.1.0")]);
    const staged = versionBinary(w.stateDir, "1.1.0");
    expect(readFileSync(staged).equals(next)).toBe(true);
    expect(statSync(staged).mode & 0o777).toBe(0o755);
    expect(readlinkSync(path.join(w.stateDir, "bin", "fx-runner"))).toBe("../versions/1.1.0/fx-runner");
    const state = loadUpdateState(w.stateDir);
    expect(state.previous).toBe("1.0.0");
    expect(state.applying).toBeUndefined();
    expect(readdirSync(path.join(w.stateDir, "versions")).sort()).toEqual(["1.0.0", "1.1.0"]);
    // the downloaded copy under the TUF folder is not left behind
    expect(readdirSync(path.join(w.root, "downloads"))).toEqual([]);
  });

  it("keeps exactly one previous version", async () => {
    const w = updateWorld();
    w.tuf.add(T("1.1.0"), program("1.1.0"));
    await w.updater.applyLatest();
    w.tuf.add(T("1.2.0"), program("1.2.0"));
    await w.updater.applyLatest();
    expect(installedVersions(w.stateDir).sort()).toEqual(["1.1.0", "1.2.0"]);
    expect(loadUpdateState(w.stateDir).previous).toBe("1.1.0");
  });

  it("never goes down by itself: an older or equal offer changes nothing", async () => {
    const w = updateWorld({ installed: ["1.5.0"], current: "1.5.0" });
    w.tuf.add(T("1.4.0"), program("1.4.0"));
    w.tuf.add(T("1.5.0"), program("1.5.0"));
    const result = await w.updater.applyLatest();
    expect(result.ok).toBe(true);
    expect(w.tuf.fetchCalls).toEqual([]);
    expect(linkedVersion(w.stateDir)).toBe("1.5.0");
    // and the internal path refuses it too, not only the check
    expect(await w.updater.install("1.4.0", false)).toMatchObject({ ok: false, code: "downgrade" });
    expect(w.tuf.fetchCalls).toEqual([]);
  });

  it("applies only what TUF handed back: a file whose bytes no longer match the verified hash is refused and leaves nothing", async () => {
    const w = updateWorld();
    w.tuf.add(T("1.1.0"), program("1.1.0"));
    w.tuf.lieAboutHash = sha256("something else");
    const result = await w.updater.applyLatest();
    expect(result).toMatchObject({ ok: false });
    expect(linkedVersion(w.stateDir)).toBe("1.0.0");
    expect(installedVersions(w.stateDir)).toEqual(["1.0.0"]);
    expect(readdirSync(path.join(w.stateDir, "versions"))).toEqual(["1.0.0"]);
  });

  it.each([
    ["a bad signature", { ok: false, state: "refused", code: "bad_signature", message: "release metadata did not carry enough valid signatures; nothing was installed" } as const],
    ["a rollback of the metadata", { ok: false, state: "refused", code: "rollback", message: "the release metadata went back to an older version; nothing was installed" } as const],
    ["a target hash mismatch", { ok: false, state: "refused", code: "target_mismatch", message: "the downloaded file does not match the signed length and hash" } as const],
  ])("%s from the release client leaves the running version in place", async (_name, outcome) => {
    const w = updateWorld();
    w.tuf.add(T("1.1.0"), program("1.1.0"));
    w.tuf.fetchOutcome = outcome;
    const result = await w.updater.applyLatest();
    expect(result).toMatchObject({ ok: false, code: outcome.code });
    expect(linkedVersion(w.stateDir)).toBe("1.0.0");
    expect(readdirSync(path.join(w.stateDir, "versions"))).toEqual(["1.0.0"]);
    expect(loadUpdateState(w.stateDir).applying).toBeUndefined();
  });
});

describe("the start check, and rolling back automatically", () => {
  it("a version that does not start (wrong version line) is removed before the switch and not tried again", async () => {
    const w = updateWorld();
    w.tuf.add(T("1.1.0"), program("1.1.0", { versionLine: "fx-runner 9.9.9 (test)" }));
    const result = await w.updater.applyLatest();
    expect(result).toMatchObject({ ok: false, code: "start_check_failed" });
    expect(linkedVersion(w.stateDir)).toBe("1.0.0");
    expect(readdirSync(path.join(w.stateDir, "versions"))).toEqual(["1.0.0"]);
    expect(loadUpdateState(w.stateDir).failed).toBe("1.1.0");
    // the next check skips it without downloading again
    const again = await w.updater.applyLatest();
    expect(again).toMatchObject({ ok: false, code: "failed_before" });
    expect(w.tuf.fetchCalls).toHaveLength(1);
    // a newer fixed version is tried
    w.tuf.add(T("1.1.1"), program("1.1.1"));
    expect(await w.updater.applyLatest()).toMatchObject({ ok: true, version: "1.1.1" });
  });

  it("a version that fails its check is never started through the stable path: the link does not point at it even for a moment", async () => {
    const w = updateWorld();
    const mark = path.join(w.root, "via-link.txt");
    w.tuf.add(T("1.1.0"), program("1.1.0", { versionLine: "fx-runner 9.9.9", markViaLink: mark }));
    expect(await w.updater.applyLatest()).toMatchObject({ ok: false, code: "start_check_failed" });
    expect(existsSync(mark)).toBe(false);
  });

  it("a version whose sandbox probe fails is not switched to", async () => {
    const w = updateWorld();
    w.tuf.add(T("1.1.0"), program("1.1.0", { doctorExit: 3 }));
    expect(await w.updater.applyLatest()).toMatchObject({ ok: false, code: "start_check_failed" });
    expect(linkedVersion(w.stateDir)).toBe("1.0.0");
  });

  it("a program that passes at its own path but fails when started through the stable link is switched back", async () => {
    const w = updateWorld();
    w.tuf.add(T("1.1.0"), program("1.1.0", { failViaLink: true }));
    const result = await w.updater.applyLatest();
    expect(result).toMatchObject({ ok: false, code: "start_check_failed" });
    expect(result.ok ? "" : result.message).toContain("rolled back to 1.0.0");
    expect(readlinkSync(path.join(w.stateDir, "bin", "fx-runner"))).toBe("../versions/1.0.0/fx-runner");
    expect(readdirSync(path.join(w.stateDir, "versions"))).toEqual(["1.0.0"]);
    expect(loadUpdateState(w.stateDir).failed).toBe("1.1.0");
  });

  it("a program that cannot be run at all (the host throws) fails closed", async () => {
    const w = updateWorld({ over: { run: async () => Promise.reject(new Error("spawn failed")) } });
    w.tuf.add(T("1.1.0"), program("1.1.0"));
    expect(await w.updater.applyLatest()).toMatchObject({ ok: false, code: "start_check_failed" });
    expect(linkedVersion(w.stateDir)).toBe("1.0.0");
    expect(readdirSync(path.join(w.stateDir, "versions"))).toEqual(["1.0.0"]);
  });
});

describe("a crash between staging and switching (acceptance 2)", () => {
  it("leaves the old binary in place, and the next cleanup removes the partial versions/<v> directory and the staging directory", async () => {
    const w = updateWorld();
    const before = readFileSync(path.join(w.stateDir, "bin", "fx-runner"));
    // What a kill after the move into versions/ but before the switch leaves on disk:
    mkdirSync(path.join(w.stateDir, "versions", "1.1.0"));
    writeFileSync(versionBinary(w.stateDir, "1.1.0"), program("1.1.0"), { mode: 0o755 });
    mkdirSync(path.join(w.stateDir, "versions", ".staging-abc123"));
    writeFileSync(path.join(w.stateDir, "versions", ".staging-abc123", "fx-runner"), "half");
    saveUpdateState(w.stateDir, { version: 1, autoUpdate: true, applying: { version: "1.1.0", from: "1.0.0" } });
    expect(readFileSync(path.join(w.stateDir, "bin", "fx-runner")).equals(before)).toBe(true);
    await w.updaterWith().cleanup();
    expect(readdirSync(path.join(w.stateDir, "versions"))).toEqual(["1.0.0"]);
    expect(linkedVersion(w.stateDir)).toBe("1.0.0");
    expect(loadUpdateState(w.stateDir).applying).toBeUndefined();
  });

  it("a kill after the switch but before the record is finished by the next cleanup: the new version stays, the old one becomes previous", async () => {
    const w = updateWorld({ installed: ["1.0.0", "1.1.0"], current: "1.1.0" });
    saveUpdateState(w.stateDir, { version: 1, autoUpdate: true, applying: { version: "1.1.0", from: "1.0.0" } });
    await w.updater.cleanup();
    const state = loadUpdateState(w.stateDir);
    expect(state.previous).toBe("1.0.0");
    expect(state.applying).toBeUndefined();
    expect(installedVersions(w.stateDir).sort()).toEqual(["1.0.0", "1.1.0"]);
  });

  it("a cleanup never removes the kept previous version or directories it does not recognise", async () => {
    const w = updateWorld({ installed: ["1.0.0", "1.1.0"], current: "1.1.0" });
    mkdirSync(path.join(w.stateDir, "versions", "notes"));
    saveUpdateState(w.stateDir, { version: 1, autoUpdate: true, previous: "1.0.0" });
    await w.updater.cleanup();
    expect(readdirSync(path.join(w.stateDir, "versions")).sort()).toEqual(["1.0.0", "1.1.0", "notes"]);
  });

  it("a held lock makes an update stop with 'busy' and change nothing; a stale one is taken over", async () => {
    const w = updateWorld();
    w.tuf.add(T("1.1.0"), program("1.1.0"));
    const lock = path.join(w.stateDir, "update.lock");
    writeFileSync(lock, "");
    expect(await w.updater.applyLatest()).toMatchObject({ ok: false, code: "busy" });
    expect(linkedVersion(w.stateDir)).toBe("1.0.0");
    const old = new Date(w.clock.now.getTime() - 3_600_000);
    utimesSync(lock, old, old);
    expect(await w.updater.applyLatest()).toMatchObject({ ok: true, version: "1.1.0" });
    expect(existsSync(lock)).toBe(false);
  });
});

describe("rollback (acceptance 3)", () => {
  it("restores the previous binary byte for byte and stops automatic updates from re-applying the version it left", async () => {
    const w = updateWorld();
    const original = readFileSync(versionBinary(w.stateDir, "1.0.0"));
    w.tuf.add(T("1.1.0"), program("1.1.0"));
    await w.updater.applyLatest();
    const result = await w.updater.rollback();
    expect(result).toMatchObject({ ok: true, version: "1.0.0" });
    expect(readFileSync(path.join(w.stateDir, "bin", "fx-runner")).equals(original)).toBe(true);
    expect(linkedVersion(w.stateDir)).toBe("1.0.0");
    const state = loadUpdateState(w.stateDir);
    expect(state.previous).toBe("1.1.0");
    expect(state.failed).toBe("1.1.0");
    expect(await w.updater.applyLatest()).toMatchObject({ ok: false, code: "failed_before" });
    expect(w.tuf.fetchCalls).toHaveLength(1);
  });

  it("with no previous version kept it refuses with a closed message and changes nothing", async () => {
    const w = updateWorld();
    const result = await w.updater.rollback();
    expect(result).toEqual({ ok: false, code: "no_previous", message: "there is no previous version kept to roll back to" });
    expect(linkedVersion(w.stateDir)).toBe("1.0.0");
  });

  it("a previous directory that is gone is the same refusal", async () => {
    const w = updateWorld();
    saveUpdateState(w.stateDir, { version: 1, autoUpdate: true, previous: "0.9.0" });
    expect(await w.updater.rollback()).toMatchObject({ ok: false, code: "no_previous" });
  });

  it("a previous version that no longer starts is not switched to", async () => {
    const w = updateWorld({ installed: ["1.0.0", "1.1.0"], current: "1.1.0" });
    writeFileSync(versionBinary(w.stateDir, "1.0.0"), program("1.0.0", { doctorExit: 1 }), { mode: 0o755 });
    saveUpdateState(w.stateDir, { version: 1, autoUpdate: true, previous: "1.0.0" });
    expect(await w.updater.rollback()).toMatchObject({ ok: false, code: "start_check_failed" });
    expect(linkedVersion(w.stateDir)).toBe("1.1.0");
  });
});

describe("pin, unpin, auto-update off", () => {
  it("a pin may name an older version (installed through TUF) and automatic updates then hold it", async () => {
    const w = updateWorld({ installed: ["1.5.0"], current: "1.5.0" });
    w.tuf.add(T("1.2.0"), program("1.2.0"));
    w.tuf.add(T("1.6.0"), program("1.6.0"));
    const pinned = await w.updater.pin("1.2.0");
    expect(pinned).toMatchObject({ ok: true, version: "1.2.0" });
    expect(linkedVersion(w.stateDir)).toBe("1.2.0");
    expect(loadUpdateState(w.stateDir).pinned).toBe("1.2.0");
    w.tuf.fetchCalls.length = 0;
    expect(await w.updater.applyLatest()).toMatchObject({ ok: true });
    expect(w.tuf.fetchCalls).toEqual([]);
    expect(linkedVersion(w.stateDir)).toBe("1.2.0");
    expect(w.updater.unpin()).toMatchObject({ ok: true });
    expect(loadUpdateState(w.stateDir).pinned).toBeUndefined();
    expect(await w.updater.applyLatest()).toMatchObject({ ok: true, version: "1.6.0" });
  });

  it("a pin that cannot be installed is not recorded", async () => {
    const w = updateWorld();
    expect(await w.updater.pin("4.0.0")).toMatchObject({ ok: false, code: "target_not_found" });
    expect(loadUpdateState(w.stateDir).pinned).toBeUndefined();
    expect(await w.updater.pin("latest")).toMatchObject({ ok: false, code: "bad_version" });
  });

  it("pinning the kept previous version switches to it without a download", async () => {
    const w = updateWorld();
    w.tuf.add(T("1.1.0"), program("1.1.0"));
    await w.updater.applyLatest();
    w.tuf.fetchCalls.length = 0;
    expect(await w.updater.pin("1.0.0")).toMatchObject({ ok: true, version: "1.0.0" });
    expect(w.tuf.fetchCalls).toEqual([]);
    expect(linkedVersion(w.stateDir)).toBe("1.0.0");
  });

  it("a damaged update.json turns automatic updates off and no command writes over it", async () => {
    const w = updateWorld();
    writeFileSync(path.join(w.stateDir, UPDATE_STATE_FILE), "{not json", { mode: 0o600 });
    expect(loadUpdateState(w.stateDir).damaged).toBe(true);
    expect(await w.updater.applyLatest()).toMatchObject({ ok: false, code: "state_damaged" });
    expect(w.updater.setAutoUpdate(true)).toMatchObject({ ok: false });
    expect(readFileSync(path.join(w.stateDir, UPDATE_STATE_FILE), "utf8")).toBe("{not json");
  });
});

describe("what is never switched (acceptance 5)", () => {
  it.each([
    ["/opt/homebrew/Cellar/fx-runner/1.0.0/bin/fx-runner"],
    ["/usr/local/Cellar/fx-runner/1.0.0/bin/fx-runner"],
    ["/home/linuxbrew/.linuxbrew/Cellar/fx-runner/1.0.0/bin/fx-runner"],
    ["/opt/homebrew/bin/fx-runner"],
  ])("a Homebrew path (%s) never stages or switches, however the call is made", async (execPath) => {
    const w = updateWorld({ over: { execPath } });
    w.tuf.add(T("1.1.0"), program("1.1.0"));
    const before = readdirSync(path.join(w.stateDir, "versions"));
    expect(await w.updater.applyLatest()).toMatchObject({ ok: false, code: "homebrew" });
    expect(await w.updater.install("1.1.0", true)).toMatchObject({ ok: false, code: "homebrew" });
    expect(await w.updater.pin("1.1.0")).toMatchObject({ ok: false, code: "homebrew" });
    expect(await w.updater.rollback()).toMatchObject({ ok: false, code: "homebrew" });
    expect(w.tuf.fetchCalls).toEqual([]);
    expect(readdirSync(path.join(w.stateDir, "versions"))).toEqual(before);
    expect(linkedVersion(w.stateDir)).toBe("1.0.0");
  });

  it("a program that does not run from versions/ (a source checkout) never switches the link", async () => {
    const w = updateWorld({ over: { execPath: "/opt/somewhere/node" } });
    w.tuf.add(T("1.1.0"), program("1.1.0"));
    expect(await w.updater.applyLatest()).toMatchObject({ ok: false, code: "unmanaged" });
    expect(w.tuf.fetchCalls).toEqual([]);
  });

  it.each([
    ["a regular file", (link: string) => { rmSync(link); writeFileSync(link, "x"); }],
    ["a link to somewhere else", (link: string) => { rmSync(link); symlinkSync("/usr/bin/true", link); }],
    ["a link with a version that is not x.y.z", (link: string) => { rmSync(link); symlinkSync("../versions/1.0/fx-runner", link); }],
  ])("a stable path that is %s is not a managed install: nothing is fetched or changed", async (_name, arrange) => {
    const w = updateWorld();
    w.tuf.add(T("1.1.0"), program("1.1.0"));
    const link = path.join(w.stateDir, "bin", "fx-runner");
    arrange(link);
    expect(linkedVersion(w.stateDir)).toBeUndefined();
    expect(await w.updater.applyLatest()).toMatchObject({ ok: false, code: "unmanaged" });
    expect(w.tuf.fetchCalls).toEqual([]);
    expect(lstatSync(link).isSymbolicLink()).toBe(_name !== "a regular file");
  });
});

describe("automatic checks (acceptance 1)", () => {
  const SIX_HOURS = 6 * 3_600_000;

  it("a lease held means no check at all; with no lease the check runs on schedule (fake clock, counting client)", async () => {
    const w = updateWorld();
    w.tuf.add(T("1.1.0"), program("1.1.0"));
    let lease = true;
    const auto = createAutoUpdate({ updater: w.updater, hasLease: () => lease, now: () => w.clock.now });
    expect(await auto.tick()).toEqual({ kind: "none" });
    expect(w.tuf.listCalls).toBe(0);
    expect(w.tuf.fetchCalls).toEqual([]);

    lease = false;
    expect(await auto.tick()).toEqual({ kind: "applied", version: "1.1.0" });
    expect(w.tuf.listCalls).toBe(1);

    // inside six hours: nothing; at six hours: a check
    w.tuf.add(T("1.2.0"), program("1.2.0"));
    w.clock.now = new Date(w.clock.now.getTime() + SIX_HOURS - 1000);
    expect(await auto.tick()).toEqual({ kind: "none" });
    expect(w.tuf.listCalls).toBe(1);
    w.clock.now = new Date(w.clock.now.getTime() + 1000);
    expect(await auto.tick()).toEqual({ kind: "applied", version: "1.2.0" });
    expect(w.tuf.listCalls).toBe(2);
  });

  it("the schedule survives a restart: it reads the last check from update.json", async () => {
    const w = updateWorld();
    await w.updater.check();
    const restarted = createAutoUpdate({ updater: w.updaterWith(), hasLease: () => false, now: () => w.clock.now });
    expect(await restarted.tick()).toEqual({ kind: "none" });
    expect(w.tuf.listCalls).toBe(1);
  });

  it("a failed check is not retried before the interval, and a clock that went backwards counts as due", async () => {
    const w = updateWorld();
    w.tuf.listOutcome = { ok: false, state: "refused", code: "download_failed", message: "a download failed; nothing was installed" };
    const auto = createAutoUpdate({ updater: w.updater, hasLease: () => false, now: () => w.clock.now });
    expect(await auto.tick()).toMatchObject({ kind: "checked" });
    expect(await auto.tick()).toEqual({ kind: "none" });
    expect(w.tuf.listCalls).toBe(1);
    w.clock.now = new Date(w.clock.now.getTime() - 86_400_000);
    expect(await auto.tick()).toMatchObject({ kind: "checked" });
    expect(w.tuf.listCalls).toBe(2);
  });

  it.each([
    ["auto-update off", (w: ReturnType<typeof updateWorld>) => w.updater.setAutoUpdate(false)],
    ["a pin", (w: ReturnType<typeof updateWorld>) => saveUpdateState(w.stateDir, { version: 1, autoUpdate: true, pinned: "1.0.0" })],
  ])("%s means no network call", async (_name, arrange) => {
    const w = updateWorld();
    w.tuf.add(T("1.1.0"), program("1.1.0"));
    arrange(w);
    const auto = createAutoUpdate({ updater: w.updater, hasLease: () => false, now: () => w.clock.now });
    expect(await auto.tick()).toEqual({ kind: "none" });
    expect(w.tuf.listCalls).toBe(0);
  });

  it("a build with no root makes no call and writes no state", async () => {
    const w = updateWorld();
    w.tuf.configured = false;
    const auto = createAutoUpdate({ updater: w.updater, hasLease: () => false, now: () => w.clock.now });
    expect(await auto.tick()).toEqual({ kind: "none" });
    expect(w.tuf.listCalls).toBe(0);
    expect(w.tuf.fetchCalls).toEqual([]);
    expect(existsSync(path.join(w.stateDir, UPDATE_STATE_FILE))).toBe(false);
    expect(await w.updater.check()).toEqual({ ok: false, state: "not_configured", message: "updates are not configured in this build" });
    expect(await w.updater.install("1.1.0", true)).toMatchObject({ ok: false });
    expect(w.tuf.fetchCalls).toEqual([]);
  });

  it("Homebrew means no call either", async () => {
    const w = updateWorld({ over: { execPath: "/opt/homebrew/Cellar/fx-runner/1.0.0/bin/fx-runner" } });
    const auto = createAutoUpdate({ updater: w.updater, hasLease: () => false, now: () => w.clock.now });
    expect(await auto.tick()).toEqual({ kind: "none" });
    expect(w.tuf.listCalls).toBe(0);
  });
});
