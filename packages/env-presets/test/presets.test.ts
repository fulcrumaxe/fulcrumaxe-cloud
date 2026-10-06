import { BASE_DIGEST, KNOWN_PRESET_IDS, parse } from "@fx/env-spec";
import { describe, expect, it } from "vitest";
import {
  BASE_SMOKE_COMMANDS, BASE_TOOL_NAMES, DATE_VERSIONED, MISE, MISE_CONFIG, PRESETS, PRESET_IDS, RUSTUP_HOSTS, RUSTUP_INIT,
  RUST_DEFAULT_TOOLCHAIN, SCCACHE,
} from "../src/index.js";

const FROZEN_IDS = ["rust", "go", "jvm", "dotnet", "ruby", "php", "cpp", "node", "python"];

describe("criterion 1 and 7: exactly nine presets, ids exported", () => {
  it("PRESET_IDS equals the frozen list and PRESETS carries the same ids in order", () => {
    expect([...PRESET_IDS]).toEqual(FROZEN_IDS);
    expect(PRESETS.map((p) => p.id)).toEqual(FROZEN_IDS);
  });

  it("env-spec's copy of the ids (it cannot import this package) is the same list in the same order", () => {
    expect([...KNOWN_PRESET_IDS]).toEqual([...PRESET_IDS]);
  });

  it("every id is accepted by env-spec's `preset` field", () => {
    for (const id of PRESET_IDS) {
      const r = parse(`version: 1\npreset: ${id}\n`);
      expect(r.ok, id).toBe(true);
    }
  });
});

describe("criterion 2: one toolchain per layer", () => {
  it("declares layers explicitly, and no layer installs more than one toolchain", () => {
    for (const p of PRESETS) {
      expect(p.layers.length, p.id).toBeGreaterThan(1);
      for (const l of p.layers) expect(l.toolchains.length, `${p.id}/${l.id}`).toBeLessThanOrEqual(1);
    }
  });

  it("exempts sandbox-base from the one-toolchain rule by name: it declares none and holds the laptop basics", () => {
    for (const p of PRESETS) {
      const base = p.layers[0]!;
      expect(base.id, p.id).toBe("sandbox-base");
      expect(base.toolchains, p.id).toEqual([]);
      expect(base.aptPackages.length, p.id).toBeGreaterThan(1);
    }
  });

  it("each preset installs exactly one toolchain, after the shared sandbox-base layer", () => {
    for (const p of PRESETS) {
      expect(p.layers[0]!.id, p.id).toBe("sandbox-base");
      expect(p.layers.flatMap((l) => l.toolchains).length, p.id).toBe(1);
    }
  });

  it("pins every toolchain package to a version glob, never a bare name", () => {
    for (const p of PRESETS) for (const l of p.layers.filter((x) => x.toolchains.length > 0))
      for (const pkg of l.aptPackages) expect(pkg, `${p.id}/${l.id}`).toMatch(/^[a-z0-9+.-]+=\S*\d\S*$/);
  });
});

describe("criterion 3: smokeCommand is an argv array", () => {
  it("is a non-empty array of non-empty strings, never a string", () => {
    for (const p of PRESETS) {
      expect(Array.isArray(p.smokeCommand), p.id).toBe(true);
      expect(p.smokeCommand.length, p.id).toBeGreaterThan(0);
      for (const a of p.smokeCommand) expect(typeof a === "string" && a.length > 0, p.id).toBe(true);
      expect(p.smokeCommand[0], p.id).not.toMatch(/\s/);
    }
  });
});

describe("criterion 4: base pinned by digest", () => {
  it("is <repo>@sha256:<64 hex> for every preset -- a tag-only reference fails", () => {
    for (const p of PRESETS) {
      const [repo, digest, ...rest] = p.base.split("@");
      expect(rest, p.id).toEqual([]);
      expect(repo, p.id).toMatch(/^[a-z0-9./-]+$/);
      expect(digest, p.id).toMatch(BASE_DIGEST);
    }
  });

  it("runs as the ubuntu user in /vercel, as the sandbox base sets up", () => {
    for (const p of PRESETS) expect(p.runtime).toEqual({ user: "ubuntu", home: "/vercel", workdir: "/vercel" });
  });
});

describe("criterion 5: presets are frozen plain data", () => {
  const walk = (v: unknown, at: string, visit: (v: unknown, at: string) => void): void => {
    visit(v, at);
    if (v !== null && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${at}.${k}`, visit);
  };

  it("is deeply frozen, with no functions and only plain objects and arrays", () => {
    walk(PRESETS, "PRESETS", (v, at) => {
      expect(typeof v, at).not.toBe("function");
      if (v !== null && typeof v === "object") {
        expect(Object.isFrozen(v), at).toBe(true);
        const proto = Object.getPrototypeOf(v);
        expect(proto === Object.prototype || proto === Array.prototype, at).toBe(true);
      }
    });
  });

  it("survives a JSON round trip unchanged", () => {
    expect(JSON.parse(JSON.stringify(PRESETS))).toEqual(PRESETS);
  });
});

const pkgName = (p: string): string => p.slice(0, p.indexOf("="));
const allPins = () => PRESETS.flatMap((p) => p.layers.flatMap((l) => l.aptPackages.map((pkg) => [`${p.id}/${l.id}`, pkg] as const)));

describe("E3-2: laptop basics in sandbox-base", () => {
  it("holds exactly git, curl, ca-certificates, build-essential, jq, unzip and openssh-client (plus the sandbox's sudo)", () => {
    expect([...BASE_TOOL_NAMES].sort()).toEqual(["build-essential", "ca-certificates", "curl", "git", "jq", "openssh-client", "unzip"]);
    for (const p of PRESETS) {
      expect(p.layers[0]!.aptPackages.map((x) => (x.includes("=") ? pkgName(x) : x)).sort(), p.id).toEqual([...BASE_TOOL_NAMES, "sudo"].sort());
    }
  });

  it("pins each of the seven to a version glob", () => {
    for (const p of PRESETS) for (const pkg of p.layers[0]!.aptPackages.filter((x) => x.includes("=")))
      expect(pkg, p.id).toMatch(/^[a-z0-9+.-]+=\S*\d\S*\*$/);
    expect(PRESETS[0]!.layers[0]!.aptPackages.filter((x) => !x.includes("="))).toEqual(["sudo"]);
  });

  it("gives every preset a smoke set of its toolchain command plus the six basics", () => {
    expect(BASE_SMOKE_COMMANDS).toEqual([["git", "--version"], ["curl", "--version"], ["jq", "--version"], ["ssh", "-V"], ["make", "--version"], ["unzip", "-v"]]);
    for (const p of PRESETS) {
      expect(p.smokeCommands[0], p.id).toEqual(p.smokeCommand);
      for (const c of BASE_SMOKE_COMMANDS) expect(p.smokeCommands, p.id).toContainEqual(c);
    }
  });
});

describe("E3-2: no apt glob lacks a separator, and none is major-only", () => {
  it("has a non-digit before every `*`, except the named date-versioned package", () => {
    for (const [where, pkg] of allPins()) {
      if (!pkg.includes("*")) continue;
      if (DATE_VERSIONED.includes(pkgName(pkg))) continue;
      expect(pkg, where).toMatch(/[^0-9]\*$/);
    }
  });

  it("names exactly one date-versioned exception, ca-certificates", () => {
    expect(DATE_VERSIONED).toEqual(["ca-certificates"]);
    const pins = allPins().map(([, p]) => p).filter((p) => p.startsWith("ca-certificates"));
    expect(pins.length).toBeGreaterThan(0);
    expect(pins.every((p) => /^ca-certificates=\d{4}\*$/.test(p))).toBe(true);
  });

  it("is at least major.minor for every versioned package (epoch aside)", () => {
    for (const [where, pkg] of allPins()) {
      if (!pkg.includes("=") || DATE_VERSIONED.includes(pkgName(pkg))) continue;
      const v = pkg.slice(pkg.indexOf("=") + 1).replace(/^\d+:/, "");
      expect(v, where).toMatch(/^\d+\.\d+/);
    }
  });

  it("tightens the major-only and separator-less globs the #326 review named", () => {
    const pins = allPins().map(([, p]) => p);
    for (const old of ["nodejs=22.*", "openjdk-25-jdk-headless=25.*", "g++=4:15.*", "golang-go=2:1.26*", "ruby=1:3.3*", "php-cli=2:8.5*"])
      expect(pins, old).not.toContain(old);
  });
});

describe("E3-2: Rust through rustup, not apt", () => {
  const rust = PRESETS.find((p) => p.id === "rust")!.layers[1]!;
  const flat = (a: readonly (readonly string[])[]) => a.map((x) => x.join(" "));

  it("installs no apt rustc or cargo", () => {
    expect(rust.aptPackages).toEqual([]);
  });

  it("pins rustup-init by sha256 and checks it before running it", () => {
    expect(RUSTUP_INIT.sha256).toMatch(/^[0-9a-f]{64}$/);
    const sums = rust.files.find((f) => f.path.endsWith("rustup-init.sha256"))!;
    expect(sums.content).toBe(`${RUSTUP_INIT.sha256}  /tmp/rustup-init\n`);
    const steps = flat(rust.steps);
    const check = steps.findIndex((s) => s.startsWith("sha256sum --check") && s.includes("rustup-init.sha256"));
    const run = steps.findIndex((s) => s.startsWith("/tmp/rustup-init "));
    expect(check).toBeGreaterThanOrEqual(0);
    expect(run).toBeGreaterThan(check);
    expect(steps.some((s) => s.startsWith("curl") && s.includes(RUSTUP_INIT.url))).toBe(true);
  });

  it("installs an exact default version, never the moving `stable`", () => {
    expect(RUST_DEFAULT_TOOLCHAIN).toMatch(/^\d+\.\d+\.\d+$/);
    const run = rust.steps.find((s) => s[0] === "/tmp/rustup-init")!;
    expect(run[run.indexOf("--default-toolchain") + 1]).toBe(RUST_DEFAULT_TOOLCHAIN);
    expect(JSON.stringify(rust.steps)).not.toMatch(/\bstable\b|\bnightly\b|\bbeta\b/);
  });

  it("fixes the distribution hosts to the Rust project's own origin", () => {
    expect(rust.env).toMatchObject(RUSTUP_HOSTS);
    expect(RUSTUP_HOSTS.RUSTUP_DIST_SERVER).toBe("https://static.rust-lang.org");
    expect(RUSTUP_HOSTS.RUSTUP_UPDATE_ROOT).toBe("https://static.rust-lang.org/rustup");
  });

  it("puts cargo first on PATH and keeps rustup out of the shell profile", () => {
    expect(rust.env!.PATH!.split(":")[0]).toMatch(/\/cargo\/bin$/);
    expect(flat(rust.steps).some((s) => s.includes("--no-modify-path"))).toBe(true);
  });
});

describe("E3-2: sccache and mise pinned by sha256", () => {
  const rust = PRESETS.find((p) => p.id === "rust")!.layers[1]!;
  const cpp = PRESETS.find((p) => p.id === "cpp")!.layers[1]!;

  it.each([["rust", rust], ["cpp", cpp]] as const)("%s verifies the sccache tarball before extracting it", (_id, layer) => {
    expect(SCCACHE.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(layer.files.find((f) => f.path.endsWith("sccache.sha256"))!.content).toBe(`${SCCACHE.sha256}  /tmp/sccache.tar.gz\n`);
    const steps = layer.steps.map((s) => s.join(" "));
    const check = steps.findIndex((s) => s.startsWith("sha256sum --check") && s.includes("sccache.sha256"));
    const extract = steps.findIndex((s) => s.startsWith("tar "));
    expect(check).toBeGreaterThanOrEqual(0);
    expect(extract).toBeGreaterThan(check);
    expect(steps.some((s) => s.startsWith("curl") && s.includes(SCCACHE.url))).toBe(true);
  });

  it("installs sccache only in the rust and cpp presets, and smoke-tests it there", () => {
    for (const p of PRESETS) {
      const has = p.layers.some((l) => l.steps.some((s) => s.join(" ").includes("sccache")));
      expect(has, p.id).toBe(p.id === "rust" || p.id === "cpp");
      expect(p.smokeCommands.some((c) => c[0] === "sccache"), p.id).toBe(has);
    }
  });

  it("pins mise by sha256 in data, and no preset layer installs it", () => {
    expect(MISE.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(MISE.url).toContain(`v${MISE.version}/`);
    expect(JSON.stringify(PRESETS)).not.toMatch(/mise/i);
  });

  it("downloads every pin over https", () => {
    for (const pin of [RUSTUP_INIT, SCCACHE, MISE]) expect(pin.url).toMatch(/^https:\/\//);
  });

  it("locks the mise config to exactly the honoured version files, and leaves rust-toolchain to rustup", () => {
    expect(Object.keys(MISE_CONFIG.versionFiles).sort()).toEqual([".mise.toml", ".node-version", ".nvmrc", ".python-version", ".tool-versions", "mise.toml"]);
    expect(Object.keys(MISE_CONFIG.versionFiles).some((f) => f.includes("rust-toolchain"))).toBe(false);
  });

  it("never lets mise install on demand or skip provenance checks", () => {
    expect(MISE_CONFIG.settings).toEqual({ not_found_auto_install: false, paranoid: true, gpg_verify: true });
  });
});
