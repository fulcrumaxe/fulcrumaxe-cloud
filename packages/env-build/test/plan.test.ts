import { PRESETS, PRESET_IDS } from "@fx/env-presets";
import { envVersionId, type EnvSpec } from "@fx/env-spec";
import { describe, expect, it } from "vitest";
import { EnvBuildError, plan, type PlanOptions } from "../src/index.js";

const spec = (over: Record<string, unknown> = {}): EnvSpec =>
  ({ version: 1, setup: [], run: [], env: {}, secrets: [], services: [], network: { domains: [] }, ...over }) as unknown as EnvSpec;
const base = (id: string) => PRESETS.find((p) => p.id === id)!.base;
const A: PlanOptions = { accountId: "acct-1" };
const P = (id: string, over: Record<string, unknown> = {}, opts: PlanOptions = A) => plan(spec({ preset: id, ...over }), base(id), opts);
const code = (fn: () => unknown): string => {
  try { fn(); } catch (e) { if (e instanceof EnvBuildError) return e.code; throw e; }
  return "none";
};
const lines = (d: string) => d.split("\n");

describe("criterion 1: plan shape and determinism", () => {
  it("is byte-identical for identical inputs and uses the digest part for the version id", () => {
    const a = P("node", { run: [["npm", "test"]] });
    const b = P("node", { run: [["npm", "test"]] });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const digest = base("node").slice(base("node").lastIndexOf("@") + 1);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a.envVersionId).toBe(envVersionId(spec({ preset: "node", run: [["npm", "test"]] }), digest));
    expect(a.tags).toEqual([`fx-env-acct-1:${a.envVersionId}`]);
  });
});

describe("criterion 2: no ENTRYPOINT or CMD", () => {
  it.each(PRESET_IDS)("%s, even with a run command", (id) => {
    const d = P(id, { run: [["npm", "start"]], services: ["postgres"] }).dockerfile;
    expect(d).not.toMatch(/^\s*(ENTRYPOINT|CMD)\b/im);
  });
});

describe("criterion 3: image-reference refusal and tenant-scoped repository", () => {
  const hostile = ["ubuntu:22.04", "evil.io/x/y", "docker.io", "ghcr.io/a/b:1", "a/b@sha256:" + "a".repeat(64)];
  it.each(hostile)("refuses %s in preset, dockerfile and services", (v) => {
    expect(code(() => plan(spec({ preset: v }), base("node"), A))).toBe("image_reference");
    expect(code(() => plan(spec({ dockerfile: v }), base("node"), A))).toBe("image_reference");
    expect(code(() => plan(spec({ preset: "node", services: [v] }), base("node"), A))).toBe("image_reference");
  });
  it("does not refuse image-like env values or argv", () => {
    const r = P("node", { env: { DB: "db:5432", URL: "registry.io/x:1" }, run: [["npm", "run", "lint:fix"]], setup: [["echo", "ubuntu:22.04"]] });
    expect(r.dockerfile).toContain("FROM");
  });
  it("derives the repository from accountId only", () => {
    const h1 = P("node", { env: { A: "one" }, run: [["a"]], services: ["redis"] }, { accountId: "acct-1" });
    const h2 = P("python", { env: { Z: "two:1" }, setup: [["b"]], secrets: [{ name: "X", kind: "in_sandbox" }] }, { accountId: "acct-1" });
    const h3 = P("node", { env: { A: "one" } }, { accountId: "acct-2" });
    const repo = (t: string) => t.split(":")[0];
    expect(repo(h1.tags[0]!)).toBe(repo(h2.tags[0]!));
    expect(repo(h1.tags[0]!)).not.toBe(repo(h3.tags[0]!));
  });
  it("rejects an accountId that could escape the repository namespace", () => {
    for (const a of ["", "A", "a/b", "a:b", "-a", "a b"]) expect(code(() => P("node", {}, { accountId: a }))).toBe("invalid_account_id");
  });
});

describe("criterion 4: base reference must be a digest", () => {
  it("refuses a tag-only reference and one without @sha256:", () => {
    for (const ref of ["docker.io/library/ubuntu:26.04", "docker.io/library/ubuntu", "docker.io/library/ubuntu@sha256:abc", "@sha256:" + "a".repeat(64), ""]) {
      expect(code(() => plan(spec({ preset: "node" }), ref, A)), ref).toBe("base_not_pinned");
    }
  });
});

describe("criterion 5: layer split", () => {
  const nodePkg = PRESETS.find((p) => p.id === "node")!.layers[1]!.aptPackages[0]!;
  it("splits a 700 MB hinted layer into two layers of at most 500 MB", () => {
    const r = P("cpp", {}, { accountId: "a", sizeHints: { "g++=4:15.2.*": 350, "build-essential=12.12ubuntu*": 350 } });
    const parts = r.layers.filter((l) => l.id.startsWith("gcc-15-"));
    expect(parts.map((l) => l.aptPackages)).toEqual([["g++=4:15.2.*"], ["build-essential=12.12ubuntu*"]]);
    expect(r.dockerfile).toContain('"g++=4:15.2.*"');
    expect(r.dockerfile).toContain('"build-essential=12.12ubuntu*"');
  });
  it("keeps a layer whole when hints fit or are absent", () => {
    expect(P("node").layers.map((l) => l.id)).toEqual(["sandbox-base", "node-22"]);
    const r = P("node", {}, { accountId: "a", sizeHints: { [nodePkg]: 500 } });
    expect(r.layers.map((l) => l.id)).toEqual(["sandbox-base", "node-22"]);
  });
  it("puts a split layer's files and steps on its last part", () => {
    const r = P("node", {}, { accountId: "a", sizeHints: { "ca-certificates=2026*": 300, sudo: 400 } });
    const [a, b] = r.layers.filter((l) => l.id.startsWith("sandbox-base-"));
    expect([a!.files.length, a!.steps.length, b!.files.length > 0, b!.steps.length > 0]).toEqual([0, 0, true, true]);
  });
  it("refuses one package over 500 MB", () => {
    expect(code(() => P("node", {}, { accountId: "a", sizeHints: { [nodePkg]: 600 } }))).toBe("layer_too_large");
  });
  it("rejects a bad hint", () => {
    expect(code(() => P("node", {}, { accountId: "a", sizeHints: { x: -1 } }))).toBe("invalid_size_hint");
  });
});

describe("criterion 6: what goes in the image", () => {
  it("refuses a dockerfile source with a message that says it is coming", () => {
    let msg = "";
    try { plan(spec({ dockerfile: "ci/Dockerfile" }), base("node"), A); } catch (e) { msg = (e as EnvBuildError).message; }
    expect(msg).toMatch(/^dockerfile_source_not_planned: .*later task/);
  });
  it("bakes services but not setup or run", () => {
    const d = P("node", { services: ["postgres", "redis"], setup: [["npm", "ci"]], run: [["npm", "start"]] }).dockerfile;
    expect(d).toContain('"postgresql"');
    expect(d).toContain('"redis-server"');
    expect(d).not.toContain("npm");
  });
  it("refuses a base that is not the preset's base", () => {
    expect(code(() => plan(spec({ preset: "node" }), "docker.io/library/debian@sha256:" + "a".repeat(64), A))).toBe("base_mismatch");
  });
  it("requires a preset and knows only two services", () => {
    expect(code(() => plan(spec(), base("node"), A))).toBe("preset_required");
    expect(code(() => P("node", { services: ["mysql"] }))).toBe("unknown_service");
  });
});

describe("criterion 7: pins verbatim, exec-form RUN", () => {
  it.each(PRESETS.map((p) => [p.id, p] as const))("%s keeps every pin and renders argv as JSON arrays", (_id, p) => {
    const d = P(p.id).dockerfile;
    for (const l of p.layers) {
      for (const pkg of l.aptPackages) expect(d).toContain(JSON.stringify(pkg));
      for (const s of l.steps) expect(d).toContain(`RUN ${JSON.stringify(s)}`);
    }
    const runs = lines(d).filter((x) => x.startsWith("RUN "));
    expect(runs.length).toBeGreaterThan(4);
    for (const line of runs) expect(() => JSON.parse(line.slice(4))).not.toThrow();
    expect(runs.every((x) => x.startsWith("RUN ["))).toBe(true);
    expect(d).not.toMatch(/&&|\|\||\\$/m);
  });
});

describe("criterion 8: locale, shell, upgrade, in order", () => {
  it("sets LANG and SHELL, then upgrades, before the first preset layer", () => {
    const d = P("go").dockerfile;
    const at = (s: string) => d.indexOf(s);
    expect(at("ENV LANG=C.UTF-8")).toBeGreaterThan(at("FROM "));
    expect(at("ENV SHELL=/bin/bash")).toBeGreaterThan(at("ENV LANG=C.UTF-8"));
    expect(at('RUN ["apt-get","update"]')).toBeGreaterThan(at("ENV SHELL=/bin/bash"));
    expect(at('RUN ["apt-get","upgrade","-y"]')).toBeGreaterThan(at('RUN ["apt-get","update"]'));
    expect(at("# layer sandbox-base")).toBeGreaterThan(at('RUN ["apt-get","upgrade","-y"]'));
  });
});

describe("criterion 9: unknown preset ids", () => {
  it.each(["nix", "", "Node"])("refuses %j before anything else", (id) => {
    expect(code(() => plan(spec({ preset: id, dockerfile: "x", services: ["mysql"] }), "not-a-ref", { accountId: "BAD" }))).toBe("unknown_preset");
  });
});

/** The ENV keys a preset's own layers declare (rust sets rustup's homes and hosts); no spec value can add one. */
const declaredEnv = (id: string): string[] =>
  PRESETS.find((p) => p.id === id)!.layers.flatMap((l) => Object.keys(l.env ?? {}).map((k) => `ENV ${k}`));

describe("criterion 10: no credential material, no registry step", () => {
  it.each(PRESET_IDS)("%s plan", (id) => {
    const r = P(id, { secrets: [{ name: "VERCEL_TOKEN", kind: "in_sandbox" }], env: { OIDC_TOKEN: "x" }, services: ["redis"] });
    const d = r.dockerfile;
    expect(d).not.toMatch(/token|oidc|vercel_|vcr|secret|password|credential|docker\s+(login|push)|--mount/i);
    expect(lines(d).filter((x) => /^\s*ARG\b/.test(x))).toEqual(["ARG DEBIAN_FRONTEND=noninteractive"]);
    expect(lines(d).filter((x) => /^\s*ENV\b/.test(x)).map((x) => x.split("=")[0])).toEqual(["ENV LANG", "ENV SHELL", ...declaredEnv(id), "ENV HOME"]);
    for (const t of r.tags) expect(t).toMatch(/^[a-z0-9-]+:[0-9a-f]{64}$/);
  });
});

describe("E1-AMEND: list-valued preset, and the new base fields are refused by name until their tasks land", () => {
  it("a list of one plans exactly like the bare string, with the same envVersionId", () => {
    const a = plan(spec({ preset: "node" }), base("node"), A);
    const b = plan(spec({ preset: ["node"] }), base("node"), A);
    expect(b).toEqual(a);
    expect(plan(spec({ preset: ["node", "node"] }), base("node"), A)).toEqual(a);
  });
  it("two presets are refused with composition_not_planned (composition is E4-2), not silently planned as one", () => {
    expect(code(() => plan(spec({ preset: ["node", "python"] }), base("node"), A))).toBe("composition_not_planned");
  });
  it("an unknown or image-shaped element is still refused first, wherever it sits in the list", () => {
    expect(code(() => plan(spec({ preset: ["node", "nix"] }), base("node"), A))).toBe("unknown_preset");
    expect(code(() => plan(spec({ preset: ["node", "ghcr.io/x/y:1"] }), base("node"), A))).toBe("image_reference");
  });
  it("an empty list names no preset", () => {
    expect(code(() => plan(spec({ preset: [] }), base("node"), A))).toBe("preset_required");
  });
  it("a nix spec and an image spec are refused by name, not planned as a bare base", () => {
    expect(code(() => plan(spec({ nix: { flake: ".", shell: "default", inputs: [], substituters: [] } }), base("node"), A))).toBe("nix_not_planned");
    expect(code(() => plan(spec({ image: "sha256:" + "a".repeat(64) }), base("node"), A))).toBe("image_not_planned");
  });
});
