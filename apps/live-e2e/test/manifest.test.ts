import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isKnownNeed, loadPacks, ManifestError, validatePack } from "../src/manifest.js";
import { makePack, PACKAGE_ROOT, scratchRoot, tmpDir } from "./helpers.js";

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("expected a throw");
}

describe("manifest: the shipped packs", () => {
  it("loads platform and auth-negative, both smoke, both requiring bypass", () => {
    const packs = loadPacks(join(PACKAGE_ROOT, "packs")).filter((p) => p.tier === "smoke");
    expect(packs.map((p) => p.id)).toEqual(["auth-negative", "platform"]);
    for (const p of packs) {
      expect(p.needs).toContain("bypass");
      expect(p.projects).toEqual(["desktop", "phone", "tablet"]);
    }
  });
});

describe("manifest: validation", () => {
  it("accepts a well-formed pack", () => {
    const pack = makePack({ id: "ok" });
    expect(validatePack(pack, "ok").id).toBe("ok");
  });

  it("accepts the three fresh-state names and rejects any other, naming the pack and the need", () => {
    for (const name of ["unpaid", "preview-unused", "first-sign-in"]) expect(isKnownNeed(`fresh-state:${name}`), name).toBe(true);
    expect(isKnownNeed("fresh-state:paid")).toBe(false);
    expect(isKnownNeed("fresh-state:")).toBe(false);
    const msg = messageOf(() => validatePack(makePack({ id: "p", needs: ["fresh-state:cancelled"] }), "p"));
    expect(msg).toContain("pack p");
    expect(msg).toContain('unknown need "fresh-state:cancelled"');
  });

  it("rejects an unknown key, naming the pack and the key", () => {
    const msg = messageOf(() => validatePack({ ...makePack({ id: "p" }), surprise: 1 }, "p"));
    expect(msg).toContain("pack p");
    expect(msg).toContain('unknown key "surprise"');
  });

  it("rejects an unknown key inside cost", () => {
    const pack = { ...makePack({ id: "p" }), cost: { class: "free", est_usd: 0, est_sandbox_min: 0, extra: 1 } };
    expect(messageOf(() => validatePack(pack, "p"))).toContain('unknown key "cost.extra"');
  });

  it("rejects a missing key", () => {
    const rest: Record<string, unknown> = { ...makePack({ id: "p" }) };
    delete rest.retry;
    expect(messageOf(() => validatePack(rest, "p"))).toContain('missing key "retry"');
  });

  it("rejects an unknown need, naming the pack and the need", () => {
    const msg = messageOf(() => validatePack(makePack({ id: "p", needs: ["bypass", "teleport"] }), "p"));
    expect(msg).toContain("pack p");
    expect(msg).toContain('unknown need "teleport"');
  });

  it("knows the whole closed needs vocabulary, including parameterised needs", () => {
    for (const n of ["bypass", "stripe-test", "host-capacity", "session:owner", "github-app:read", "fresh-state:unpaid", "api-token:read", "signin:scripted", "model-key", "test-repo", "caps-set", "sandbox", "webhook-sink"]) {
      expect(isKnownNeed(n), n).toBe(true);
    }
    for (const n of ["session", "session:", "sessions:owner", "", "Bypass", "bypass:x"]) {
      expect(isKnownNeed(n), n).toBe(false);
    }
  });

  it("rejects a sandbox pack that does not also declare session:owner and test-repo, naming each missing need (R-441-T3-21)", () => {
    const full = ["session:owner", "test-repo", "model-key", "caps-set", "sandbox"];
    expect(() => validatePack(makePack({ id: "p", needs: full }), "p")).not.toThrow();
    const noBoth = messageOf(() => validatePack(makePack({ id: "p", needs: ["model-key", "caps-set", "sandbox"] }), "p"));
    expect(noBoth).toContain('"session:owner"');
    expect(noBoth).toContain('"test-repo"');
    expect(messageOf(() => validatePack(makePack({ id: "p", needs: full.filter((n) => n !== "test-repo") }), "p"))).toContain('"test-repo"');
    expect(messageOf(() => validatePack(makePack({ id: "p", needs: full.filter((n) => n !== "session:owner") }), "p"))).toContain('"session:owner"');
    // Only a pack that declares `sandbox` is held to it.
    expect(() => validatePack(makePack({ id: "p", needs: ["caps-set"] }), "p")).not.toThrow();
  });

  it("rejects a @ui pack that does not list all three projects, naming what is missing", () => {
    const msg = messageOf(() => validatePack(makePack({ id: "p", tags: ["@ui"], projects: ["desktop", "phone"] }), "p"));
    expect(msg).toContain("tablet");
  });

  it("accepts an API-only pack on one project and a @ui pack on all three", () => {
    expect(() => validatePack(makePack({ id: "p", tags: ["@api"], projects: ["desktop"] }), "p")).not.toThrow();
    expect(() => validatePack(makePack({ id: "p", tags: ["@ui"], projects: ["desktop", "phone", "tablet"] }), "p")).not.toThrow();
  });

  it("rejects model_spend on any tier but full, accepts it on full", () => {
    for (const tier of ["smoke", "standard"] as const) {
      expect(messageOf(() => validatePack(makePack({ id: "p", tier, model_spend: true }), "p"))).toContain("model_spend");
    }
    expect(() => validatePack(makePack({ id: "p", tier: "full", model_spend: true }), "p")).not.toThrow();
  });

  it("rejects an id that differs from the folder, a bad tier, a tag without @, an empty target list", () => {
    expect(messageOf(() => validatePack(makePack({ id: "other" }), "p"))).toContain('"id" must equal the folder name');
    expect(messageOf(() => validatePack({ ...makePack({ id: "p" }), tier: "huge" }, "p"))).toContain('"tier"');
    expect(messageOf(() => validatePack({ ...makePack({ id: "p" }), tags: ["ui"] }, "p"))).toContain('"tags"');
    expect(messageOf(() => validatePack({ ...makePack({ id: "p" }), targets: [] }, "p"))).toContain('"targets"');
    expect(messageOf(() => validatePack({ ...makePack({ id: "p" }), targets: ["prod"] }, "p"))).toContain('"targets"');
  });

  it("reports every problem at once", () => {
    const msg = messageOf(() => validatePack({ ...makePack({ id: "p", needs: ["nope"] }), extra: true }, "p"));
    expect(msg).toContain("unknown key");
    expect(msg).toContain("unknown need");
  });

  it("rejects a non-object pack.json", () => {
    expect(messageOf(() => validatePack([], "p"))).toContain("must be a JSON object");
  });
});

describe("manifest: loading a directory", () => {
  it("reports one problem per pack across the directory, in a single ManifestError", () => {
    const root = scratchRoot([makePack({ id: "good" })]);
    mkdirSync(join(root, "packs", "bad-need"), { recursive: true });
    writeFileSync(join(root, "packs", "bad-need", "pack.json"), JSON.stringify(makePack({ id: "bad-need", needs: ["x-ray"] })));
    mkdirSync(join(root, "packs", "bad-json"), { recursive: true });
    writeFileSync(join(root, "packs", "bad-json", "pack.json"), "{ not json");
    let caught: unknown;
    try {
      loadPacks(join(root, "packs"));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ManifestError);
    const msg = (caught as ManifestError).message;
    expect(msg).toContain('pack bad-need: unknown need "x-ray"');
    expect(msg).toContain("pack bad-json: pack.json is not valid JSON");
    expect(msg).not.toContain("pack good");
  });

  it("ignores a folder with no pack.json and fails clearly on a missing packs directory", () => {
    const root = tmpDir();
    mkdirSync(join(root, "packs", "empty"), { recursive: true });
    expect(loadPacks(join(root, "packs"))).toEqual([]);
    expect(messageOf(() => loadPacks(join(root, "nowhere")))).toContain("packs directory not found");
  });
});
