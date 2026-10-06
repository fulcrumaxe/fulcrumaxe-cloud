import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { MISE_ALLOWED_BACKENDS, MISE_KNOWN_BACKENDS, MISE_REFUSED_BACKENDS, miseConfigText } from "../src/index.js";

describe("mise backends (M-B5): everything not allowed is disabled", () => {
  it("disables every known backend except the allowed ones, plus the legacy pipx name", () => {
    const refused = new Set(MISE_REFUSED_BACKENDS);
    for (const b of MISE_KNOWN_BACKENDS) expect(refused.has(b), b).toBe(!MISE_ALLOWED_BACKENDS.includes(b));
    expect(refused.has("pipx")).toBe(true);
    expect(MISE_KNOWN_BACKENDS).toHaveLength(20);
    expect(MISE_REFUSED_BACKENDS).toHaveLength(MISE_KNOWN_BACKENDS.length - MISE_ALLOWED_BACKENDS.length + 1);
  });
  it("keeps only core allowed, and the generated config disables the rest", () => {
    expect(MISE_ALLOWED_BACKENDS).toEqual(["core"]);
    const line = miseConfigText([["node", "20"]]).split("\n").find((l) => l.startsWith("disable_backends"))!;
    const listed = [...line.matchAll(/"([a-z0-9]+)"/g)].map((m) => m[1]);
    expect(listed).toEqual([...MISE_REFUSED_BACKENDS]);
    for (const b of ["aqua", "asdf", "vfox", "github", "gitlab", "forgejo", "packslip", "spinel", "pypi"]) expect(listed).toContain(b);
    expect(listed).not.toContain("core");
  });
  // Set FX_MISE_BIN to the pinned mise binary (named `mise`) to compare against its own list. A mise bump that adds a
  // backend then fails here until MISE_KNOWN_BACKENDS and the allowed list are updated on purpose.
  const bin = process.env.FX_MISE_BIN;
  it.skipIf(bin === undefined || bin === "")("matches `mise backends ls` of the pinned binary", () => {
    const r = spawnSync(bin!, ["backends", "ls"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: "/tmp", MISE_YES: "1" } });
    expect(r.status).toBe(0);
    const live = r.stdout.split("\n").map((l) => l.trim()).filter(Boolean).sort();
    expect(live).toEqual([...MISE_KNOWN_BACKENDS].sort());
  });
});
