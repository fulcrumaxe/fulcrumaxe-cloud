import { existsSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { updatesLine } from "../../src/commands/update.js";
import { loadUpdateState } from "../../src/update/versions.js";
import { program, updateWorld } from "../helpers/updateWorld.js";

const T = (v: string): string => `v${v}/fx-runner-linux-x64`;

describe("taking over a stale lock never deletes a fresh one", () => {
  it("a lock that looked stale but was a fresh one when it was moved aside is put back, and the update says busy", async () => {
    const w = updateWorld();
    w.tuf.add(T("1.1.0"), program("1.1.0"));
    const lock = path.join(w.stateDir, "update.lock");
    writeFileSync(lock, "");
    const old = new Date(w.clock.now.getTime() - 3_600_000);
    utimesSync(lock, old, old);
    // The first look sees a stale lock. By the time it is moved aside and looked at again, what was moved is another process's fresh lock.
    let calls = 0;
    const updater = w.updaterWith(
      {},
      {
        now: () => {
          calls++;
          if (calls >= 2) {
            const aside = readdirSync(w.stateDir).find((n) => n.startsWith("update.lock.stale-"));
            if (aside !== undefined) utimesSync(path.join(w.stateDir, aside), w.clock.now, w.clock.now);
          }
          return w.clock.now;
        },
      },
    );
    expect(await updater.applyLatest()).toMatchObject({ ok: false, code: "busy" });
    expect(existsSync(lock)).toBe(true);
    expect(readdirSync(w.stateDir).filter((n) => n.startsWith("update.lock.stale-"))).toEqual([]);
    expect(w.tuf.fetchCalls).toEqual([]);
  });

  it("a stale lock is still taken over and leaves nothing behind", async () => {
    const w = updateWorld();
    w.tuf.add(T("1.1.0"), program("1.1.0"));
    const lock = path.join(w.stateDir, "update.lock");
    writeFileSync(lock, "");
    const old = new Date(w.clock.now.getTime() - 3_600_000);
    utimesSync(lock, old, old);
    expect(await w.updater.applyLatest()).toMatchObject({ ok: true, version: "1.1.0" });
    expect(readdirSync(w.stateDir).filter((n) => n.startsWith("update.lock"))).toEqual([]);
  });
});

describe("a failed check is not a pause", () => {
  it("a refusal from the release client is shown as 'update check failed', and an expired timestamp as 'updates paused'", async () => {
    const w = updateWorld();
    w.tuf.listOutcome = { ok: false, state: "refused", code: "download_failed", message: "could not reach the release server" };
    expect(await w.updater.check()).toMatchObject({ ok: false, state: "refused" });
    const failed = loadUpdateState(w.stateDir);
    expect(failed.paused).toBeUndefined();
    expect(failed.checkFailed).toBe("could not reach the release server");
    const line = updatesLine(w.stateDir, { version: "1.0.0" }, true);
    expect(line.detail).toContain("update check failed: could not reach the release server");
    expect(line.detail).not.toContain("paused");
    expect(line.level).toBe("WARN");

    w.tuf.listOutcome = { ok: false, state: "paused", code: "metadata_expired", expiredOn: "2026-10-01", message: "updates paused: release metadata expired on 2026-10-01" };
    await w.updater.check();
    expect(loadUpdateState(w.stateDir).checkFailed).toBeUndefined();
    expect(updatesLine(w.stateDir, { version: "1.0.0" }, true).detail).toContain("updates paused: release metadata expired on 2026-10-01");

    w.tuf.listOutcome = undefined;
    await w.updater.check();
    const ok = loadUpdateState(w.stateDir);
    expect(ok.paused).toBeUndefined();
    expect(ok.checkFailed).toBeUndefined();
    expect(updatesLine(w.stateDir, { version: "1.0.0" }, true).level).toBe("PASS");
  });
});
