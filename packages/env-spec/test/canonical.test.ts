import { describe, expect, it } from "vitest";
import { EMPTY_INPUTS_DIGEST, canonicalize, envVersionId, parse, type EnvSpec } from "../src/index.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const spec = (yaml: string): EnvSpec => {
  const r = parse(yaml);
  if (!r.ok) throw r.error;
  return r.spec;
};

const A = `version: 1
preset: python
setup: [[pip, install, -r, requirements.txt], [pytest, --version]]
env: {B: '2', A: '1'}
secrets: [{name: Z_KEY}, {name: A_KEY, kind: in_sandbox}]
services: [redis, postgres, redis]
network: {domains: [B.example.com, a.example.com]}
`;
// The same spec: different key order, whitespace, quoting, list order of sets, letter case of hosts.
const B = `network:
    domains:
        - a.example.com
        - "b.example.com"
services:
  - postgres
  - redis
secrets:
  - kind: brokered_http

    name: Z_KEY
  - name: A_KEY
    kind: in_sandbox
env:
  A: "1"
  B: "2"
setup:
  - [pip,   install, -r, requirements.txt]
  - [pytest, --version]
preset: python
version: 1
`;

describe("canonicalize (criterion 3)", () => {
  it("is byte-identical for semantically identical specs with different key order and whitespace", () => {
    expect(canonicalize(spec(A))).toBe(canonicalize(spec(B)));
  });

  it("is compact, sorted JSON: the exact bytes E9 stores", () => {
    expect(canonicalize(spec(A))).toBe(
      '{"env":{"A":"1","B":"2"},"network":{"domains":["a.example.com","b.example.com"]},"preset":["python"],"run":[],' +
        '"secrets":[{"kind":"in_sandbox","name":"A_KEY"},{"kind":"brokered_http","name":"Z_KEY"}],"services":["postgres","redis"],' +
        '"setup":[["pip","install","-r","requirements.txt"],["pytest","--version"]],"version":1}',
    );
  });

  it("is idempotent, including through a JSON round trip", () => {
    const once = canonicalize(spec(A));
    expect(canonicalize(spec(once))).toBe(once);
    expect(canonicalize(JSON.parse(once))).toBe(once);
  });

  it("keeps command order, because order is semantic", () => {
    const swapped = A.replace("[[pip, install, -r, requirements.txt], [pytest, --version]]", "[[pytest, --version], [pip, install, -r, requirements.txt]]");
    expect(canonicalize(spec(swapped))).not.toBe(canonicalize(spec(A)));
  });

  it("carries secret names only: any extra field on a secret is stripped, never stored", () => {
    const hostile = { ...spec(A), secrets: [{ name: "A_KEY", kind: "in_sandbox", value: "hunter2", handle: "vault:0123" }] } as unknown as EnvSpec;
    const out = canonicalize(hostile);
    expect(out).not.toMatch(/hunter2|vault|value|handle/);
    expect(JSON.parse(out).secrets).toEqual([{ kind: "in_sandbox", name: "A_KEY" }]);
  });
});

describe("envVersionId (criterion 4)", () => {
  const base = spec(A);
  const id = envVersionId(base, DIGEST);

  it("is 64 lowercase hex, stable across calls, and sha256(canonical || digest || inputsDigest)", async () => {
    const { createHash } = await import("node:crypto");
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(envVersionId(spec(B), DIGEST)).toBe(id);
    expect(id).toBe(createHash("sha256").update(canonicalize(base) + DIGEST + EMPTY_INPUTS_DIGEST).digest("hex"));
  });

  it("changes when the base digest or any semantic field changes", () => {
    const variants: EnvSpec[] = [
      { ...base, preset: ["node"] }, { ...base, dockerfile: "Dockerfile", preset: undefined },
      { ...base, setup: [...base.setup, ["true"]] }, { ...base, run: [["make"]] }, { ...base, env: { ...base.env, C: "3" } },
      { ...base, secrets: base.secrets.slice(1) }, { ...base, secrets: [{ name: "Z_KEY", kind: "in_sandbox" }, base.secrets[0]!] },
      { ...base, services: ["redis"] }, { ...base, network: { domains: ["a.example.com"] } },
    ];
    const ids = variants.map((v) => envVersionId(v, DIGEST, v.dockerfile === undefined ? undefined : EMPTY_INPUTS_DIGEST));
    expect(new Set([id, ...ids, envVersionId(base, `sha256:${"b".repeat(64)}`)]).size).toBe(ids.length + 2);
  });

  it.each(["", "sha256:abc", `sha256:${"A".repeat(64)}`, `node:20`, `sha1:${"a".repeat(40)}`])("refuses base digest %j", (d) => {
    expect(() => envVersionId(base, d)).toThrow(/baseDigest/);
  });
});
