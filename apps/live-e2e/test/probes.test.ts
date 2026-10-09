// Refusal probes: the pack.json schema and how an answer is judged.
import { describe, expect, it } from "vitest";
import type { ApiClient } from "../src/client.js";
import { ManifestError, validatePack } from "../src/manifest.js";
import { expectedStatuses, probeErrors, runProbe, type Probe } from "../src/probes.js";
import { makePack } from "./helpers.js";

function packWith(probes: unknown): unknown {
  return { ...makePack({ id: "demo" }), probes };
}

function manifestErrors(probes: unknown): string[] {
  try {
    validatePack(packWith(probes), "demo");
    return [];
  } catch (err) {
    if (err instanceof ManifestError) return err.errors;
    throw err;
  }
}

describe("probe schema", () => {
  it("accepts { method, path, expect } with one 4xx status or a list of them", () => {
    expect(manifestErrors([{ method: "POST", path: "/api/csp-report", expect: 415 }])).toEqual([]);
    expect(manifestErrors([{ method: "GET", path: "/api/cron/x?y=1", expect: [401, 403] }])).toEqual([]);
    expect(manifestErrors([])).toEqual([]);
  });

  it("refuses a probe that expects 2xx or 3xx, naming the pack", () => {
    for (const expect_ of [200, 204, 302, 399, 500, [401, 200], [], "401", 401.5]) {
      const errors = manifestErrors([{ method: "POST", path: "/x", expect: expect_ }]);
      expect(errors.length, JSON.stringify(expect_)).toBeGreaterThan(0);
      expect(errors.every((e) => e.startsWith("pack demo:")), JSON.stringify(expect_)).toBe(true);
    }
  });

  it("refuses an absolute URL or an origin in the path, naming the pack", () => {
    for (const path of ["https://app.example.test/x", "http://127.0.0.1/x", "//app.example.test/x", "app.example.test/x", "x", "", "/a b", "/a\\b", "/x#frag"]) {
      const errors = manifestErrors([{ method: "GET", path, expect: 401 }]);
      expect(errors.length, path).toBeGreaterThan(0);
      expect(errors[0], path).toContain("pack demo:");
    }
  });

  it("refuses unknown keys, missing keys, lower-case or unknown methods and non-objects", () => {
    expect(manifestErrors([{ method: "POST", path: "/x", expect: 401, headers: {} }]).join("\n")).toContain('unknown key "headers"');
    expect(manifestErrors([{ method: "POST", path: "/x" }]).join("\n")).toContain('missing "expect"');
    expect(manifestErrors([{ method: "post", path: "/x", expect: 401 }]).join("\n")).toContain('"method"');
    expect(manifestErrors([{ method: "TRACE", path: "/x", expect: 401 }]).join("\n")).toContain('"method"');
    expect(manifestErrors(["POST /x"]).join("\n")).toContain("must be an object");
    expect(manifestErrors("none").join("\n")).toContain('"probes" must be a list');
  });

  it("probeErrors and expectedStatuses agree on the shapes", () => {
    expect(probeErrors([{ method: "GET", path: "/x", expect: 404 }], "demo")).toEqual([]);
    expect(expectedStatuses({ expect: 404 })).toEqual([404]);
    expect(expectedStatuses({ expect: [401, 403] })).toEqual([401, 403]);
  });
});

describe("judging an answer", () => {
  const probe: Probe = { method: "POST", path: "/api/internal/kick", expect: [401, 403] };
  const answering = (status: number): ApiClient => ({ probe: async () => ({ status }) }) as unknown as ApiClient;

  it("is refused only when the status is one of the expected 4xx: 200 and 302 are red", async () => {
    for (const [status, refused] of [[200, false], [204, false], [302, false], [500, false], [404, false], [401, true], [403, true]] as const) {
      expect(await runProbe(answering(status), probe), String(status)).toEqual({ probe, status, refused });
    }
  });

  it("passes for each of 401, 403, 404, 405, 413 and 415 when the pack expects it", async () => {
    for (const status of [401, 403, 404, 405, 413, 415]) {
      const p: Probe = { ...probe, expect: status };
      expect((await runProbe(answering(status), p)).refused, String(status)).toBe(true);
    }
  });
});
