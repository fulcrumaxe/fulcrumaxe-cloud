import { MISE, PRESETS, RUST_DEFAULT_TOOLCHAIN } from "@fx/env-presets";
import { inputsDigest, type EnvSpec } from "@fx/env-spec";
import { describe, expect, it } from "vitest";
import { EnvBuildError, plan, type PlanOptions } from "../src/index.js";

const spec = (over: Record<string, unknown> = {}): EnvSpec =>
  ({ version: 1, setup: [], run: [], env: {}, secrets: [], services: [], network: { domains: [] }, ...over }) as unknown as EnvSpec;
const base = (id: string) => PRESETS.find((p) => p.id === id)!.base;
const BASE = base("node");
const D1 = "1".repeat(64);
const D2 = "2".repeat(64);
const run = (s: EnvSpec, o: Partial<PlanOptions> = {}) => plan(s, BASE, { accountId: "acct-1", ...o });
const code = (fn: () => unknown): string => {
  try { fn(); } catch (e) { if (e instanceof EnvBuildError) return e.code; throw e; }
  return "none";
};
const lines = (d: string) => d.split("\n");
const pin = (tool: string, version: string, source: string) => ({ tool, version, source });

describe("composition (C3 section 5.4)", () => {
  it("a two-preset spec has the base, sandbox-base once, then one toolchain layer per preset in canonical order", () => {
    const a = run(spec({ preset: ["python", "node"] }));
    expect(a.layers.map((l) => l.id)).toEqual(["sandbox-base", "node-22", "python-3.14"]);
    expect(a.layers.filter((l) => l.toolchains.length > 0).map((l) => l.toolchains)).toEqual([["node-22"], ["python-3.14"]]);
    const text = lines(a.dockerfile);
    expect(text[0]).toBe(`FROM ${BASE}`);
    expect(text.filter((l) => l === "# layer sandbox-base")).toHaveLength(1);
    expect(text.indexOf("# layer sandbox-base")).toBeLessThan(text.indexOf("# layer node-22"));
    expect(text.indexOf("# layer node-22")).toBeLessThan(text.indexOf("# layer python-3.14"));
    expect(a.customerControlledLayers).toEqual([]);
  });
  it("is independent of the order the presets were written in, with the same version id", () => {
    const a = run(spec({ preset: ["python", "go", "node"] }));
    const b = run(spec({ preset: ["node", "python", "go"] }));
    expect(b).toEqual(a);
    expect(a.layers.map((l) => l.id)).toEqual(["sandbox-base", "go-1.26", "node-22", "python-3.14"]);
  });
  it("puts service packages after the preset layers", () => {
    const ids = run(spec({ preset: ["node", "rust"], services: ["redis"] })).layers.map((l) => l.id);
    expect(ids.at(-1)).toBe("service-redis");
    expect(ids.indexOf("rust-1.93")).toBeLessThan(ids.indexOf("service-redis"));
  });
  it("refuses a base that is not every preset's base, and keeps no CMD or ENTRYPOINT", () => {
    expect(code(() => plan(spec({ preset: ["node", "go"] }), BASE + "0", { accountId: "a" }))).toBe("base_not_pinned");
    expect(code(() => plan(spec({ preset: ["node", "go"] }), "docker.io/library/ubuntu@sha256:" + "a".repeat(64), { accountId: "a" }))).toBe("base_mismatch");
    expect(run(spec({ preset: ["node", "go", "rust"] })).dockerfile).not.toMatch(/^\s*(ENTRYPOINT|CMD)\b/im);
  });
});

describe("rust-toolchain layer (C3 section 6.1)", () => {
  const rustSpec = spec({ preset: "rust" });
  const file = { source: "rust-toolchain.toml" as const, channel: "nightly-2026-09-01", components: ["clippy"] };
  const withRust = (t: unknown) => run(rustSpec, { rustToolchain: t as never, inputsDigest: D1 });

  it("plans exactly the named channel and components, after the preset layers", () => {
    const p = withRust(file);
    const layer = p.layers.at(-1)!;
    expect(layer.id).toBe("rust-toolchain");
    expect(layer.steps[0]).toEqual(["rustup", "toolchain", "install", "nightly-2026-09-01", "--profile", "minimal", "--no-self-update", "--component", "clippy"]);
    expect(layer.steps[1]).toEqual(["rustup", "default", "nightly-2026-09-01"]);
    expect(p.customerControlledLayers).toEqual(["rust-toolchain"]);
    expect(p.dockerfile).toContain(`RUN ["rustup","default","nightly-2026-09-01"]`);
    expect(p.layers.map((l) => l.id)).toEqual(["sandbox-base", "rust-1.93", "rust-toolchain"]);
  });
  it("sorts and de-duplicates components and targets, and honours the profile", () => {
    const a = withRust({ ...file, components: ["rustfmt", "clippy", "clippy"], targets: ["wasm32-unknown-unknown"], profile: "default" });
    const b = withRust({ ...file, components: ["clippy", "rustfmt"], targets: ["wasm32-unknown-unknown"], profile: "default" });
    expect(b).toEqual(a);
    expect(a.layers.at(-1)!.steps[0]).toEqual(["rustup", "toolchain", "install", "nightly-2026-09-01", "--profile", "default", "--no-self-update",
      "--component", "clippy", "--component", "rustfmt", "--target", "wasm32-unknown-unknown"]);
  });
  it("refuses `path` by name, and bad channels, profiles and list entries", () => {
    expect(code(() => withRust({ ...file, path: "/tmp/tc" }))).toBe("rust_toolchain_path");
    for (const channel of ["", "latest", "nightly-2026-9-1", "1.93.0 ", "--help", "stable;rm", "1"]) {
      expect(code(() => withRust({ ...file, channel })), channel).toBe("invalid_rust_toolchain");
    }
    expect(code(() => withRust({ ...file, profile: "huge" }))).toBe("invalid_rust_toolchain");
    for (const bad of ["-x", "Clippy", "a b", "", "a".repeat(65)]) expect(code(() => withRust({ ...file, components: [bad] })), bad).toBe("invalid_rust_toolchain");
    expect(code(() => withRust({ ...file, targets: Array.from({ length: 33 }, (_, i) => `t${i}`) }))).toBe("invalid_rust_toolchain");
    expect(code(() => withRust({ ...file, source: "Cargo.toml" }))).toBe("invalid_rust_toolchain");
  });
  it("is honoured only when the rust preset is named", () => {
    expect(code(() => run(spec({ preset: "node" }), { rustToolchain: file, inputsDigest: D1 }))).toBe("rust_toolchain_without_rust");
  });
  it("never lets the file move the distribution hosts: they stay the preset's fixed ones", () => {
    const d = withRust(file).dockerfile;
    expect(d).toContain('ENV RUSTUP_DIST_SERVER="https://static.rust-lang.org"');
    expect(d.match(/RUSTUP_DIST_SERVER/g)).toHaveLength(1);
    expect(RUST_DEFAULT_TOOLCHAIN).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("version-file layer through mise (C3 section 5.6)", () => {
  const pins = [pin("python", "3.12", ".python-version"), pin("node", "20.11.1", ".nvmrc")];
  const V = (p: unknown, over: Record<string, unknown> = {}) => run(spec({ preset: "node", ...over }), { versionPins: p as never, inputsDigest: D1 });

  it("installs each pinned tool in a layer after the preset, from a generated config, sorted by tool", () => {
    const p = V(pins);
    const layer = p.layers.at(-1)!;
    expect(layer.id).toBe("version-tools");
    expect(layer.toolchains).toEqual(["node", "python"]);
    const cfg = layer.files.find((f) => f.path === "/opt/fx-mise/config/config.toml")!.content;
    expect(cfg).toContain('[tools]\nnode = "20.11.1"\npython = "3.12"\n');
    expect(cfg).toContain('enable_tools = ["node", "python"]');
    expect(cfg).toContain("paranoid = true");
    expect(cfg).toContain("not_found_auto_install = false");
    for (const b of ["http", "ubi", "npm", "aqua", "asdf", "vfox", "github"]) expect(cfg).toMatch(new RegExp(`disable_backends = \\[[^\\]]*"${b}"`));
    expect(cfg).not.toMatch(/disable_backends = \[[^\]]*"core"/);
    expect(p.customerControlledLayers).toEqual(["version-tools"]);
    expect(V([...pins].reverse())).toEqual(p);
  });
  it("runs mise with an empty environment, from a directory outside the repo, on a checksum-pinned binary", () => {
    const steps = V(pins).layers.at(-1)!.steps;
    const install = steps.find((s) => s.at(-1) === "install")!;
    expect(install.slice(0, 4)).toEqual(["env", "-i", "-C", "/opt/fx-mise"]);
    expect(install).toContain("MISE_TRUSTED_CONFIG_PATHS=");
    expect(install).toContain("MISE_GLOBAL_CONFIG_FILE=/opt/fx-mise/config/config.toml");
    const sums = V(pins).layers.at(-1)!.files.find((f) => f.path.endsWith("mise.sha256"))!.content;
    expect(sums).toBe(`${MISE.sha256}  /opt/fx-mise/bin/mise\n`);
    expect(steps.findIndex((s) => s[0] === "sha256sum")).toBeLessThan(steps.indexOf(install));
  });
  it("leaves no mise in the image, no activation, and the tools first on PATH as explicit directories", () => {
    const d = V(pins).dockerfile;
    expect(d).toContain('ENV PATH="/opt/fx-tools/node/bin:/opt/fx-tools/python/bin:${PATH}"');
    expect(d).toMatch(/RUN \["rm","-rf","\/opt\/fx-mise\/bin"/);
    expect(d).not.toMatch(/activate|shims\/|BASH_ENV|\.bashrc|\.profile|ENV MISE|ENV .*MISE_/);
    const all = lines(d);
    expect(all.findIndex((l) => l.startsWith("ENV PATH="))).toBeLessThan(all.findIndex((l) => l.startsWith("USER ")));
  });
  it("accepts exact versions, prefixes and the fixed aliases", () => {
    const real = ["20", "20.11", "20.11.1", "lts", "lts/*", "lts/iron", "latest", "21.0.1+12", "21-ea", "v20.11.1", "temurin-21.0.2+13.0.LTS", "pypy3.10-7.3.15", "3.13.0rc1", "1.23rc1"];
    for (const v of real) expect(code(() => V([pin("node", v, "mise.toml")])), v).toBe("none");
  });
  it("strips a leading v before a digit and nothing else", () => {
    const cfg = (v: string) => V([pin("node", v, ".nvmrc")]).layers.at(-1)!.files.find((f) => f.path.endsWith("config.toml"))!.content;
    expect(cfg("v20.11.1")).toContain('node = "20.11.1"');
    expect(cfg("v20.11.1")).toBe(cfg("20.11.1"));
    expect(cfg("vendor-1")).toContain('node = "vendor-1"');
    expect(code(() => V([pin("node", "vv20", ".nvmrc")]))).toBe("none");
    expect(cfg("vv20")).toContain('node = "vv20"');
  });
  it("refuses ref:, path:, sub-, system, whitespace, quotes and anything that could add a TOML table", () => {
    const hostile = ["ref:main", "ref", "path:/tmp/x", "path", "sub-1:20", "sub-1", "system", "System","vref:x", "20 ", " 20", "a b", "1\"\n[hooks]", "'1'", "", "-1", ".1", "20.11.1\n", "../x", "a/b", "lts/*/x", "20*", "1".repeat(80), "lts/", "1:2", "1\\2", "1#2", "1]"];
    for (const v of hostile) expect(code(() => V([pin("node", v, "mise.toml")])), JSON.stringify(v)).toBe("invalid_version_pin");
  });
  it("refuses tools outside the core list and files outside the honoured set", () => {
    expect(code(() => V([pin("terraform", "1.9.0", ".tool-versions")]))).toBe("tool_not_allowed");
    expect(code(() => V([pin("npm:evil", "1", "mise.toml")]))).toBe("tool_not_allowed");
    expect(code(() => V([pin("node", "20", "mise.local.toml")]))).toBe("invalid_version_pin");
    expect(code(() => V([pin("python", "3.12", ".nvmrc")]))).toBe("invalid_version_pin");
    expect(code(() => V([pin("node", "20", ".nvmrc"), pin("node", "22", "mise.toml")]))).toBe("invalid_version_pin");
    expect(code(() => V("node" as never))).toBe("invalid_version_pin");
  });
  it("caps the tool count at 16 (only 7 are allowed, so the cap is checked on the list itself)", () => {
    expect(code(() => V(Array.from({ length: 17 }, () => pin("node", "20", "mise.toml"))))).toBe("too_many_tools");
  });
  it("an empty pin list adds no layer and needs no inputsDigest", () => {
    const p = run(spec({ preset: "node" }), { versionPins: [] });
    expect(p.layers.map((l) => l.id)).toEqual(["sandbox-base", "node-22"]);
    expect(p).toEqual(run(spec({ preset: "node" })));
  });
  it("puts the rust-toolchain layer before the version-file layer, both after services", () => {
    const p = run(spec({ preset: ["node", "rust"], services: ["postgres"] }), {
      versionPins: pins, rustToolchain: { source: "rust-toolchain", channel: "1.90.0" }, inputsDigest: D1,
    });
    expect(p.layers.map((l) => l.id).slice(-3)).toEqual(["service-postgres", "rust-toolchain", "version-tools"]);
    expect(p.customerControlledLayers).toEqual(["rust-toolchain", "version-tools"]);
  });
});

describe("inputsDigest reaches the version id (C3 section 1.4)", () => {
  const s = spec({ preset: ["node", "rust"] });
  const tree = (nvmrc: string, other = "a".repeat(40)) => [
    { path: ".nvmrc", sha: nvmrc }, { path: "rust-toolchain.toml", sha: "c".repeat(40) }, { path: "src/main.rs", sha: other },
  ];
  const opts = (t: ReturnType<typeof tree>) => ({
    versionPins: [pin("node", "20.11.1", ".nvmrc")], rustToolchain: { source: "rust-toolchain.toml" as const, channel: "1.90.0" }, inputsDigest: inputsDigest(s, t),
  });

  it("is required once a version file or a rust toolchain file shapes the image", () => {
    expect(code(() => run(s, { versionPins: [pin("node", "20", ".nvmrc")] }))).toBe("inputs_digest_required");
    expect(code(() => run(s, { rustToolchain: { source: "rust-toolchain", channel: "1.90.0" } }))).toBe("inputs_digest_required");
    expect(code(() => run(s, { inputsDigest: "xyz" }))).toBe("invalid_inputs_digest");
    expect(code(() => run(s, { inputsDigest: D1.toUpperCase().replace(/1/g, "A") }))).toBe("invalid_inputs_digest");
  });
  it("changing a version file changes the id; changing an unrelated file does not", () => {
    const a = run(s, opts(tree("1".repeat(40))));
    expect(run(s, opts(tree("2".repeat(40)))).envVersionId).not.toBe(a.envVersionId);
    expect(run(s, opts(tree("1".repeat(40), "b".repeat(40)))).envVersionId).toBe(a.envVersionId);
  });
  it("a plan without version files keeps the id it had before (no inputsDigest, and the empty digest, agree)", () => {
    expect(run(s, { inputsDigest: inputsDigest(s, [{ path: "src/main.rs", sha: "a".repeat(40) }]) }).envVersionId).toBe(run(s).envVersionId);
    expect(run(s, { inputsDigest: D1 }).envVersionId).not.toBe(run(s, { inputsDigest: D2 }).envVersionId);
  });
});

describe("B4: no credential, login or push, and customer-shaped layers come last", () => {
  const full = () => run(spec({ preset: ["node", "rust", "python"], services: ["postgres"], env: { MISE_DATA_DIR: "/hostile-dir", RUSTUP_DIST_SERVER: "https://evil.example", TOKEN: "t" } }), {
    versionPins: [pin("node", "20.11.1", ".nvmrc"), pin("python", "3.12", ".tool-versions")],
    rustToolchain: { source: "rust-toolchain.toml", channel: "stable", components: ["clippy"], targets: ["wasm32-unknown-unknown"] },
    inputsDigest: D1,
  });

  it("carries no credential material, login or push in any line", () => {
    const d = full().dockerfile;
    expect(d).not.toMatch(/docker\s+login|\bpush\b|--mount=type=secret|\b(ARG|ENV)\s+\w*(TOKEN|OIDC|VERCEL|VCR|SECRET|PASSWORD|CREDENTIAL)/i);
  });
  it("never bakes spec env into the image, so a customer MISE_* or RUSTUP_* key cannot reach it", () => {
    const d = full().dockerfile;
    expect(d).not.toContain("evil.example");
    expect(d).not.toContain("hostile-dir");
    expect(d).not.toMatch(/\bENV MISE_/);
  });
  it("lists the customer-shaped layers last and in order", () => {
    const p = full();
    expect(p.layers.slice(-2).map((l) => l.id)).toEqual(p.customerControlledLayers);
    expect(p.customerControlledLayers).toEqual(["rust-toolchain", "version-tools"]);
  });
  it("is byte-identical for identical inputs", () => {
    expect(JSON.stringify(full())).toBe(JSON.stringify(full()));
  });
});
