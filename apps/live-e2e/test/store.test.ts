import { createCipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { decryptRoles, encryptRoles, parseKey, putRole, readStore, removeRole, roleAllowedOn, StoreError, storePath, updateStore, withLock } from "../src/store.js";
import { signSession } from "./session-helpers.js";
import { tmpDir } from "./helpers.js";

const key = randomBytes(32);
const cookie = (sid: string) => signSession({ sid, sessionStart: 1_000, lastSeenAt: 2_000 });
const fileIn = (home: string) => storePath(home, "staging");

describe("store: encryption", () => {
  it("round-trips roles, and the file holds neither a cookie nor a role name in the clear", () => {
    const roles = { owner: cookie("a"), member: cookie("b") };
    const text = encryptRoles(roles, "staging", key);
    expect(decryptRoles(text, "staging", key)).toEqual(roles);
    expect(text).not.toContain(roles.owner.split(".")[1] as string);
    expect(text).not.toContain("owner");
  });

  it("fails with a wrong key, an edited byte, or a file made for another target", () => {
    const text = encryptRoles({ owner: cookie("a") }, "staging", key);
    expect(() => decryptRoles(text, "staging", randomBytes(32))).toThrow(StoreError);
    expect(() => decryptRoles(text, "production", key)).toThrow(StoreError);
    const f = JSON.parse(text) as { ct: string };
    const ct = Buffer.from(f.ct, "base64");
    ct[0] = (ct[0] as number) ^ 1;
    expect(() => decryptRoles(JSON.stringify({ ...f, ct: ct.toString("base64") }), "staging", key)).toThrow("cannot be decrypted");
  });

  it("uses a fresh IV for every write (the same roles never give the same bytes)", () => {
    const roles = { owner: cookie("a") };
    expect(encryptRoles(roles, "staging", key)).not.toBe(encryptRoles(roles, "staging", key));
  });

  it("stores only a role name and a session token: anything else is refused before it is written", () => {
    expect(() => encryptRoles({ owner: "not-a-jwt" }, "staging", key)).toThrow("not a session token");
    expect(() => encryptRoles({ admin: cookie("a") }, "staging", key)).toThrow("not a role");
    expect(() => encryptRoles({ owner: `${cookie("a")}; github=1` }, "staging", key)).toThrow(StoreError);
  });

  it("accepts only a 32-byte base64 key, and never echoes it", () => {
    expect(parseKey(key.toString("base64"))).toEqual(key);
    for (const bad of [undefined, "", "short", randomBytes(16).toString("base64"), `${key.toString("base64")}x`]) {
      expect(() => parseKey(bad)).toThrow(StoreError);
    }
    expect(() => parseKey("not-the-key-value-1234")).not.toThrow(/not-the-key/);
  });
});

describe("store: the file", () => {
  it("is written 0600 in a 0700 folder, by rename (no temp file is left), and read back", async () => {
    const home = tmpDir();
    const file = fileIn(home);
    await putRole(file, "staging", key, "owner", cookie("a"));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(file)).mode & 0o077).toBe(0);
    expect(readdirSync(dirname(file))).toEqual(["sessions-staging.enc"]);
    expect(readStore(file, "staging", key)).toEqual({ owner: cookie("a") });
  });

  it("a missing file is an empty store", () => {
    expect(readStore(fileIn(tmpDir()), "staging", key)).toEqual({});
  });

  it("refuses a file other users can read, a symbolic link and a directory", async () => {
    const home = tmpDir();
    const file = fileIn(home);
    await putRole(file, "staging", key, "owner", cookie("a"));
    chmodSync(file, 0o640);
    expect(() => readStore(file, "staging", key)).toThrow("accessible to group or others");
    chmodSync(file, 0o600);
    const link = join(dirname(file), "link.enc");
    symlinkSync(file, link);
    expect(() => readStore(link, "staging", key)).toThrow("symbolic link");
    mkdirSync(join(dirname(file), "dir.enc"));
    expect(() => readStore(join(dirname(file), "dir.enc"), "staging", key)).toThrow(StoreError);
  });

  it("two writers at once lose neither update (the write-back of parallel workers)", async () => {
    const file = fileIn(tmpDir());
    await Promise.all([putRole(file, "staging", key, "owner", cookie("a")), putRole(file, "staging", key, "member", cookie("b")), putRole(file, "staging", key, "revoke", cookie("c"))]);
    expect(Object.keys(readStore(file, "staging", key)).sort()).toEqual(["member", "owner", "revoke"]);
  });

  it("a lock left by a crashed writer does not block later writes once it is stale", async () => {
    const file = fileIn(tmpDir());
    mkdirSync(`${file}.lock`, { recursive: true });
    const old = new Date(Date.now() - 120_000);
    utimesSync(`${file}.lock`, old, old);
    await putRole(file, "staging", key, "owner", cookie("a"));
    expect(Object.keys(readStore(file, "staging", key))).toEqual(["owner"]);
  });

  it("removeRole is the undo of a capture; the other roles stay", async () => {
    const file = fileIn(tmpDir());
    await putRole(file, "staging", key, "owner", cookie("a"));
    await putRole(file, "staging", key, "revoke", cookie("b"));
    expect(await removeRole(file, "staging", key, "revoke")).toEqual({ owner: cookie("a") });
    expect(readStore(file, "staging", key)).toEqual({ owner: cookie("a") });
  });

  it("a failed update leaves the old file intact", async () => {
    const file = fileIn(tmpDir());
    await putRole(file, "staging", key, "owner", cookie("a"));
    const before = readFileSync(file, "utf8");
    await expect(updateStore(file, "staging", key, () => ({ owner: "garbage" }))).rejects.toThrow(StoreError);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(readdirSync(dirname(file))).toEqual(["sessions-staging.enc"]);
  });

  it("a corrupt file is an error, not an empty store (an overwrite would drop every other role)", () => {
    const file = fileIn(tmpDir());
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "{not json", { mode: 0o600 });
    expect(() => readStore(file, "staging", key)).toThrow("cannot be decrypted");
  });

  it("refuses a relative HOME and a target that is not a plain name", () => {
    expect(() => storePath("relative", "staging")).toThrow(StoreError);
    expect(() => storePath("/home/x", "../etc")).toThrow(StoreError);
  });
});

describe("store: roles per target", () => {
  it("the production canary is the only role on production, and never on staging", () => {
    expect(roleAllowedOn("canary", "production")).toBe(true);
    for (const r of ["owner", "member", "outsider", "revoke"] as const) {
      expect(roleAllowedOn(r, "production")).toBe(false);
      expect(roleAllowedOn(r, "staging")).toBe(true);
    }
    expect(roleAllowedOn("canary", "staging")).toBe(false);
  });

  it("holds for the store itself: encrypt, put, update and decrypt all refuse a role the target does not use", async () => {
    expect(() => encryptRoles({ owner: cookie("a") }, "production", key)).toThrow("owner role is not used on production");
    expect(() => encryptRoles({ canary: cookie("a") }, "staging", key)).toThrow("canary role is not used on staging");
    const file = storePath(tmpDir(), "production");
    await expect(putRole(file, "production", key, "owner", cookie("a"))).rejects.toThrow("not used on production");
    await expect(updateStore(file, "production", key, () => ({ member: cookie("a") }))).rejects.toThrow(StoreError);
    expect(readdirSync(dirname(file))).toEqual([]);
    await putRole(file, "production", key, "canary", cookie("c"));
    expect(readStore(file, "production", key)).toEqual({ canary: cookie("c") });
    // A blob made elsewhere with the right key and target but a role that does not belong is refused on read too.
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from("live-e2e-sessions:v1:production"));
    const ct = Buffer.concat([cipher.update(JSON.stringify({ version: 1, roles: { owner: cookie("o") } }), "utf8"), cipher.final()]);
    const forged = JSON.stringify({ version: 1, alg: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ct: ct.toString("base64") });
    expect(() => decryptRoles(forged, "production", key)).toThrow("owner role is not used on production");
  });
});

describe("store: the lock", () => {
  it("a lock that is released between the failed mkdir and the look at it is retried, not an error", async () => {
    const file = fileIn(tmpDir());
    mkdirSync(`${file}.lock`, { recursive: true });
    let calls = 0;
    const got = await withLock(file, () => "done", {
      afterContended: () => {
        calls += 1;
        rmSync(`${file}.lock`, { recursive: true, force: true });
      },
    });
    expect(got).toBe("done");
    expect(calls).toBe(1);
  });

  it("many waiters finding the same stale lock all get their turn, and none deletes another's fresh lock", async () => {
    const file = fileIn(tmpDir());
    mkdirSync(`${file}.lock`, { recursive: true });
    const old = new Date(Date.now() - 120_000);
    utimesSync(`${file}.lock`, old, old);
    let inside = 0;
    let overlap = 0;
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        withLock(file, () => {
          inside += 1;
          overlap = Math.max(overlap, inside);
          // The body is synchronous, so mutual exclusion is shown by the lock folder being ours while it runs.
          expect(existsSync(`${file}.lock`), `waiter ${i}`).toBe(true);
          inside -= 1;
        }),
      ),
    );
    expect(overlap).toBe(1);
    expect(readdirSync(dirname(file)).sort()).toEqual([]);
  });

  it("refuses a lock path that is a symbolic link, and a store folder that is one, instead of waiting on it or writing through it", async () => {
    const file = fileIn(tmpDir());
    mkdirSync(dirname(file), { recursive: true });
    const elsewhere = tmpDir();
    symlinkSync(elsewhere, `${file}.lock`);
    await expect(putRole(file, "staging", key, "owner", cookie("a"))).rejects.toThrow("symbolic link");
    rmSync(`${file}.lock`);
    const home = tmpDir();
    const linked = storePath(home, "staging");
    mkdirSync(dirname(dirname(linked)), { recursive: true });
    symlinkSync(elsewhere, dirname(linked));
    await expect(putRole(linked, "staging", key, "owner", cookie("a"))).rejects.toThrow("folder is a link");
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("a symbolic link at any level of the store's path (.local, .local/state, live-e2e) is refused and its target is left alone", async () => {
    for (const level of [1, 2, 3]) {
      const home = tmpDir();
      const victim = tmpDir();
      writeFileSync(join(victim, "keep"), "x");
      chmodSync(victim, 0o755);
      const file = storePath(home, "staging");
      // Real folders above the link, the link at `level` (1 = .local, 2 = .local/state, 3 = live-e2e).
      const parts = [join(home, ".local"), join(home, ".local", "state"), join(home, ".local", "state", "live-e2e")];
      for (const real of parts.slice(0, level - 1)) mkdirSync(real);
      symlinkSync(victim, parts[level - 1] as string);
      await expect(putRole(file, "staging", key, "owner", cookie("a")), `level ${level}`).rejects.toThrow("link or not a directory");
      expect(readdirSync(victim)).toEqual(["keep"]);
      expect(statSync(victim).mode & 0o777).toBe(0o755);
    }
  });

  it("the reclaim guard: a stale lock swapped for a fresh one after the guard is taken survives, and its holder's write is kept", async () => {
    const file = fileIn(tmpDir());
    const dir = dirname(file);
    mkdirSync(`${file}.lock`, { recursive: true });
    const old = new Date(Date.now() - 120_000);
    utimesSync(`${file}.lock`, old, old);
    let holderDone = false;
    let swapped = 0;
    const holderRole = "member" as const;
    let sawHolderBeforeUs: boolean | undefined;
    let sawHolderBeforeContender: boolean | undefined;
    let guardHeld: boolean | undefined;
    let contender: Promise<unknown> | undefined;
    const waiter = updateStore(
      file,
      "staging",
      key,
      (roles) => {
        sawHolderBeforeUs = holderDone && holderRole in roles;
        return { ...roles, owner: cookie("w") };
      },
      {
        afterGuard: () => {
          swapped += 1;
          // While this waiter re-checks, the guard folder is what keeps every other reclaimer out ...
          guardHeld = existsSync(`${file}.lock.reclaim`);
          // ... so a second waiter that finds the same stale lock right now must wait, not reclaim it and take the lock.
          contender = updateStore(file, "staging", key, (roles) => {
            sawHolderBeforeContender = holderDone && holderRole in roles;
            return { ...roles, outsider: cookie("c") };
          });
          // Another process reclaims the same stale lock first and takes it: a fresh lock, held for a short while.
          rmSync(`${file}.lock`, { recursive: true, force: true });
          mkdirSync(`${file}.lock`);
          setTimeout(() => {
            writeFileSync(file, encryptRoles({ [holderRole]: cookie("h") }, "staging", key), { mode: 0o600 });
            holderDone = true;
            rmSync(`${file}.lock`, { recursive: true, force: true });
          }, 80);
        },
      },
    );
    await waiter;
    await contender;
    expect(swapped).toBe(1);
    expect(guardHeld).toBe(true);
    expect(sawHolderBeforeUs).toBe(true); // we did not delete the fresh lock: we waited for its holder
    expect(sawHolderBeforeContender).toBe(true); // nor did the second waiter reclaim while the guard was held
    expect(Object.keys(readStore(file, "staging", key)).sort()).toEqual(["member", "outsider", "owner"]);
    expect(readdirSync(dir)).toEqual(["sessions-staging.enc"]);
  });

  it("a reclaim guard left by a crashed waiter does not block later writes either", async () => {
    const file = fileIn(tmpDir());
    const old = new Date(Date.now() - 120_000);
    mkdirSync(`${file}.lock`, { recursive: true });
    mkdirSync(`${file}.lock.reclaim`, { recursive: true });
    utimesSync(`${file}.lock`, old, old);
    utimesSync(`${file}.lock.reclaim`, old, old);
    await putRole(file, "staging", key, "owner", cookie("a"));
    expect(Object.keys(readStore(file, "staging", key))).toEqual(["owner"]);
    expect(readdirSync(dirname(file))).toEqual(["sessions-staging.enc"]);
  });
});
