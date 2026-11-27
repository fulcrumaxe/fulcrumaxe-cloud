import { describe, expect, it } from "vitest";
import { SETUP_INSTALL_LABELS, TWIN_SYNC_LABEL, localOnlyViolation } from "../src/localOnlyGithub.js";

/**
 * D#845 ON-27d3 (A26, A31): the twin sync pull request's one label. A26 also takes TWIN_SYNC_LABEL's row besides the engine's 11; A31 puts exactly that label on a pull request. Both are on a `setupInstall` client only.
 */
describe("A26 the twin sync label, A31 putting it on a pull request", () => {
  const make = (body: unknown, p = "/repos/acme/widgets/issues/12/labels", method = "POST") => ({ method, path: p, body });
  const label = { labels: ["fx-twin-sync"] };
  const row = { name: TWIN_SYNC_LABEL.name, color: TWIN_SYNC_LABEL.color, description: TWIN_SYNC_LABEL.description };

  it("creates the one extra label row and puts exactly that label on a numbered pull request", () => {
    expect(TWIN_SYNC_LABEL.name).toBe("fx-twin-sync");
    expect(TWIN_SYNC_LABEL.color).toMatch(/^[0-9A-F]{6}$/);
    expect([...TWIN_SYNC_LABEL.description].length).toBeLessThanOrEqual(100);
    expect(localOnlyViolation({ method: "POST", path: "/repos/acme/widgets/labels", body: row }, [], { setupInstall: true })).toBeNull();
    expect(localOnlyViolation(make(label), [], { setupInstall: true })).toBeNull();
    expect(SETUP_INSTALL_LABELS.some((l) => l.name === TWIN_SYNC_LABEL.name)).toBe(false);
  });

  it("refuses any other label, a second label, extra keys, another method or path, a query, and every client but setupInstall", () => {
    const bad = [{ labels: ["ci:full"] }, { labels: ["bug"] }, { labels: ["fx-twin-sync", "bug"] }, { labels: [] }, { labels: "fx-twin-sync" }, { labels: ["fx-twin-sync"], extra: 1 }, { label: "fx-twin-sync" }, ["fx-twin-sync"], null, undefined];
    for (const body of bad) expect(localOnlyViolation(make(body), [], { setupInstall: true }), JSON.stringify(body)).toBe("not_allowlisted");
    for (const method of ["GET", "PUT", "PATCH", "DELETE"]) expect(localOnlyViolation(make(label, undefined, method), [], { setupInstall: true }), method).toBe("not_allowlisted");
    for (const p of ["/repos/acme/widgets/issues/labels", "/repos/acme/widgets/issues/x/labels", "/repos/acme/widgets/issues/12/labels/fx-twin-sync", "/repos/acme/widgets/issues/12/labels?per_page=1", "/repos/../widgets/issues/12/labels"]) {
      expect(localOnlyViolation(make(label, p), [], { setupInstall: true }), p).toBe("not_allowlisted");
    }
    for (const options of [{}, { gate1Status: true }, { engineRemove: true }, { setupFinish: true }]) expect(localOnlyViolation(make(label), [], options), JSON.stringify(options)).toBe("not_allowlisted");
    for (const body of [{ ...row, color: "000000" }, { ...row, name: "fx-twin-sync2" }, { ...row, description: "x" }]) {
      expect(localOnlyViolation({ method: "POST", path: "/repos/acme/widgets/labels", body }, [], { setupInstall: true })).toBe("not_allowlisted");
    }
  });

  it("keeps the gate 1 attester's own label call to ci:full (A14), and gives that client nothing of A31", () => {
    expect(localOnlyViolation(make({ labels: ["ci:full"] }), [], { gate1Attest: true })).toBeNull();
    expect(localOnlyViolation(make(label), [], { gate1Attest: true })).toBe("not_allowlisted");
  });
});

/** D#845 ON-27d3 (A32): the verified sync commit's compare against its parent, for a renamed file's old path. A `setupInstall` client only; two bare 40-hex commit ids; no query, no body. */
describe("A32 the compare of two commits", () => {
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  const get = (path: string, extra: Record<string, unknown> = {}) => ({ method: "GET", path, ...extra });

  it("allows the compare of two 40-hex commit ids on a setupInstall client", () => {
    expect(localOnlyViolation(get(`/repos/acme/widgets/compare/${A}...${B}`), [], { setupInstall: true })).toBeNull();
  });

  it("refuses every other shape: a branch or a short or long id, a two-dot or three-segment range, a query, a body, another method, another path, and every client but setupInstall", () => {
    const paths = [
      `/repos/acme/widgets/compare/main...${B}`,
      `/repos/acme/widgets/compare/${A}...main`,
      `/repos/acme/widgets/compare/${"a".repeat(39)}...${B}`,
      `/repos/acme/widgets/compare/${"a".repeat(64)}...${"b".repeat(64)}`,
      `/repos/acme/widgets/compare/${A}..${B}`,
      `/repos/acme/widgets/compare/${A}....${B}`,
      `/repos/acme/widgets/compare/${A}...${B}...${A}`,
      `/repos/acme/widgets/compare/${A}...${B}.diff`,
      `/repos/acme/widgets/compare/${A}...${B}/files`,
      `/repos/acme/widgets/compare/${A}...${B}?per_page=1`,
      `/repos/acme/widgets/pulls/compare/${A}...${B}`,
      `/repos/../widgets/compare/${A}...${B}`,
    ];
    for (const p of paths) expect(localOnlyViolation(get(p), [], { setupInstall: true }), p).toBe("not_allowlisted");
    const ok = `/repos/acme/widgets/compare/${A}...${B}`;
    expect(localOnlyViolation(get(ok, { query: { per_page: 1 } }), [], { setupInstall: true })).toBe("not_allowlisted");
    expect(localOnlyViolation(get(ok, { body: {} }), [], { setupInstall: true })).toBe("not_allowlisted");
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) expect(localOnlyViolation({ method, path: ok, body: {} }, [], { setupInstall: true }), method).toBe("not_allowlisted");
    for (const options of [{}, { gate1Attest: true }, { gate1Status: true }, { engineRemove: true }, { setupFinish: true }]) expect(localOnlyViolation(get(ok), [], options), JSON.stringify(options)).toBe("not_allowlisted");
  });
});
