import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * H7b: the storage namespace and opaque user id sit on FX_STABLE_ID_SECRET, so
 * rotating the session secret changes neither. The module keeps a "logged
 * once" flag, so each test loads a fresh copy.
 */
const STABLE = "t".repeat(40);
const SESSION_A = "a".repeat(32);
const SESSION_B = "b".repeat(32);

async function load() {
  vi.resetModules();
  return import("../lib/shell/storage-ns");
}
const e = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

describe("storage namespace and opaque user id (H7b)", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it("stay identical across a session secret rotation when FX_STABLE_ID_SECRET is set", async () => {
    const { storageNamespace, opaqueUserId } = await load();
    const before = e({ FX_STABLE_ID_SECRET: STABLE, FX_SESSION_SECRET: SESSION_A });
    const after = e({ FX_STABLE_ID_SECRET: STABLE, FX_SESSION_SECRET: SESSION_B });
    expect(storageNamespace("acct-1", after)).toBe(storageNamespace("acct-1", before));
    expect(opaqueUserId("user-1", after)).toBe(opaqueUserId("user-1", before));
    expect(warn).not.toHaveBeenCalled();
  });

  it("with the secret set to the current session secret's value, nothing changes from the fallback era (the migration step)", async () => {
    const { storageNamespace, opaqueUserId } = await load();
    const fallback = e({ FX_SESSION_SECRET: SESSION_A });
    const pinned = e({ FX_STABLE_ID_SECRET: SESSION_A, FX_SESSION_SECRET: SESSION_B });
    expect(storageNamespace("acct-1", pinned)).toBe(storageNamespace("acct-1", fallback));
    expect(opaqueUserId("user-1", pinned)).toBe(opaqueUserId("user-1", fallback));
  });

  it("still separates accounts, users and the two derivations", async () => {
    const { storageNamespace, opaqueUserId } = await load();
    const env = e({ FX_STABLE_ID_SECRET: STABLE, FX_SESSION_SECRET: SESSION_A });
    expect(storageNamespace("acct-1", env)).not.toBe(storageNamespace("acct-2", env));
    expect(opaqueUserId("user-1", env)).not.toBe(opaqueUserId("user-2", env));
    expect(storageNamespace("same", env)).not.toBe(opaqueUserId("same", env));
  });

  it("without it, falls back to FX_SESSION_SECRET and logs once per process, never the value", async () => {
    const { storageNamespace, opaqueUserId } = await load();
    const env = e({ FX_SESSION_SECRET: SESSION_A });
    storageNamespace("acct-1", env);
    opaqueUserId("user-1", env);
    storageNamespace("acct-2", e({ FX_STABLE_ID_SECRET: "  ", FX_SESSION_SECRET: SESSION_A }));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("FX_STABLE_ID_SECRET");
    expect(String(warn.mock.calls[0]?.[0])).not.toContain(SESSION_A);
  });

  it("without the fallback, rotating the session secret does change them (why the setting exists)", async () => {
    const { storageNamespace, opaqueUserId } = await load();
    expect(storageNamespace("acct-1", e({ FX_SESSION_SECRET: SESSION_B }))).not.toBe(storageNamespace("acct-1", e({ FX_SESSION_SECRET: SESSION_A })));
    expect(opaqueUserId("user-1", e({ FX_SESSION_SECRET: SESSION_B }))).not.toBe(opaqueUserId("user-1", e({ FX_SESSION_SECRET: SESSION_A })));
  });

  it("throws on a set but short stable-id secret rather than falling back quietly, and on no secret at all", async () => {
    const { storageNamespace } = await load();
    expect(() => storageNamespace("acct-1", e({ FX_STABLE_ID_SECRET: "short", FX_SESSION_SECRET: SESSION_A }))).toThrow(/FX_STABLE_ID_SECRET/);
    expect(() => storageNamespace("acct-1", e({}))).toThrow(/FX_SESSION_SECRET/);
    expect(warn).not.toHaveBeenCalled();
  });
});
