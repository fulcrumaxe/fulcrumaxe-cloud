import { describe, expect, it } from "vitest";
import { TOP_LEVEL_KEYS, parse, type ErrorCode } from "../src/index.js";

const OK = `version: 1
preset: node
setup:
  - [npm, ci]
run:
  - [npm, test]
env:
  NODE_ENV: test
secrets:
  - name: STRIPE_TEST_KEY
services: [redis, postgres]
network:
  domains: [registry.npmjs.org]
`;

const err = (yaml: string): { code: ErrorCode; field: string; line: number | null } => {
  const r = parse(yaml);
  if (r.ok) throw new Error("expected a rejection");
  return { code: r.error.code, field: r.error.field, line: r.error.line };
};

describe("parse (criterion 1): canonical spec or a typed error naming field and line", () => {
  it("returns the canonical spec, with defaults filled and sets sorted", () => {
    const r = parse(OK);
    expect(r.ok && r.spec).toEqual({
      env: { NODE_ENV: "test" }, network: { domains: ["registry.npmjs.org"] }, preset: ["node"],
      run: [["npm", "test"]], secrets: [{ kind: "brokered_http", name: "STRIPE_TEST_KEY" }],
      services: ["postgres", "redis"], setup: [["npm", "ci"]], version: 1,
    });
  });

  it.each<[string, string, ErrorCode, string, number | null]>([
    ["missing version", "preset: node\n", "invalid_value", "version", null],
    ["bad yaml syntax", "version: 1\nsetup: [npm\n", "yaml_syntax", "(document)", 3],
    ["duplicate key", "version: 1\nversion: 1\n", "yaml_syntax", "(document)", 2],
    ["unknown field", "version: 1\nfoo: 1\n", "unknown_field", "foo", 2],
    ["nested unknown field", "version: 1\nnetwork:\n  domains: []\n  proxy: x\n", "unknown_field", "network.proxy", 4],
    ["wrong type", "version: 1\nrun: nope\n", "invalid_type", "run", 2],
    ["unquoted number in env", "version: 1\nenv:\n  A: 1\n", "invalid_type", "env.A", 3],
    ["unknown service", "version: 1\nservices: [mysql]\n", "invalid_value", "services[0]", 2],
    ["bad secret kind", "version: 1\nsecrets:\n  - name: A\n    kind: vault\n", "invalid_value", "secrets[0].kind", 4],
    ["secret value in the file", "version: 1\nsecrets:\n  - name: A\n    value: hunter2\n", "unknown_field", "secrets[0].value", 4],
    ["secret name over 39 characters", `version: 1\nsecrets:\n  - name: ${"A".repeat(40)}\n`, "invalid_value", "secrets[0].name", 3],
    ["preset and dockerfile together", "version: 1\npreset: node\ndockerfile: Dockerfile\n", "invalid_value", "dockerfile", 3],
    ["dockerfile path escapes the repo", "version: 1\ndockerfile: ../Dockerfile\n", "invalid_value", "dockerfile", 2],
    ["CIDR as a hostname", "version: 1\nnetwork:\n  domains:\n    - 10.0.0.0/8\n", "invalid_value", "network.domains[0]", 4],
    ["second command is wrong", "version: 1\nsetup:\n  - [npm, ci]\n  - []\n", "invalid_value", "setup[1]", 4],
  ])("%s", (_name, yaml, code, field, line) => {
    expect(err(yaml)).toEqual({ code, field, line });
  });

  it("accepts a 39-character secret name", () => {
    const name = "A".repeat(39);
    const r = parse(`version: 1\nsecrets:\n  - name: ${name}\n`);
    expect(r.ok && r.spec.secrets).toEqual([{ kind: "brokered_http", name }]);
  });

  // Every input below is still rejected (asserted first, so this can never pass by parsing cleanly) and carries a
  // distinctive secret-looking value that must not appear anywhere in the error.
  const LEAK = "sk_live_hunter2_9f8e7d";
  it.each<[string, string, ErrorCode]>([
    ["an image reference in preset", `version: 1\npreset: 'ghcr.io/evil/${LEAK}:latest'\n`, "image_reference"],
    ["an image reference in services", `version: 1\nservices: ['ghcr.io/evil/${LEAK}:latest']\n`, "image_reference"],
    ["a forbidden network key", `version: 1\nnetwork:\n  ports: ${LEAK}\n`, "forbidden_field"],
    ["a reserved env name", `version: 1\nenv:\n  __proto__: ${LEAK}\n`, "invalid_value"],
    ["a string-form command", `version: 1\nsetup:\n  - npm ci && echo ${LEAK}\n`, "string_form_command"],
    ["a secret with an inline value", `version: 1\nsecrets:\n  - name: A\n    value: ${LEAK}\n`, "unknown_field"],
    ["a dockerfile path that escapes the repo", `version: 1\ndockerfile: ../${LEAK}\n`, "invalid_value"],
  ])("never echoes a rejected value (%s)", (_name, yaml, code) => {
    const r = parse(yaml);
    expect(r.ok, "input must be rejected").toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe(code);
    expect(r.error.message).not.toContain(LEAK);
    expect(r.error.message).not.toContain("hunter2");
    expect(String(r.error.field)).not.toContain(LEAK);
  });
});

describe("YAML safety", () => {
  it.each([
    ["anchor", "version: 1\nsetup: &a\n  - [npm, ci]\nrun: *a\n", 2],
    ["alias-only bomb", `version: 1\nx: &a [1]\ny: &b [*a,*a,*a]\nz: &c [*b,*b,*b]\n`, 2],
    ["merge key", "version: 1\nenv:\n  <<: {A: b}\n", 3],
  ])("rejects %s", (_n, yaml, line) => {
    expect(err(yaml)).toMatchObject({ code: "yaml_unsafe", line });
  });

  it("does not mistake a quoted or mid-word * or & for an alias", () => {
    expect(parse('version: 1\nrun:\n  - [ls, "*.txt", "a&b", x*y]\n').ok).toBe(true);
  });

  it("refuses custom tags, multi-document input and oversize or over-deep documents", () => {
    for (const y of ["version: 1\nenv:\n  A: !!js/function 'x'\n", "version: 1\n---\nversion: 1\n"]) expect(err(y).code).toBe("yaml_syntax");
    expect(err(`version: 1\n# ${"x".repeat(70000)}\n`).code).toBe("limit_exceeded");
    expect(err("version: 1\nsetup: [" + "[".repeat(30000) + "]".repeat(30000) + "]\n").code).toMatch(/yaml_syntax|limit_exceeded/);
    expect(err("version: 1\nsetup: [[[[[[[[[[x]]]]]]]]]]\n").code).toBe("limit_exceeded");
    expect(err(`version: 1\nrun:\n${"  - [a]\n".repeat(65)}`).code).toBe("limit_exceeded");
  });
});

describe("schema (criterion 2): exact key set; address-range and port keys are rejections", () => {
  it("snapshots the exact top-level key set", () => {
    expect([...TOP_LEVEL_KEYS]).toEqual(["dockerfile", "env", "image", "network", "nix", "preset", "run", "secrets", "services", "setup", "version"]);
    const r = parse(OK);
    expect(r.ok && Object.keys(r.spec).sort()).toEqual([...TOP_LEVEL_KEYS].filter((k) => !["dockerfile", "image", "nix"].includes(k)));
  });

  it.each(["subnets", "cidr", "ipRanges", "ports", "port", "ip_ranges", "CIDR-blocks", "exposePorts", "forward_ports", "subnet"])(
    "rejects %s (top level and nested) with a named error, not an ignore",
    (key) => {
      expect(err(`version: 1\n${key}: [x]\n`)).toEqual({ code: "forbidden_field", field: key, line: 2 });
      expect(err(`version: 1\nnetwork:\n  ${key}: [x]\n`)).toEqual({ code: "forbidden_field", field: `network.${key}`, line: 3 });
    },
  );

  it("still allows a PORT environment variable (env keys are data, not schema)", () => {
    expect(parse("version: 1\nenv:\n  PORT: '3000'\n").ok).toBe(true);
  });
});

describe("argv-only commands (criterion 5)", () => {
  it.each(["setup", "run"])("rejects a string-form %s command", (phase) => {
    expect(err(`version: 1\n${phase}:\n  - [ok]\n  - npm ci && rm -rf /\n`)).toEqual({ code: "string_form_command", field: `${phase}[1]`, line: 4 });
  });

  it("rejects a whole-phase string", () => {
    expect(err("version: 1\nsetup: npm ci\n").code).toBe("invalid_type");
  });
});

// Scope (TL ruling): the check guards the fields that can name or build an image -- preset, dockerfile, services
// and network.domains. Env values and argv elements are free text and are never treated as image references.
describe("image references (criterion 6): refused where a string can name or build an image", () => {
  const refs = ["node:20", "ubuntu:22.04", "ghcr.io/acme/app:latest", "acme/app@sha256:" + "a".repeat(64), "registry.example.com/team/img", "localhost:5000/app", "ghcr.io", "docker.io", "123.dkr.ecr.us-east-1.amazonaws.com"];
  const imageFields = (v: string) => [
    `preset: '${v}'`, `dockerfile: '${v}'`, `network:\n  domains: ['${v}']`, `secrets:\n  - name: A\n    kind: '${v}'`, `services: ['${v}']`,
  ];
  it.each(refs)("rejects %s in every image-capable field", (v) => {
    for (const f of imageFields(v)) {
      const r = parse(`version: 1\n${f}\n`);
      expect(r.ok, f).toBe(false);
    }
    for (const f of [`preset: '${v}'`, `services: ['${v}']`, `network:\n  domains: ['${v}']`]) expect(err(`version: 1\n${f}\n`).code, f).toBe("image_reference");
  });

  it("reports a preset that is an image reference as image_reference", () => {
    expect(err("version: 1\npreset: 'node:20'\n")).toEqual({ code: "image_reference", field: "preset", line: 2 });
  });

  it.each(["db:5432", "localhost:5432", "info:debug", "en_US:en", "ghcr.io/acme/app:latest", "acme/app@sha256:" + "a".repeat(64)])("accepts %s as an env value", (v) => {
    const r = parse(`version: 1\nenv:\n  A: '${v}'\n`);
    expect(r.ok && r.spec.env).toEqual({ A: v });
  });

  it.each([[["npm", "run", "lint:fix"]], [["pnpm", "test:unit"]], [["docker", "pull", "node:20"]]])("accepts %j as setup and run argv", (argv) => {
    const list = JSON.stringify(argv);
    const r = parse(`version: 1\nsetup:\n  - ${list}\nrun:\n  - ${list}\n`);
    expect(r.ok && [r.spec.setup, r.spec.run]).toEqual([[argv], [argv]]);
  });

  it.each(["NODE_ENV=test", "https://registry.npmjs.org/x", "--flag=a", "12:30", "npm", "Dockerfile", ".devcontainer/Dockerfile", "user@host"])("allows %s", (v) => {
    expect(parse(`version: 1\nenv:\n  A: '${v}'\n`).ok).toBe(true);
  });
});

describe("anchors and aliases are refused wherever the parser can see one", () => {
  it.each([
    ["explicit-key input from review", "? &v version\n: 1\nenv:\n  ? *v\n  : 'x'\n", 1],
    ["explicit-key anchor", "version: 1\n? &k env\n: {A: b}\n", 2],
    ["anchor on the first line", "&doc\nversion: 1\n", 1],
    ["anchor after the document-start marker", "--- &doc\nversion: 1\n", 1],
    ["anchor on a flow-sequence item", "version: 1\nsetup:\n  - [&a npm, ci]\n", 3],
    ["anchor on a block-sequence item", "version: 1\nservices:\n  - &s redis\n", 3],
    ["anchor reused by an alias", "version: 1\nenv:\n  A: &v x\n  B: *v\n", 3],
    ["anchor on a flow-mapping key", "version: 1\nenv: {&k A: b}\n", 2],
    ["tag and anchor together", "version: 1\nenv:\n  A: !!str &v x\n", 3],
  ])("%s", (_n, yaml, line) => {
    expect(err(yaml)).toMatchObject({ code: "yaml_unsafe", line });
  });

  it("does not mistake an anchor-looking string for one", () => {
    expect(parse("version: 1\nenv:\n  A: 'x &v'\n  B: '*v'\n  C: a&b\n").ok).toBe(true);
  });
});

describe("reserved env names are a typed rejection, not a silent drop", () => {
  it.each(["__proto__", "constructor", "prototype"])("rejects env.%s", (k) => {
    expect(err(`version: 1\nenv:\n  ${k}: x\n`)).toEqual({ code: "invalid_value", field: `env.${k}`, line: 3 });
  });

  it("keeps a normal env map a plain object with no inherited entries", () => {
    const r = parse("version: 1\nenv:\n  A: x\n");
    expect(r.ok && Object.getPrototypeOf(r.spec.env)).toBe(Object.prototype);
    expect(r.ok && Object.keys(r.spec.env)).toEqual(["A"]);
  });
});
