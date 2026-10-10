import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkNpmLock, checkNpmrc, checkPnpmLock, checkWorkspaceYaml } from "../src/job/lockfileCheck.js";
import { PACKAGE_DIR } from "./helpers/srcFiles.js";

/** D#6 C44-4: the fail-closed pre-check of a hostile repo's lockfile and package-manager settings. Each refusal names a closed reason and nothing from the repo. */
const HOST = "registry.npmjs.org";
const SHA = "sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQGinBN9yTQT3bFlCBy/aVx2HrNcqQGsdot8ghrjyrvMCoEA==";

const pnpm = (packages: string, importers = "  .:\n    dependencies:\n      left-pad:\n        specifier: ^1.3.0\n        version: 1.3.0\n"): string =>
  `lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n\nimporters:\n\n${importers}\npackages:\n\n${packages}\nsnapshots:\n\n  left-pad@1.3.0: {}\n`;
const entry = (resolution: string, extra = ""): string => `  left-pad@1.3.0:\n    resolution: ${resolution}\n${extra}`;
const refusal = (text: string, reason: string) => expect(checkPnpmLock(text, HOST)).toEqual({ ok: false, reason });

describe("checkPnpmLock", () => {
  it("accepts the shape pnpm writes: registry packages with integrity, in either resolution style", () => {
    expect(checkPnpmLock(pnpm(entry(`{integrity: ${SHA}}`, "    deprecated: use String.prototype.padStart(), see https://example.com/x\n")), HOST)).toEqual({ ok: true, projects: ["."] });
    expect(checkPnpmLock(pnpm(entry(`\n      integrity: ${SHA}\n      tarball: https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz`)), HOST).ok).toBe(true);
  });

  it("accepts this repository's own lockfile (a real workspace with link: projects)", () => {
    const real = readFileSync(path.join(PACKAGE_DIR, "..", "..", "pnpm-lock.yaml"), "utf8");
    const verdict = checkPnpmLock(real, HOST);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.projects).toContain("apps/gh-proxy");
  });

  it("a tarball on another host is refused, and so is one with a user, a password, a port or a different scheme", () => {
    for (const url of ["https://evil.example/left-pad-1.3.0.tgz", "https://registry.npmjs.org.evil.example/x.tgz"]) {
      refusal(pnpm(entry(`{integrity: ${SHA}, tarball: ${url}}`)), "other_host_tarball");
    }
    for (const url of ["http://registry.npmjs.org/x.tgz", "https://u:p@registry.npmjs.org/x.tgz", "https://registry.npmjs.org:8443/x.tgz", "ftp://registry.npmjs.org/x.tgz", "https://registry.npmjs.org@evil.example/x.tgz"]) {
      refusal(pnpm(entry(`{integrity: ${SHA}, tarball: ${url}}`)), "unsafe_dependency");
    }
  });

  it("a git, directory or other resolution kind is refused, even with an integrity hash beside it", () => {
    refusal(pnpm(entry("{commit: 0123456789abcdef0123456789abcdef01234567, repo: https://registry.npmjs.org/x.git, type: git}")), "unsafe_dependency");
    refusal(pnpm(entry(`{directory: ../elsewhere, type: directory, integrity: ${SHA}}`)), "unsafe_dependency");
  });

  it("a git, file, ssh, http or hosted-shorthand dependency anywhere in the file is refused", () => {
    for (const version of ["git+https://github.com/a/b.git#abc", "file:../x.tgz", "github:a/b", "ssh://git@github.com/a/b.git", "http://registry.npmjs.org/x", "git+ssh://git@github.com/a/b.git", "portal:../x", "exec:./gen.js", "jsr:@a/b"]) {
      refusal(pnpm(entry(`{integrity: ${SHA}}`), `  .:\n    dependencies:\n      left-pad:\n        specifier: ${version}\n        version: ${version}\n`), "unsafe_dependency");
    }
    refusal(pnpm(entry(`{integrity: ${SHA}}`), `  .:\n    dependencies:\n      left-pad:\n        specifier: "file:../x"\n        version: 1.3.0\n`), "unsafe_dependency");
  });

  it("a package that is merely called file, git or http is not a dependency kind", () => {
    const importers = "  .:\n    dependencies:\n      file:\n        specifier: ^1.0.0\n        version: 1.0.0\n      http:\n        specifier: ^1.0.0\n        version: 1.0.0\n";
    expect(checkPnpmLock(pnpm(entry(`{integrity: ${SHA}}`), importers), HOST).ok).toBe(true);
  });

  it("a link: is allowed only between projects of the repo; one that leaves the repo, or sits outside importers, is refused", () => {
    const inRepo = "  .:\n    dependencies:\n      a:\n        specifier: workspace:*\n        version: link:packages/a\n\n  packages/a:\n    dependencies:\n      b:\n        specifier: workspace:*\n        version: link:../b\n";
    expect(checkPnpmLock(pnpm(entry(`{integrity: ${SHA}}`), inRepo), HOST)).toEqual({ ok: true, projects: [".", "packages/a"] });
    refusal(pnpm(entry(`{integrity: ${SHA}}`), "  .:\n    dependencies:\n      a:\n        specifier: link:../outside\n        version: link:../outside\n"), "unsafe_dependency");
    refusal(pnpm(entry(`{integrity: ${SHA}}`), "  packages/a:\n    dependencies:\n      a:\n        version: link:../../../etc\n"), "unsafe_dependency");
    refusal(pnpm(entry(`{integrity: ${SHA}}`), "  .:\n    dependencies:\n      a:\n        version: link:/etc\n"), "unsafe_dependency");
    refusal(pnpm(entry(`{integrity: ${SHA}}`) + "  other@1.0.0:\n    resolution: {integrity: " + SHA + "}\n    dependencies:\n      x: link:./local\n"), "unsafe_dependency");
  });

  it("an importer path that leaves the repo is refused", () => {
    refusal(pnpm(entry(`{integrity: ${SHA}}`), "  ../outside:\n    dependencies: {}\n"), "unsafe_dependency");
    refusal(pnpm(entry(`{integrity: ${SHA}}`), "  /etc:\n    dependencies: {}\n"), "unsafe_dependency");
  });

  it("an integrity hash is required for every package, and must have the shape of one", () => {
    refusal(pnpm(entry("{tarball: https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz}")), "integrity_missing");
    refusal(pnpm(entry("{integrity: not-a-hash}")), "integrity_missing");
    refusal(pnpm("  left-pad@1.3.0:\n    engines: {node: '>=0.10'}\n"), "integrity_missing");
    refusal(pnpm(entry(`{integrity: ${SHA}}`) + "  other@1.0.0:\n    engines: {node: '>=1'}\n"), "integrity_missing");
  });

  it("text it cannot place is refused: control characters, a stray scalar, an unclosed flow map, a plain-scalar resolution, a second document", () => {
    refusal(pnpm(entry(`{integrity: ${SHA}}`)) + "\u0000", "lockfile_unparsable");
    refusal(pnpm(entry(`{integrity: ${SHA}}`)) + "stray line\n", "lockfile_unparsable");
    refusal(pnpm(entry(`{integrity: ${SHA}`)), "lockfile_unparsable");
    refusal(pnpm(entry("integrity")), "integrity_missing");
    refusal(pnpm(entry(`{integrity: ${SHA}}`)) + "---\nlockfileVersion: '9.0'\n", "lockfile_unparsable");
    expect(checkPnpmLock("", HOST).ok).toBe(true);
  });

  // The bypasses the security review reproduced against real pnpm 11 (each passed the earlier line scanner).
  describe("regression: forms a line scanner could not see", () => {
    const body = (text: string): string => text.split("\n").map((line) => (line === "" ? "" : `    ${line}`)).join("\n");

    it("an indented document (the whole lockfile under one more level)", () => {
      const other = pnpm(entry(`{integrity: ${SHA}, tarball: https://evil.invalid/left-pad.tgz}`));
      refusal(`root:\n${body(other)}`, "lockfile_unparsable");
      // The whole document shifted by a constant is the same document to a YAML parser, and is judged on what it says.
      refusal(` ${other.split("\n").join("\n ")}`, "other_host_tarball");
      refusal(other, "other_host_tarball");
    });

    it("a flow-map packages: and flow-style entries", () => {
      const flow = `lockfileVersion: '9.0'\nimporters: {".": {dependencies: {left-pad: {specifier: ^1.3.0, version: 1.3.0}}}}\npackages: {left-pad@1.3.0: {resolution: {integrity: ${SHA}, tarball: "https://evil.invalid/left-pad.tgz"}}}\nsnapshots: {left-pad@1.3.0: {}}\n`;
      refusal(flow, "other_host_tarball");
      refusal(flow.replace('tarball: "https://evil.invalid/left-pad.tgz"', "commit: abc"), "unsafe_dependency");
      expect(checkPnpmLock(flow.replace(', tarball: "https://evil.invalid/left-pad.tgz"', ""), HOST).ok).toBe(true);
    });

    it("a link: or file: on a continuation line, in a folded scalar, in a quoted or escaped scalar", () => {
      const withVersion = (version: string) => pnpm(entry(`{integrity: ${SHA}}`), `  .:\n    dependencies:\n      left-pad:\n        specifier: ^1.3.0\n        version: ${version}\n`);
      for (const version of ["link:\n          ../../../outside", ">-\n          link:../../../outside", "|\n          link:../../../outside", '"link:\n          ../../../outside"', '"\\x6cink:../../../outside"', ">-\n          file:../x.tgz", "'file:\n          ../x.tgz'", '"fil\\u0065:../x.tgz"']) {
        const verdict = checkPnpmLock(withVersion(version), HOST);
        expect(verdict.ok, version).toBe(false);
        expect(["unsafe_dependency", "lockfile_unparsable"], version).toContain(verdict.ok ? "" : verdict.reason);
      }
      // In-repo links through the same forms are still allowed.
      expect(checkPnpmLock(withVersion(">-\n          link:./packages/a"), HOST).ok).toBe(true);
    });

    it("anchors, aliases, merge keys, custom tags and duplicate keys", () => {
      const anchored = pnpm(entry(`{integrity: ${SHA}}`)).replace("importers:", "importers: &a").replace("snapshots:\n", "snapshots: *a\n");
      refusal(anchored, "lockfile_unparsable");
      // An alias that would otherwise be harmless: only the no-anchors rule refuses it.
      refusal(pnpm(entry(`{integrity: ${SHA}}`)).replace("autoInstallPeers: true", "autoInstallPeers: &t true") + "overrides:\n  x: *t\n", "lockfile_unparsable");
      refusal(pnpm(entry(`{integrity: ${SHA}}`)).replace("settings:", "settings: !!js/function 'x'\nxsettings:"), "lockfile_unparsable");
      refusal(pnpm(entry(`{integrity: ${SHA}}`)).replace("settings:\n", "settings:\n  <<: {autoInstallPeers: true}\n"), "lockfile_unparsable");
      refusal(pnpm(entry(`{integrity: ${SHA}}`)).replace("importers:", "snapshots: {}\nimporters:"), "lockfile_unparsable");
    });

    it("keys it does not know, at the top, in a package, in a snapshot, in an importer and in settings", () => {
      refusal(pnpm(entry(`{integrity: ${SHA}}`)) + "registries: {default: 'https://evil.invalid/'}\n", "lockfile_unparsable");
      refusal(pnpm(entry(`{integrity: ${SHA}}`, "    directory: ../x\n")), "unsafe_dependency");
      refusal(pnpm(entry(`{integrity: ${SHA}}`)).replace("left-pad@1.3.0: {}", "left-pad@1.3.0:\n    resolution: {tarball: https://registry.npmjs.org/x.tgz}"), "unsafe_dependency");
      refusal(pnpm(entry(`{integrity: ${SHA}}`), "  .:\n    hooks: x\n"), "unsafe_dependency");
      refusal(pnpm(entry(`{integrity: ${SHA}}`)).replace("autoInstallPeers: true", "virtualStoreDir: /abs"), "lockfile_unparsable");
    });

    // Round 2: a key NAME must never grant an exemption. `deprecated` is free text only at packages.<entry>.deprecated.
    describe("no key name earns an exemption (a dependency called deprecated, resolution, tarball, integrity or engines)", () => {
      const snap = (name: string, value: string): string =>
        pnpm(entry(`{integrity: ${SHA}}`)).replace("left-pad@1.3.0: {}", `left-pad@1.3.0:\n    dependencies:\n      ${name}: ${value}`);
      const imp = (name: string, version: string): string => pnpm(entry(`{integrity: ${SHA}}`), `  .:\n    dependencies:\n      ${name}:\n        specifier: ^1.0.0\n        version: ${version}\n`);
      const pkg = (name: string, value: string): string => pnpm(entry(`{integrity: ${SHA}}`, `    dependencies:\n      ${name}: ${value}\n`));
      const NAMES = ["deprecated", "resolution", "tarball", "integrity", "engines"];

      it("a snapshot dependency with a link out of the repo (the reviewer's case), a file, a URL or a git form is refused under every such name", () => {
        for (const name of NAMES) {
          for (const value of ["link:../outside", "link:../../outside", "file:../x.tgz", "https://evil.invalid/x.tgz", "git+ssh://git@github.com/a/b.git", "'link:../outside'"]) {
            refusal(snap(name, value), "unsafe_dependency");
            refusal(pkg(name, value), "unsafe_dependency");
          }
        }
        // A link is never allowed in a snapshot or a package, even to a place inside the repo: only an importer links.
        refusal(snap("deprecated", "link:./inside"), "unsafe_dependency");
        refusal(imp("deprecated", "link:../../outside"), "unsafe_dependency");
        refusal(imp("tarball", "link:../../outside"), "unsafe_dependency");
      });

      it("the same names with an ordinary version are fine", () => {
        for (const name of NAMES) {
          expect(checkPnpmLock(snap(name, "1.0.0"), HOST).ok, name).toBe(true);
          expect(checkPnpmLock(pkg(name, "1.0.0"), HOST).ok, name).toBe(true);
          expect(checkPnpmLock(imp(name, "1.0.0"), HOST).ok, name).toBe(true);
        }
        expect(checkPnpmLock(imp("deprecated", "link:./packages/a"), HOST).ok).toBe(true);
      });

      it("deprecated free text is accepted only at packages.<entry>.deprecated, and only as a string", () => {
        expect(checkPnpmLock(pnpm(entry(`{integrity: ${SHA}}`, "    deprecated: link:../outside see https://example.com/x file:../y\n")), HOST).ok).toBe(true);
        refusal(pnpm(entry(`{integrity: ${SHA}}`, "    deprecated: [a]\n")), "lockfile_unparsable");
        refusal(pnpm(entry(`{integrity: ${SHA}}`)).replace("left-pad@1.3.0: {}", "left-pad@1.3.0:\n    deprecated: link:../outside"), "unsafe_dependency");
        refusal(pnpm(entry(`{integrity: ${SHA}}`), "  .:\n    deprecated: link:../outside\n"), "unsafe_dependency");
        refusal(pnpm(entry(`{integrity: ${SHA}}`)) + "overrides:\n  deprecated: link:../outside\n", "unsafe_dependency");
        refusal(pnpm(entry(`{integrity: ${SHA}}`)) + "deprecated: link:../outside\n", "lockfile_unparsable");
      });

      it("a value of the wrong kind for its position is refused", () => {
        refusal(snap("x", "[a, b]"), "lockfile_unparsable");
        refusal(snap("x", "{a: b}"), "lockfile_unparsable");
        refusal(pnpm(entry(`{integrity: ${SHA}}`)).replace("left-pad@1.3.0: {}", "left-pad@1.3.0:\n    optional: link:../outside"), "lockfile_unparsable");
        refusal(pnpm(entry(`{integrity: ${SHA}}`, "    engines: [node]\n")), "lockfile_unparsable");
        refusal(pnpm(entry(`{integrity: ${SHA}}`, "    cpu: {a: b}\n")), "lockfile_unparsable");
        refusal(pnpm(entry(`{integrity: ${SHA}}`)).replace("version: 1.3.0\n", "version: {a: link:../../outside}\n"), "lockfile_unparsable");
      });
    });

    it("round 3: a patchedDependencies entry with no path, a non-string path or an outside path is a closed refusal, never a thrown error", () => {
      const withPatched = (patched: string): string => pnpm(entry(`{integrity: ${SHA}}`)) + `patchedDependencies:\n${patched}`;
      for (const patched of ["  left-pad: {hash: abc}\n", "  left-pad: {}\n", "  left-pad: {path: 3, hash: abc}\n", "  left-pad: {path: ../outside.patch, hash: abc}\n", "  left-pad: {path: [a], hash: abc}\n"]) {
        expect(() => checkPnpmLock(withPatched(patched), HOST), patched).not.toThrow();
        expect(checkPnpmLock(withPatched(patched), HOST).ok, patched).toBe(false);
      }
      expect(checkPnpmLock(withPatched("  left-pad: {path: patches/left-pad.patch, hash: abc}\n"), HOST).ok).toBe(true);
    });

    it("hostile shapes at every position never throw: each is ok or a closed refusal", () => {
      const base = pnpm(entry(`{integrity: ${SHA}}`));
      const hostile = ["importers: [a]\n", "importers: {a: 3}\n", "importers: {'.': [x]}\n", "packages: [a]\n", "packages: {a: null}\n", "packages: {a: {resolution: 3}}\n", "snapshots: {a: null}\n", "snapshots: 3\n", "settings: 3\n", "overrides: [a]\n", "catalogs: {a: 3}\n", "time: {a: [b]}\n", "patchedDependencies: 3\n", "patchedDependencies: {a: null}\n", "lockfileVersion: [1]\n"];
      for (const extra of hostile) {
        const text = extra.startsWith("importers") || extra.startsWith("packages") || extra.startsWith("snapshots") || extra.startsWith("settings") || extra.startsWith("lockfileVersion") ? base.replace(/^(importers|packages|snapshots|settings):[\s\S]*?(?=^\S|$(?![\s\S]))/gm, "") + extra : base + extra;
        expect(() => checkPnpmLock(text, HOST), extra).not.toThrow();
      }
      for (const lock of ['{"packages": {"": null}}', '{"packages": {"node_modules/x": {"link": true}}}', '{"packages": {"node_modules/x": {"inBundle": true, "resolved": 3}}}', '{"packages": {"a": {"dependencies": [1]}}}']) expect(() => checkNpmLock(lock, HOST), lock).not.toThrow();
    });

    it("a URL or a git form in a dependency key, an override or a catalog", () => {
      refusal(pnpm(entry(`{integrity: ${SHA}}`)) + "overrides:\n  left-pad: https://registry.npmjs.org/x.tgz\n", "unsafe_dependency");
      refusal(pnpm(entry(`{integrity: ${SHA}}`)) + "catalogs:\n  default:\n    x:\n      specifier: git+ssh://git@github.com/a/b.git\n      version: 1.0.0\n", "unsafe_dependency");
      refusal(pnpm(entry(`{integrity: ${SHA}}`).replace("left-pad@1.3.0:", "left-pad@https://evil.invalid/x.tgz:")), "unsafe_dependency");
    });
  });
});

const npmLock = (packages: Record<string, unknown>): string => JSON.stringify({ name: "x", lockfileVersion: 3, packages: { "": { name: "x" }, ...packages } });
const good = { resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz", integrity: SHA };

describe("checkNpmLock", () => {
  it("accepts registry packages with integrity, bundled packages, in-repo workspace links and members", () => {
    const text = npmLock({
      "node_modules/left-pad": good,
      "node_modules/left-pad/node_modules/inner": { inBundle: true },
      "node_modules/a": { resolved: "packages/a", link: true },
      "packages/a": { name: "a" },
    });
    expect(checkNpmLock(text, HOST)).toEqual({ ok: true, projects: ["packages/a", "packages/a"] });
  });

  it("other-host, non-https, git and credentialed resolutions are refused", () => {
    expect(checkNpmLock(npmLock({ "node_modules/x": { ...good, resolved: "https://evil.example/x.tgz" } }), HOST)).toEqual({ ok: false, reason: "other_host_tarball" });
    for (const resolved of ["git+ssh://git@github.com/a/b.git#abc", "file:../x.tgz", "http://registry.npmjs.org/x.tgz", "https://u:p@registry.npmjs.org/x.tgz", "github:a/b"]) {
      expect(checkNpmLock(npmLock({ "node_modules/x": { ...good, resolved } }), HOST), resolved).toEqual({ ok: false, reason: "unsafe_dependency" });
    }
  });

  it("a link that leaves the repo, a missing resolved, and a missing or malformed integrity are refused", () => {
    expect(checkNpmLock(npmLock({ "node_modules/x": { resolved: "../../etc", link: true } }), HOST)).toEqual({ ok: false, reason: "unsafe_dependency" });
    expect(checkNpmLock(npmLock({ "node_modules/x": { resolved: "/etc", link: true } }), HOST)).toEqual({ ok: false, reason: "unsafe_dependency" });
    expect(checkNpmLock(npmLock({ "node_modules/x": { integrity: SHA } }), HOST)).toEqual({ ok: false, reason: "integrity_missing" });
    expect(checkNpmLock(npmLock({ "node_modules/x": { resolved: good.resolved } }), HOST)).toEqual({ ok: false, reason: "integrity_missing" });
    expect(checkNpmLock(npmLock({ "node_modules/x": { ...good, integrity: "md5-abc" } }), HOST)).toEqual({ ok: false, reason: "integrity_missing" });
    expect(checkNpmLock(npmLock({ "../escape": { name: "e" } }), HOST)).toEqual({ ok: false, reason: "unsafe_dependency" });
  });

  it("an inBundle entry is accepted only inside a parent and with no download of its own; keys outside the repo and unknown keys are refused", () => {
    expect(checkNpmLock(npmLock({ "node_modules/x": { inBundle: true } }), HOST)).toEqual({ ok: false, reason: "unsafe_dependency" });
    expect(checkNpmLock(npmLock({ "node_modules/a": good, "node_modules/a/node_modules/x": { inBundle: true, resolved: "https://evil.invalid/x.tgz" } }), HOST)).toEqual({ ok: false, reason: "unsafe_dependency" });
    expect(checkNpmLock(npmLock({ "node_modules/a": good, "node_modules/a/node_modules/x": { inBundle: true } }), HOST).ok).toBe(true);
    expect(checkNpmLock(npmLock({ "/abs/node_modules/x": good }), HOST)).toEqual({ ok: false, reason: "unsafe_dependency" });
    expect(checkNpmLock(npmLock({ "node_modules/x": { ...good, registry: "https://evil.invalid/" } }), HOST)).toEqual({ ok: false, reason: "unsafe_dependency" });
    expect(checkNpmLock(JSON.stringify({ lockfileVersion: 3, hooks: {}, packages: {} }), HOST)).toEqual({ ok: false, reason: "lockfile_unparsable" });
    expect(checkNpmLock(npmLock({ "node_modules/x": { ...good, dependencies: { y: "git+ssh://git@github.com/a/b.git" } } }), HOST)).toEqual({ ok: false, reason: "unsafe_dependency" });
  });

  it("text that is not a version 2 or 3 lockfile is refused", () => {
    for (const text of ["", "{", "[]", "null", JSON.stringify({ lockfileVersion: 1, dependencies: {} }), JSON.stringify({ packages: [] })]) {
      expect(checkNpmLock(text, HOST), text).toEqual({ ok: false, reason: "lockfile_unparsable" });
    }
  });
});

describe("checkNpmrc", () => {
  const url = "https://registry.npmjs.org/";
  it("accepts comments, harmless keys and the pinned registry", () => {
    expect(checkNpmrc("# comment\n; other\n\nregistry=https://registry.npmjs.org\nauto-install-peers=true\nnode-linker = hoisted\npublic-hoist-pattern[]=*eslint*\n", url).ok).toBe(true);
    expect(checkNpmrc("", url).ok).toBe(true);
  });

  it("anything that could move the registry, add auth or enable scripts is refused", () => {
    const hostile = [
      "registry=https://evil.example/", "@scope:registry=https://evil.example/", "//registry.npmjs.org/:_authToken=abc", "_auth=abc", "_authToken=abc",
      "ignore-scripts=false", "enable-pre-post-scripts=true", "script-shell=/tmp/x", "node-options=--require /tmp/x", "store-dir=/home/x", "cache=/home/x", "userconfig=/tmp/x",
      "globalconfig=/tmp/x", "https-proxy=http://evil.example", "ca=abc", "cafile=/tmp/x", "strict-ssl=false", "git=/tmp/x", "hook-path=/tmp/x", "pnpmfile=./x.cjs",
      "global-pnpmfile=./x.cjs", "side-effects-cache=false", "registry=${EVIL}", "auto-install-peers=${EVIL}", "no equals sign", "=novalue", "use-node-version=20", "manage-package-manager-versions=true", "package-import-method=copy\\x0",
    ];
    for (const line of hostile) expect(checkNpmrc(`${line}\n`, url), line).toEqual({ ok: false, reason: "npmrc_unsafe" });
  });
});

describe("checkWorkspaceYaml", () => {
  it("accepts project lists and dependency data", () => {
    expect(checkWorkspaceYaml("packages:\n  - 'apps/*'\n  - packages/*\n\ncatalog:\n  react: ^18\nonlyBuiltDependencies:\n  - esbuild\n").ok).toBe(true);
  });
  it("round 2: patch paths stay inside the repo, and brace globs or globs that can leave it are refused", () => {
    expect(checkWorkspaceYaml("patchedDependencies:\n  left-pad@1.3.0: patches/left-pad.patch\n").ok).toBe(true);
    for (const text of [
      "patchedDependencies:\n  x@1: ../outside.patch\n", "patchedDependencies:\n  x@1: /abs/x.patch\n", "patchedDependencies:\n  x@1: patches/../../x.patch\n", "patchedDependencies:\n  x@1: [a]\n",
      "packages: ['{a,../..}/*']\n", "packages: ['a/{b,c}']\n", "packages: ['a/../../*']\n", "packages: ['!../x']\n", "packages: ['a/**/../../..']\n", "packages: ['/abs/*']\n", "packages: ['~/x']\n",
    ]) {
      expect(checkWorkspaceYaml(text), text).toEqual({ ok: false, reason: "npmrc_unsafe" });
    }
    expect(checkWorkspaceYaml("packages: ['apps/*', 'packages/*', '!packages/doc-templates']\n").ok).toBe(true);
  });

  it("accepts this repository's own pnpm-workspace.yaml", () => {
    expect(checkWorkspaceYaml(readFileSync(path.join(PACKAGE_DIR, "..", "..", "pnpm-workspace.yaml"), "utf8")).ok).toBe(true);
  });
  it("regression: an explicit document start with a flow map, an indented root, a second document, anchors and tags are refused", () => {
    for (const text of ["--- {virtualStoreDir: /abs}\n", "--- {packages: [a], virtualStoreDir: /abs}\n", "  virtualStoreDir: /abs\n", "packages:\n  - a\n---\nvirtualStoreDir: /abs\n", "x: &a {virtualStoreDir: /abs}\n", "!!js/function 'x'\n", "{packages: [a], modulesDir: /abs}\n", "- packages\n", "packages: [a]\n? virtualStoreDir\n: /abs\n", "packages: [a]\nvirtualStoreDir: /abs\n"]) {
      expect(checkWorkspaceYaml(text), text).toEqual({ ok: false, reason: "npmrc_unsafe" });
    }
    expect(checkWorkspaceYaml("--- {packages: [a, 'b/*']}\n").ok).toBe(true);
    expect(checkWorkspaceYaml("packages: ['../outside']\n").ok).toBe(false);
    expect(checkWorkspaceYaml("overrides:\n  x: link:../outside\n").ok).toBe(false);
    expect(checkWorkspaceYaml("catalog:\n  x: https://evil.invalid/x.tgz\n").ok).toBe(false);
  });

  it("refuses a registry, a hook, a script or any key it does not know", () => {
    for (const key of ["registry", "registries", "pnpmfile", "hooks", "ignoreScripts", "storeDir", "cacheDir", "scriptShell", "nodeOptions", "httpsProxy", "unknownThing"]) {
      expect(checkWorkspaceYaml(`packages:\n  - a\n${key}: x\n`), key).toEqual({ ok: false, reason: "npmrc_unsafe" });
    }
    expect(checkWorkspaceYaml("'@scope:registry': https://evil.example/\n")).toEqual({ ok: false, reason: "npmrc_unsafe" });
  });
});
