import { PRESETS } from "@fx/env-presets";
import type { Layer } from "@fx/env-presets";
import type { EnvSpec } from "@fx/env-spec";
import { describe, expect, it } from "vitest";
import { renderLayer } from "../src/dockerfile.js";
import { EnvBuildError, plan } from "../src/index.js";

const spec = (preset: string): EnvSpec =>
  ({ version: 1, preset, setup: [], run: [], env: {}, secrets: [], services: [], network: { domains: [] } }) as unknown as EnvSpec;
const base = (id: string) => PRESETS.find((p) => p.id === id)!.base;
const layer = (over: Partial<Layer>): Layer => ({ id: "t", toolchains: [], aptPackages: [], files: [], steps: [["true"]], ...over });
const code = (fn: () => unknown): string => {
  try { fn(); } catch (e) { if (e instanceof EnvBuildError) return e.code; throw e; }
  return "none";
};

describe("E3-2: a layer's env renders as ENV lines between the files and the steps", () => {
  it("renders each entry quoted, after files and before steps", () => {
    const out = renderLayer(layer({
      files: [{ path: "/etc/x", mode: "0444", content: "x" }],
      env: { RUSTUP_HOME: "/usr/local/rustup", PATH: "/a:/b" },
    }));
    const env = out.findIndex((l) => l.startsWith("ENV "));
    expect(out.slice(env, env + 2)).toEqual(['ENV RUSTUP_HOME="/usr/local/rustup"', 'ENV PATH="/a:/b"']);
    expect(out.findIndex((l) => l.startsWith("COPY "))).toBeLessThan(env);
    expect(out.findIndex((l) => l.startsWith("RUN "))).toBeGreaterThan(env);
  });

  it("renders nothing for a layer without env", () => {
    expect(renderLayer(layer({})).some((l) => l.startsWith("ENV "))).toBe(false);
  });

  it.each([["a value with a space", { K: "a b" }], ["a quote", { K: 'a"b' }], ["a dollar expansion", { K: "$HOME" }],
    ["a backslash", { K: "a\\b" }], ["a newline", { K: "a\nENTRYPOINT x" }], ["a lowercase key", { k: "v" }], ["a key with a dash", { "A-B": "v" }]])(
    "refuses %s", (_name, env) => {
      expect(code(() => renderLayer(layer({ env })))).toBe("invalid_layer_env");
    });

  it("emits the rust layer's env in the planned Dockerfile, ahead of the rustup-init run", () => {
    const d = plan(spec("rust"), base("rust"), { accountId: "a" }).dockerfile.split("\n");
    const host = d.indexOf('ENV RUSTUP_DIST_SERVER="https://static.rust-lang.org"');
    const run = d.findIndex((l) => l.startsWith('RUN ["/tmp/rustup-init"'));
    expect(host).toBeGreaterThan(0);
    expect(run).toBeGreaterThan(host);
    expect(d.some((l) => l.startsWith("ENTRYPOINT") || l.startsWith("CMD"))).toBe(false);
  });
});
