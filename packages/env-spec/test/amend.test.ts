import { describe, expect, it } from "vitest";
import {
  EMPTY_INPUTS_DIGEST, KNOWN_PRESET_IDS, canonicalize, envVersionId, inputsDigest, isInputFile, parse,
  type EnvSpec, type ErrorCode, type TreeEntry,
} from "../src/index.js";

// E1-AMEND (D#5 C3 section 9, row 2): the `nix` field and customer substituters, inputsDigest in envVersionId,
// a list-valued `preset`, a digest-only `image` field, and the NIX_* refusal.

const DIGEST = `sha256:${"a".repeat(64)}`;
const KEY = `my-cache-1:${"A".repeat(43)}=`;
const KEY2 = `other-1:${"B".repeat(43)}=`;
const sha = (c: string): string => c.repeat(40);

const ok = (yaml: string): EnvSpec => {
  const r = parse(yaml);
  if (!r.ok) throw r.error;
  return r.spec;
};
const err = (yaml: string): { code: ErrorCode; field: string; message: string } => {
  const r = parse(yaml);
  if (r.ok) throw new Error("expected a rejection");
  return { code: r.error.code, field: r.error.field, message: r.error.message };
};

describe("preset is list-valued: 1 to 3 known ids", () => {
  it("accepts a string as a list of one, and the two forms are the same spec", () => {
    const a = ok("version: 1\npreset: node\n");
    const b = ok("version: 1\npreset: [node]\n");
    expect(a.preset).toEqual(["node"]);
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(envVersionId(a, DIGEST)).toBe(envVersionId(b, DIGEST));
  });

  it("canonical form is sorted and de-duplicated, so key and list order never matter", () => {
    const a = ok("version: 1\npreset: [python, node, node, rust]\n");
    const b = ok("version: 1\npreset:\n  - rust\n  - python\n  - node\n");
    expect(a.preset).toEqual(["node", "python", "rust"]);
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(canonicalize(a)).toContain('"preset":["node","python","rust"]');
  });

  it("a different set of presets is a different environment", () => {
    expect(envVersionId(ok("version: 1\npreset: [node, python]\n"), DIGEST)).not.toBe(envVersionId(ok("version: 1\npreset: [node, go]\n"), DIGEST));
  });

  it("refuses more than 3 distinct presets, but counts a repeated id once", () => {
    expect(err("version: 1\npreset: [node, python, go, rust]\n")).toMatchObject({ code: "limit_exceeded", field: "preset" });
    expect(ok("version: 1\npreset: [node, python, go, go, node]\n").preset).toEqual(["go", "node", "python"]);
  });

  it("refuses an empty list", () => {
    expect(err("version: 1\npreset: []\n")).toMatchObject({ code: "invalid_value", field: "preset" });
  });

  it.each(["nix", "Node", "node22", "perl"])("refuses the unknown id %s, naming the element", (id) => {
    expect(err(`version: 1\npreset: [node, ${id}]\n`)).toMatchObject({ field: "preset[1]" });
    expect(["unknown_preset", "invalid_value"]).toContain(err(`version: 1\npreset: ${id}\n`).code);
  });

  it("names unknown_preset for a well-formed id that is not one of the nine", () => {
    expect(err("version: 1\npreset: nix\n")).toMatchObject({ code: "unknown_preset", field: "preset" });
  });

  it("still refuses an image reference anywhere in the list (image_reference wins over unknown)", () => {
    expect(err("version: 1\npreset: [node, 'ghcr.io/evil/x:latest']\n")).toMatchObject({ code: "image_reference", field: "preset[1]" });
    expect(err("version: 1\npreset: ['node:20']\n").code).toBe("image_reference");
  });

  it("accepts each of the nine known ids", () => {
    for (const id of KNOWN_PRESET_IDS) expect(ok(`version: 1\npreset: ${id}\n`).preset).toEqual([id]);
    expect(KNOWN_PRESET_IDS).toHaveLength(9);
  });
});

const SUBS = `    substituters:
      - {url: 'https://cache.example.com/team', publicKey: '${KEY}'}`;
const NIX_OK = `version: 1
network: {domains: [cache.example.com]}
nix:
${SUBS}
`;

describe("the nix field", () => {
  it("fills defaults: the flake is '.', the shell is 'default'", () => {
    expect(ok("version: 1\nnix: {}\n").nix).toEqual({ flake: ".", inputs: [], shell: "default", substituters: [] });
  });

  it("canonicalizes a spelled-out default to the same bytes as the omitted default", () => {
    const a = ok("version: 1\nnix: {flake: '.', shell: default}\n");
    const b = ok("version: 1\nnix: {}\n");
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it("keeps a chosen flake, shell and sorted, de-duplicated inputs", () => {
    const s = ok("version: 1\nnix:\n  flake: tools/dev\n  shell: ci-shell\n  inputs: [b/pins.json, a.txt, a.txt]\n");
    expect(s.nix).toEqual({ flake: "tools/dev", inputs: ["a.txt", "b/pins.json"], shell: "ci-shell", substituters: [] });
  });

  it.each(["/etc", "../x", "a/../b", "a/..", "github:acme/dev", "a#b", "a?b", "a b", "a\\b", "a;b", "-x", "$(id)", "", "a//b", "~/x", "a/-x", "--help"])(
    "refuses the flake path %j (it must be a relative path inside the repo)",
    (flake) => {
      const r = parse(`version: 1\nnix:\n  flake: ${JSON.stringify(flake)}\n`);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.field).toBe("nix.flake");
    },
  );

  it.each(["Dev", "1abc", "a b", "a;b", "a.b", "a_b", "-a", "a/b", ""])("refuses the shell name %j", (shell) => {
    const r = parse(`version: 1\nnix:\n  shell: ${JSON.stringify(shell)}\n`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe("nix.shell");
  });

  it("refuses an input path that escapes the repo", () => {
    expect(err("version: 1\nnix:\n  inputs: ['../secret']\n")).toMatchObject({ field: "nix.inputs[0]" });
  });

  it("refuses an unknown or address-shaped key inside nix", () => {
    expect(err("version: 1\nnix: {registry: x}\n")).toMatchObject({ code: "unknown_field", field: "nix.registry" });
    expect(err("version: 1\nnix: {ports: [1]}\n")).toMatchObject({ code: "forbidden_field" });
    expect(err("version: 1\nnix: {config: 'sandbox = false'}\n")).toMatchObject({ code: "unknown_field" });
  });

  it("refuses a non-mapping", () => {
    expect(err("version: 1\nnix: github:acme/dev\n").code).toBe("invalid_type");
  });

  it("changes envVersionId when the flake, shell or inputs change", () => {
    const f = (n: string) => envVersionId(ok(`version: 1\nnix: ${n}\n`), DIGEST, EMPTY_INPUTS_DIGEST);
    expect(new Set([f("{}"), f("{shell: ci}"), f("{flake: sub}"), f("{inputs: [x.json]}")]).size).toBe(4);
  });
});

describe("nix excludes every other base", () => {
  it.each([
    ["preset", "preset: node"], ["a preset list", "preset: [node, go]"], ["dockerfile", "dockerfile: Dockerfile"], ["image", `image: sha256:${"a".repeat(64)}`],
  ])("nix with %s is refused", (_n, other) => {
    expect(err(`version: 1\nnix: {}\n${other}\n`)).toMatchObject({ code: "invalid_value", field: expect.stringMatching(/^(nix|image)$/) });
  });

  it("a Dockerfile and a preset together are still refused, as before", () => {
    expect(err("version: 1\npreset: node\ndockerfile: Dockerfile\n")).toMatchObject({ field: "dockerfile" });
  });
});

describe("customer substituters (at most 3, https, host listed in network.domains, key required)", () => {
  it("accepts one and canonicalizes its URL", () => {
    expect(ok(NIX_OK).nix!.substituters).toEqual([{ publicKey: KEY, url: "https://cache.example.com/team" }]);
    const trailing = ok(NIX_OK.replace("/team'", "/team/'").replace("cache.example.com]", "CACHE.example.com]"));
    expect(trailing.nix!.substituters[0]!.url).toBe("https://cache.example.com/team");
  });

  it("is order-insensitive and de-duplicates", () => {
    const a = ok(`version: 1\nnetwork: {domains: [a.example.com, b.example.com]}\nnix:\n  substituters:\n    - {url: 'https://a.example.com', publicKey: '${KEY}'}\n    - {url: 'https://b.example.com', publicKey: '${KEY2}'}\n`);
    const b = ok(`version: 1\nnetwork: {domains: [b.example.com, a.example.com]}\nnix:\n  substituters:\n    - {url: 'https://b.example.com', publicKey: '${KEY2}'}\n    - {publicKey: '${KEY}', url: 'https://a.example.com'}\n    - {url: 'https://a.example.com/', publicKey: '${KEY}'}\n`);
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it("refuses a fourth", () => {
    const hosts = ["a", "b", "c", "d"].map((h) => `${h}.example.com`);
    const list = hosts.map((h) => `    - {url: 'https://${h}', publicKey: '${KEY}'}`).join("\n");
    expect(err(`version: 1\nnetwork: {domains: [${hosts.join(", ")}]}\nnix:\n  substituters:\n${list}\n`)).toMatchObject({ code: "limit_exceeded", field: "nix.substituters" });
    expect(ok(`version: 1\nnetwork: {domains: [${hosts.slice(0, 3).join(", ")}]}\nnix:\n  substituters:\n${list.split("\n").slice(0, 3).join("\n")}\n`).nix!.substituters).toHaveLength(3);
  });

  it.each([
    ["http", "http://cache.example.com"], ["a scheme-less host", "cache.example.com"], ["ftp", "ftp://cache.example.com"], ["credentials", "https://u:p@cache.example.com"],
    ["a port", "https://cache.example.com:8443"], ["a query (a token)", "https://cache.example.com/?token=abc"], ["a fragment", "https://cache.example.com/#x"],
    ["a dotted address", "https://203.0.113.9"], ["a decimal address", "https://3405803785"], ["a bracketed IPv6 address", "https://[2001:db8::1]"],
    ["a host not in network.domains", "https://other.example.com"], ["file", "file:///nix/cache"], ["a javascript URL", "javascript:alert(1)"],
  ])("refuses %s", (_n, url) => {
    const r = parse(`version: 1\nnetwork: {domains: [cache.example.com]}\nnix:\n  substituters:\n    - {url: ${JSON.stringify(url)}, publicKey: '${KEY}'}\n`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe("nix.substituters[0].url");
  });

  it("refuses a substituter when network.domains is absent altogether", () => {
    expect(err(`version: 1\nnix:\n${SUBS}\n`).field).toBe("nix.substituters[0].url");
  });

  it.each(["", "nokey", "name:short", `name:${"A".repeat(43)}`, `name:${"A".repeat(44)}=`, `:${"A".repeat(43)}=`, `a b:${"A".repeat(43)}=`])("refuses the public key %j", (k) => {
    expect(err(`version: 1\nnetwork: {domains: [cache.example.com]}\nnix:\n  substituters:\n    - {url: 'https://cache.example.com', publicKey: ${JSON.stringify(k)}}\n`).field).toBe("nix.substituters[0].publicKey");
  });

  it("requires both url and publicKey, and no other key", () => {
    expect(err(`version: 1\nnetwork: {domains: [cache.example.com]}\nnix:\n  substituters:\n    - {url: 'https://cache.example.com'}\n`).field).toBe("nix.substituters[0].publicKey");
    expect(err(`version: 1\nnetwork: {domains: [cache.example.com]}\nnix:\n  substituters:\n    - {url: 'https://cache.example.com', publicKey: '${KEY}', token: x}\n`)).toMatchObject({ code: "unknown_field" });
  });

  it("both the URL and the key feed envVersionId", () => {
    const id = (url: string, key: string) =>
      envVersionId(ok(`version: 1\nnetwork: {domains: [cache.example.com]}\nnix:\n  substituters:\n    - {url: '${url}', publicKey: '${key}'}\n`), DIGEST, EMPTY_INPUTS_DIGEST);
    const base = id("https://cache.example.com", KEY);
    expect(id("https://cache.example.com/other", KEY)).not.toBe(base);
    expect(id("https://cache.example.com", KEY2)).not.toBe(base);
    expect(envVersionId(ok("version: 1\nnix: {}\nnetwork: {domains: [cache.example.com]}\n"), DIGEST, EMPTY_INPUTS_DIGEST)).not.toBe(base);
  });

  it("undo: removing the substituter returns to the plain nix spec's id", () => {
    const plain = ok("version: 1\nnetwork: {domains: [cache.example.com]}\nnix: {}\n");
    const withSub = ok(NIX_OK);
    expect(envVersionId(withSub, DIGEST, EMPTY_INPUTS_DIGEST)).not.toBe(envVersionId(plain, DIGEST, EMPTY_INPUTS_DIGEST));
    expect(envVersionId({ ...withSub, nix: { ...withSub.nix!, substituters: [] } }, DIGEST, EMPTY_INPUTS_DIGEST)).toBe(envVersionId(plain, DIGEST, EMPTY_INPUTS_DIGEST));
  });
});

describe("the image field takes a sha256 digest and nothing else", () => {
  const D = `sha256:${"b".repeat(64)}`;
  it("accepts a bare digest, keeps it, and it changes the environment", () => {
    const s = ok(`version: 1\nimage: ${D}\n`);
    expect(s.image).toBe(D);
    expect(canonicalize(s)).toContain(`"image":"${D}"`);
    expect(envVersionId(s, DIGEST)).not.toBe(envVersionId(ok(`version: 1\nimage: sha256:${"c".repeat(64)}\n`), DIGEST));
  });

  it.each([
    ["a repository with a digest", `ghcr.io/acme/app@${D}`], ["a short repository with a digest", `acme/app@${D}`], ["a tag", "node:20"], ["a registry reference", "ghcr.io/acme/app:latest"],
    ["a registry host alone", "ghcr.io"], ["an uppercase digest", `sha256:${"B".repeat(64)}`],
  ])("refuses %s as an image_reference", (_n, v) => {
    expect(err(`version: 1\nimage: '${v}'\n`)).toMatchObject({ code: "image_reference", field: "image" });
  });

  it.each([["a short digest", "sha256:abc"], ["a sha1 digest", `sha1:${"a".repeat(40)}`], ["bare hex", "b".repeat(64)], ["an empty string", ""], ["the word latest", "latest"]])(
    "refuses %s",
    (_n, v) => {
      const r = parse(`version: 1\nimage: '${v}'\n`);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.field).toBe("image");
    },
  );

  it("refuses a non-string", () => {
    expect(err("version: 1\nimage: [x]\n").code).toBe("invalid_type");
  });

  it.each([["preset", "preset: node"], ["a Dockerfile", "dockerfile: Dockerfile"], ["nix", "nix: {}"]])("refuses image together with %s", (_n, other) => {
    expect(err(`version: 1\nimage: ${D}\n${other}\n`)).toMatchObject({ code: "invalid_value" });
  });

  it("does not loosen the image-reference refusal anywhere else (a digest in a preset or service is still refused)", () => {
    expect(err(`version: 1\npreset: '${D}'\n`).code).toBe("image_reference");
    expect(err(`version: 1\nservices: ['${D}']\n`).code).toBe("image_reference");
  });
});

describe("NIX_* is refused as an env key (B5: the locked nix.conf must hold)", () => {
  it.each(["NIX_CONFIG", "NIX_USER_CONF_FILES", "NIX_PATH", "NIX_REMOTE", "NIX_SSL_CERT_FILE", "NIX_FOO", "nix_config", "Nix_Path", "NIX_"])("refuses env %s, naming the key and never the value", (k) => {
    const e = err(`version: 1\nenv:\n  ${k}: 'sandbox = false SECRETVALUE'\n`);
    expect(e).toMatchObject({ code: "forbidden_env_name", field: `env.${k}` });
    expect(e.message).not.toContain("SECRETVALUE");
  });

  it("also refuses it as a secret name, which is delivered as an env var", () => {
    expect(err("version: 1\nsecrets:\n  - name: NIX_CONFIG\n")).toMatchObject({ code: "forbidden_env_name", field: "secrets[0].name" });
  });

  it.each(["NIXPKGS_ALLOW_UNFREE", "NIXOS_LABEL", "NIX", "MY_NIX_CACHE", "UNIX_SOCKET", "NODE_ENV"])("still allows %s", (k) => {
    expect(parse(`version: 1\nenv:\n  ${k}: x\n`).ok).toBe(true);
  });

  it("is refused in a nix spec too, and a flake's own settings have no field to ride in", () => {
    expect(err("version: 1\nnix: {}\nenv:\n  NIX_CONFIG: x\n").code).toBe("forbidden_env_name");
  });
});

describe("toolchain-manager variables are refused as env keys and secret names (M-B9)", () => {
  it.each(["MISE_CONFIG_FILE", "MISE_", "mise_experimental", "RUSTUP_DIST_SERVER", "RUSTUP_UPDATE_ROOT", "ASDF_DATA_DIR", "NVM_DIR", "NVM_NODEJS_ORG_MIRROR", "PYENV_ROOT", "NODE_MIRROR", "node_mirror"])("refuses env %s without echoing the value", (k) => {
    const e = err(`version: 1\nenv:\n  ${k}: 'https://evil.example SECRETVALUE'\n`);
    expect(e).toMatchObject({ code: "forbidden_env_name", field: `env.${k}` });
    expect(e.message).not.toContain("SECRETVALUE");
    expect(e.message).toContain("toolchain");
  });

  it("also refuses them as secret names, which are delivered as env vars", () => {
    expect(err("version: 1\nsecrets:\n  - name: RUSTUP_DIST_SERVER\n")).toMatchObject({ code: "forbidden_env_name", field: "secrets[0].name" });
  });

  it.each(["MISE", "NVM", "ASDF", "PYENV", "RUSTUP", "NODE_MIRRORS", "NODE_ENV", "NODE_OPTIONS", "CARGO_HOME", "RUSTFLAGS", "MY_MISE_VAR", "PYTHONPATH"])("still allows %s", (k) => {
    expect(parse(`version: 1\nenv:\n  ${k}: x\n`).ok).toBe(true);
  });
});

// inputsDigest ---------------------------------------------------------------------------------------------

const tree = (over: Record<string, string> = {}): TreeEntry[] =>
  Object.entries({
    "flake.nix": sha("1"), "flake.lock": sha("2"), "nix/shell.nix": sha("3"), "Dockerfile": sha("4"), "README.md": sha("5"), "src/main.rs": sha("6"),
    ".nvmrc": sha("7"), "rust-toolchain.toml": sha("8"), "pins.json": sha("9"), ...over,
  }).map(([path, s]) => ({ path, sha: s }));
const NIX = ok("version: 1\nnix: {}\n");
const DF = ok("version: 1\ndockerfile: Dockerfile\n");
const NODE = ok("version: 1\npreset: node\n");
const RUST = ok("version: 1\npreset: [rust, node]\n");

describe("envVersionId sees the files that define the environment (C3 section 1.4)", () => {
  const id = (s: EnvSpec, t: TreeEntry[]) => envVersionId(s, DIGEST, inputsDigest(s, t));

  it("changing flake.lock changes envVersionId; an unrelated file does not", () => {
    const base = id(NIX, tree());
    expect(id(NIX, tree({ "flake.lock": sha("a") }))).not.toBe(base);
    expect(id(NIX, tree({ "README.md": sha("a"), "src/main.rs": sha("b") }))).toBe(base);
  });

  it("changing any *.nix file, at any depth, changes it", () => {
    const base = id(NIX, tree());
    expect(id(NIX, tree({ "flake.nix": sha("a") }))).not.toBe(base);
    expect(id(NIX, tree({ "nix/shell.nix": sha("a") }))).not.toBe(base);
    expect(id(NIX, tree({ "deep/er/pkgs.nix": sha("a") }))).not.toBe(base);
  });

  it("adding or removing a *.nix file changes it", () => {
    const base = id(NIX, tree());
    expect(id(NIX, [...tree(), { path: "extra.nix", sha: sha("a") }])).not.toBe(base);
    expect(id(NIX, tree().filter((e) => e.path !== "nix/shell.nix"))).not.toBe(base);
  });

  it("a listed nix.inputs file counts, an unlisted one does not", () => {
    const listed = ok("version: 1\nnix: {inputs: [pins.json]}\n");
    expect(id(listed, tree({ "pins.json": sha("a") }))).not.toBe(id(listed, tree()));
    expect(id(NIX, tree({ "pins.json": sha("a") }))).toBe(id(NIX, tree()));
  });

  it("a nested flake reads its own flake.lock, not the root's", () => {
    const sub = ok("version: 1\nnix: {flake: sub}\n");
    const t = (lock: string, root: string) => tree({ "sub/flake.lock": lock, "flake.lock": root });
    expect(id(sub, t(sha("a"), sha("2")))).not.toBe(id(sub, t(sha("b"), sha("2"))));
    expect(id(sub, t(sha("a"), sha("2")))).toBe(id(sub, t(sha("a"), sha("c"))));
  });

  it("changing the Dockerfile changes envVersionId of a dockerfile spec, with no spec edit", () => {
    const base = id(DF, tree());
    expect(id(DF, tree({ Dockerfile: sha("a") }))).not.toBe(base);
    expect(id(DF, tree({ "flake.lock": sha("a"), "README.md": sha("b") }))).toBe(base);
  });

  it("a dockerfile in a subdirectory is tracked by its own path only", () => {
    const sub = ok("version: 1\ndockerfile: .devcontainer/Dockerfile\n");
    const t = (x: string) => [{ path: ".devcontainer/Dockerfile", sha: x }, { path: "Dockerfile", sha: sha("f") }];
    expect(id(sub, t(sha("a")))).not.toBe(id(sub, t(sha("b"))));
    expect(id(sub, [...t(sha("a"))])).toBe(id(sub, [...t(sha("a")).reverse(), { path: "x", sha: sha("1") }]));
  });

  it("a rust preset spec sees rust-toolchain.toml and rust-toolchain; a node-only spec does not", () => {
    const base = id(RUST, tree());
    expect(id(RUST, tree({ "rust-toolchain.toml": sha("a") }))).not.toBe(base);
    expect(id(RUST, [...tree(), { path: "rust-toolchain", sha: sha("a") }])).not.toBe(base);
    expect(id(NODE, tree({ "rust-toolchain.toml": sha("a") }))).toBe(id(NODE, tree()));
  });

  it("preset specs see the version files the builder honours, from the repo root only", () => {
    for (const f of [".nvmrc", ".node-version", ".python-version", ".tool-versions", "mise.toml", ".mise.toml", "mise.lock"]) {
      const without = tree().filter((e) => e.path !== f);
      expect(id(NODE, [...without, { path: f, sha: sha("a") }]), f).not.toBe(id(NODE, without));
    }
    expect(id(NODE, [...tree(), { path: "sub/.nvmrc", sha: sha("a") }])).toBe(id(NODE, tree()));
    expect(id(NODE, tree({ ".nvmrc": sha("a") }))).not.toBe(id(NODE, tree()));
  });

  it("changing mise.lock changes inputsDigest and envVersionId; a nested mise.lock does not", () => {
    const withLock = (x: string) => [...tree(), { path: "mise.lock", sha: sha(x) }];
    expect(inputsDigest(NODE, withLock("a"))).not.toBe(inputsDigest(NODE, withLock("b")));
    expect(id(NODE, withLock("a"))).not.toBe(id(NODE, withLock("b")));
    expect(id(NODE, [...tree(), { path: "sub/mise.lock", sha: sha("a") }])).toBe(id(NODE, tree()));
  });

  it("refuses a nix.inputs entry that is a directory in the tree (blobs only: it would hash nothing)", () => {
    const dirSpec = ok("version: 1\nnix: {inputs: [pins]}\n");
    expect(() => inputsDigest(dirSpec, [...tree(), { path: "pins/a.json", sha: sha("a") }])).toThrow(/directory/);
    expect(() => inputsDigest(dirSpec, [...tree(), { path: "pins", sha: sha("a") }])).not.toThrow();
  });

  it("does not depend on the order of the tree listing", () => {
    expect(id(NIX, tree())).toBe(id(NIX, tree().reverse()));
  });

  it("is stable: the same inputs always give the same 64-hex digest", () => {
    expect(inputsDigest(NIX, tree())).toMatch(/^[0-9a-f]{64}$/);
    expect(inputsDigest(NIX, tree())).toBe(inputsDigest(NIX, tree()));
  });

  it("an environment with no input files in the tree hashes the empty set", () => {
    expect(inputsDigest(NIX, [{ path: "README.md", sha: sha("a") }])).toBe(EMPTY_INPUTS_DIGEST);
    expect(inputsDigest(ok("version: 1\n"), tree())).toBe(EMPTY_INPUTS_DIGEST);
  });

  it("path and sha are not interchangeable (no concatenation ambiguity)", () => {
    const a = [{ path: "a.nix", sha: sha("b") }, { path: "c.nix", sha: sha("d") }];
    const b = [{ path: "a.nix", sha: sha("d") }, { path: "c.nix", sha: sha("b") }];
    expect(inputsDigest(NIX, a)).not.toBe(inputsDigest(NIX, b));
  });

  it("refuses a malformed blob sha, and two different shas for one path", () => {
    expect(() => inputsDigest(NIX, [{ path: "flake.lock", sha: "xyz" }])).toThrow(/blob sha/);
    expect(() => inputsDigest(NIX, [{ path: "flake.lock", sha: sha("A") }])).toThrow(/blob sha/);
    expect(() => inputsDigest(NIX, [{ path: "flake.lock", sha: sha("a") }, { path: "flake.lock", sha: sha("b") }])).toThrow(/twice/);
  });

  it("accepts 64-hex blob shas (a sha256 repository) and ignores a malformed sha on a file it does not hash", () => {
    expect(() => inputsDigest(NIX, [{ path: "flake.lock", sha: "a".repeat(64) }])).not.toThrow();
    expect(() => inputsDigest(NIX, [{ path: "README.md", sha: "junk" }])).not.toThrow();
  });

  it("never matches a path that climbs, is absolute or is empty", () => {
    for (const p of ["../flake.lock", "/flake.lock", "", "a//b.nix", "./flake.lock", "x/../y.nix"]) expect(isInputFile(NIX, p), p).toBe(false);
  });
});

describe("envVersionId(spec, baseDigest, inputsDigest)", () => {
  it("a nix or dockerfile spec cannot be given an id without its inputsDigest", () => {
    expect(() => envVersionId(NIX, DIGEST)).toThrow(/inputsDigest/);
    expect(() => envVersionId(DF, DIGEST)).toThrow(/inputsDigest/);
    expect(() => envVersionId(NODE, DIGEST)).not.toThrow();
    expect(envVersionId(NODE, DIGEST)).toBe(envVersionId(NODE, DIGEST, EMPTY_INPUTS_DIGEST));
  });

  it.each(["", "abc", "A".repeat(64), `sha256:${"a".repeat(64)}`])("refuses the inputsDigest %j", (d) => {
    expect(() => envVersionId(NODE, DIGEST, d)).toThrow(/inputsDigest/);
  });

  it("is sha256(canonical || baseDigest || inputsDigest)", async () => {
    const { createHash } = await import("node:crypto");
    const d = inputsDigest(NIX, tree());
    expect(envVersionId(NIX, DIGEST, d)).toBe(createHash("sha256").update(canonicalize(NIX) + DIGEST + d).digest("hex"));
  });
});
