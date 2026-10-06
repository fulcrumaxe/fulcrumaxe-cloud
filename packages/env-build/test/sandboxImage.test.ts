import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PRESETS } from "@fx/env-presets";

/**
 * Static checks on infra/sandbox-image (the fx-agent image: pinned node, claude, codex and opencode under
 * /opt/fx) and on the owner-run publish script. Reads files and runs the script's --dry-run;
 * builds nothing, pushes nothing, and touches no network.
 */
const ROOT = new URL("../../../", import.meta.url).pathname;
const dockerfile = readFileSync(join(ROOT, "infra/sandbox-image/Dockerfile"), "utf8");
const lock = JSON.parse(readFileSync(join(ROOT, "infra/sandbox-image/versions.lock.json"), "utf8")) as {
  artifacts: Record<string, { version: string; url: string; sha256: string }>;
};
const lines = dockerfile.split("\n").filter((l) => !l.trim().startsWith("#"));
const instructions = (name: string) => lines.filter((l) => new RegExp(`^${name}\\b`, "i").test(l.trim()));
const NAMES = ["node", "claude", "codex", "opencode"];

describe("Dockerfile base images", () => {
  it("pins every external FROM by sha256 digest, never a tag", () => {
    const aliases = new Set<string>();
    const froms = instructions("FROM");
    expect(froms.length).toBeGreaterThanOrEqual(2);
    for (const f of froms) {
      const m = /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i.exec(f.trim());
      expect(m, f).not.toBeNull();
      const [, ref, alias] = m!;
      if (!aliases.has(ref!)) expect(ref, f).toMatch(/^[\w./-]+@sha256:[0-9a-f]{64}$/);
      expect(ref).not.toMatch(/:latest\b/);
      if (alias) aliases.add(alias);
    }
  });

  it("uses the same ubuntu digest as the environment presets", () => {
    const refs = instructions("FROM").map((f) => f.trim().split(/\s+/)[1]);
    expect(refs.filter((r) => r!.startsWith("docker.io/")).every((r) => r === PRESETS[0]!.base)).toBe(true);
  });
});

describe("lockfile and downloads", () => {
  it("records a version, an https url naming it, and a sha256 for node, claude, codex and opencode", () => {
    expect(Object.keys(lock.artifacts).sort()).toEqual([...NAMES].sort());
    for (const n of NAMES) {
      const a = lock.artifacts[n]!;
      expect(a.version, n).toMatch(/^\d+\.\d+\.\d+$/);
      expect(a.url, n).toMatch(/^https:\/\//);
      expect(a.url, n).toContain(a.version);
      expect(a.sha256, n).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("verifies every download with sha256sum -c against a build arg, with no inline hash or url", () => {
    for (const n of NAMES) {
      const up = n.toUpperCase();
      expect(dockerfile, n).toMatch(new RegExp(`^ARG ${up}_URL$`, "m"));
      expect(dockerfile, n).toMatch(new RegExp(`^ARG ${up}_SHA256$`, "m"));
      expect(dockerfile, n).toMatch(new RegExp(`curl [^\\n]*"\\$${up}_URL"`));
      expect(dockerfile, n).toMatch(new RegExp(`echo "\\$${up}_SHA256  [^"]+" \\| sha256sum -c -`));
    }
    expect(dockerfile).not.toMatch(/https?:\/\//);
    for (const n of NAMES) expect(dockerfile).not.toContain(lock.artifacts[n]!.sha256);
  });
});

describe("verify before use", () => {
  // The first command that opens, moves or marks executable each downloaded file.
  const use: Record<string, string> = {
    node: "tar -xJf /tmp/dl/node.tar.xz",
    claude: "chmod 0755 /opt/fx/bin/node /opt/fx/bin/claude",
    codex: "tar -xzf /tmp/dl/codex.tar.gz",
    opencode: "tar -xzf /tmp/dl/opencode.tar.gz",
  };
  it("runs each sha256sum -c before that artifact is extracted, moved or made executable", () => {
    for (const n of NAMES) {
      const check = dockerfile.indexOf(`echo "$${n.toUpperCase()}_SHA256 `);
      const used = dockerfile.indexOf(use[n]!);
      expect(check, n).toBeGreaterThan(-1);
      expect(used, n).toBeGreaterThan(-1);
      expect(check, n).toBeLessThan(used);
    }
    const mv = dockerfile.indexOf("mv /opt/fx/bin/codex-x86_64");
    expect(dockerfile.indexOf(`echo "$CODEX_SHA256 `)).toBeLessThan(mv);
  });

  it("opencode is a pinned linux-x64 release tarball from the project's GitHub release, extracted to /opt/fx/bin and made executable", () => {
    const oc = lock.artifacts.opencode!;
    expect(oc.url).toBe(
      `https://github.com/anomalyco/opencode/releases/download/v${oc.version}/opencode-linux-x64-baseline.tar.gz`,
    );
    expect(oc.version).toBe("1.18.34");
    expect(oc.sha256).toBe("24b0d458d21ef548b2752166303defcf7f4945b049fb4876ab78dfaf86d81b27");
    expect(dockerfile).toContain("tar -xzf /tmp/dl/opencode.tar.gz -C /opt/fx/bin opencode");
    expect(dockerfile).toMatch(/chmod 0755 [^;\n]*\/opt\/fx\/bin\/opencode/);
    expect(dockerfile).toContain('"${OPENCODE_URL:?}" "${OPENCODE_SHA256:?}"');
  });
});

describe("auto-update, secrets and paths", () => {
  it("disables the CLI auto-updater", () => {
    expect(dockerfile).toMatch(/^ENV DISABLE_AUTOUPDATER=1$/m);
    expect(dockerfile).not.toMatch(/DISABLE_AUTOUPDATER=(0|false)/i);
  });

  it("disables the opencode auto-updater", () => {
    expect(dockerfile).toMatch(/^ENV OPENCODE_DISABLE_AUTOUPDATE=1$/m);
    expect(dockerfile).not.toMatch(/OPENCODE_DISABLE_AUTOUPDATE=(0|false)/i);
  });

  it("bakes in no credential, secret or env file", () => {
    for (const l of [...instructions("ENV"), ...instructions("ARG")]) {
      expect(l, l).not.toMatch(/KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH|BEARER/i);
    }
    expect(dockerfile).not.toMatch(/\.env\b|id_rsa|\.npmrc|\.netrc|ANTHROPIC|OPENAI|sk-[A-Za-z0-9]/i);
    for (const l of instructions("COPY").concat(instructions("ADD"))) expect(l, l).toMatch(/--from=fetch/);
  });

  it("puts node, claude, codex and opencode at /opt/fx/bin/*, root-owned, and first on PATH ahead of the standard directories", () => {
    for (const n of NAMES) expect(dockerfile, n).toContain(`/opt/fx/bin/${n}`);
    expect(dockerfile).toMatch(/^COPY --from=fetch --chown=root:root \/opt\/fx \/opt\/fx$/m);
    // The runner starts `claude` by name, so the pinned directory is on PATH, first: nothing later on PATH can shadow it.
    expect(instructions("ENV").filter((l) => /^ENV\s+PATH\b/i.test(l.trim()))).toEqual([
      "ENV PATH=/opt/fx/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    ]);
    expect(dockerfile).not.toMatch(/\/usr\/bin\/(node|claude|codex|opencode)/);
  });

  it("installs git (the runner's clone needs it) and creates the working directories the runner writes to, owned by ubuntu", () => {
    expect(dockerfile).toMatch(/apt-get install [^\n]*\bgit\b/);
    expect(dockerfile).toMatch(/install -d -o ubuntu -g ubuntu \/vercel \/vercel\/sandbox \/fx\b/);
  });

  it("keeps the preset user, sudo and home", () => {
    expect(dockerfile).toContain("'ubuntu ALL=(ALL) NOPASSWD:ALL'");
    expect(dockerfile).toMatch(/^ENV HOME=\/vercel$/m);
    expect(dockerfile).toMatch(/^USER ubuntu$/m);
    expect(dockerfile).toMatch(/^WORKDIR \/vercel$/m);
  });
});

// scripts/ops/ is a private overlay directory: the script is absent from the public tree.
describe.skipIf(!existsSync(join(ROOT, "scripts/ops/publish-sandbox-image.sh")))("scripts/ops/publish-sandbox-image.sh", () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  const env = (extra: Record<string, string> = {}) => {
    const e: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("GIT_")) e[k] = v;
    return { ...e, ...extra };
  };
  const git = (cwd: string, ...a: string[]) =>
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", ...a], { cwd, env: env() });

  /** A throwaway repo holding only the script and the image directory, with fake vercel/docker that log any call. */
  const repo = () => {
    const d = mkdtempSync(join(tmpdir(), "fx-si-"));
    dirs.push(d);
    mkdirSync(join(d, "scripts/ops"), { recursive: true });
    cpSync(join(ROOT, "scripts/ops/publish-sandbox-image.sh"), join(d, "scripts/ops/publish-sandbox-image.sh"));
    cpSync(join(ROOT, "infra"), join(d, "infra"), { recursive: true });
    git(d, "init", "-q");
    git(d, "add", "-A");
    git(d, "commit", "-q", "-m", "x");
    const bin = join(d, "fakebin");
    mkdirSync(bin);
    for (const t of ["vercel", "docker"]) {
      writeFileSync(join(bin, t), `#!/usr/bin/env bash\necho "${t} $*" >> "${d}/calls.log"\nexit 1\n`, { mode: 0o755 });
    }
    return { d, bin };
  };
  const run = (d: string, bin: string, ...args: string[]) =>
    spawnSync("bash", [join(d, "scripts/ops/publish-sandbox-image.sh"), ...args], {
      cwd: d,
      encoding: "utf8",
      env: env({ PATH: `${bin}:${process.env.PATH}`, VERCEL_TOKEN: "canary-token-value-1234" }),
    });

  it("refuses a dirty git tree before it calls vercel or docker", () => {
    const { d, bin } = repo();
    writeFileSync(join(d, "stray.txt"), "x");
    const r = run(d, bin);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("dirty");
    expect(existsSync(join(d, "calls.log"))).toBe(false);
  });

  it("--dry-run prints the vcr build --push plan with the lockfile's urls and hashes, calls nothing, and leaks no token", () => {
    const { d, bin } = repo();
    const r = run(d, bin, "--dry-run");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("vercel vcr build docker");
    expect(r.stdout).toContain("--push");
    for (const n of NAMES) {
      expect(r.stdout).toContain(`${n.toUpperCase()}_URL=${lock.artifacts[n]!.url}`);
      expect(r.stdout).toContain(`${n.toUpperCase()}_SHA256=${lock.artifacts[n]!.sha256}`);
    }
    expect(r.stdout + r.stderr).not.toContain("canary-token-value-1234");
    expect(existsSync(join(d, "calls.log"))).toBe(false);
  });

  describe("prune", () => {
    const dg = (n: number) => `sha256:${n.toString(16).padStart(2, "0").repeat(32)}`;
    const day = (n: number, h = 0) => `2026-09-${String(n).padStart(2, "0")}T0${h}:00:00Z`;
    const row = (id: string, digest: number, createdAt: string, kind?: string) => ({ id, manifestDigest: dg(digest), createdAt, ...(kind ? { kind } : {}) });
    /** One publish = an index, its child manifest and an attestation; the children are created just after the index. */
    const publish = (n: number) => [
      row(`image_i${n}`, n, day(n), "index"),
      row(`image_m${n}`, 10 + n, day(n, 1), "manifest"),
      row(`image_a${n}`, 20 + n, day(n, 2), "attestation"),
    ];
    /** Fake vercel: serves two list pages (cursor p2 for the second) and logs every call. */
    const prunable = (extra: object[] = []) => {
      const { d, bin } = repo();
      writeFileSync(join(d, "page1.json"), JSON.stringify({ images: [...publish(3), ...publish(1), ...publish(5), ...publish(2)], nextCursor: "p2" }));
      writeFileSync(join(d, "page2.json"), JSON.stringify({ images: [...publish(4), ...publish(6), ...extra] }));
      writeFileSync(
        join(bin, "vercel"),
        `#!/usr/bin/env bash\necho "$*" >> "${d}/calls.log"\ncase "$*" in\n  *"image ls"*"--cursor p2"*) cat "${d}/page2.json" ;;\n  *"image ls"*) cat "${d}/page1.json" ;;\nesac\nexit 0\n`,
        { mode: 0o755 },
      );
      return { d, bin };
    };
    const calls = (d: string) => (existsSync(join(d, "calls.log")) ? readFileSync(join(d, "calls.log"), "utf8") : "");
    const deleted = (d: string) => calls(d).split("\n").filter((l) => l.includes("image rm")).map((l) => /image rm fx-agent (\S+)/.exec(l)![1]);

    it("lists every page, prunes only index rows, counts N over indexes, and keeps the pinned index's child manifest", () => {
      const { d, bin } = prunable();
      const r = run(d, bin, "prune", "--keep-digest", dg(1), "--keep", "2");
      expect(r.status, r.stderr).toBe(0);
      expect(calls(d)).toContain("--limit 100");
      expect(calls(d)).toContain("--cursor p2");
      // indexes 6 and 5 are the newest two; 1 is pinned; 2, 3, 4 go. Every manifest and attestation row stays,
      // including image_m1 (the pinned index's child, far outside the newest two rows).
      expect(deleted(d).sort()).toEqual(["image_i2", "image_i3", "image_i4"]);
      expect(calls(d).split("\n").filter((l) => l.includes("image rm")).every((l) => l.includes("--yes"))).toBe(true);
      expect(r.stdout).toContain(`deleted image_i2 ${dg(2)}`);
    });

    it("--dry-run lists what it would delete and deletes nothing", () => {
      const { d, bin } = prunable();
      const r = run(d, bin, "prune", "--keep-digest", dg(1), "--keep", "2", "--dry-run");
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`would delete image_i2 ${dg(2)}`);
      expect(deleted(d)).toEqual([]);
    });

    it("refuses without --keep-digest, with a malformed one, or when the pinned digest is not a listed index, and deletes nothing", () => {
      const { d, bin } = prunable();
      const none = run(d, bin, "prune");
      expect(none.status).toBe(2);
      expect(none.stderr).toContain("--keep-digest");
      expect(run(d, bin, "prune", "--keep-digest", "sha256:abc").status).toBe(2);
      expect(calls(d)).toBe("");
      expect(run(d, bin, "prune", "--keep-digest", dg(99)).status).toBe(1);
      expect(run(d, bin, "prune", "--keep-digest", dg(11)).status).toBe(1); // a manifest digest is not a pin
      expect(deleted(d)).toEqual([]);
    });

    it("fails closed, deleting nothing, on a row with an unknown or missing kind", () => {
      for (const extra of [row("image_x", 50, day(7), "weird"), row("image_y", 51, day(7))]) {
        const { d, bin } = prunable([extra]);
        const r = run(d, bin, "prune", "--keep-digest", dg(1), "--keep", "2");
        expect(r.status).toBe(1);
        expect(r.stderr).toContain("unknown or missing image kind");
        expect(deleted(d)).toEqual([]);
      }
    });
  });

  it("--dry-run on a dirty tree warns and still exits 0; an unknown flag is rejected", () => {
    const { d, bin } = repo();
    writeFileSync(join(d, "stray.txt"), "x");
    const r = run(d, bin, "--dry-run");
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("dirty");
    expect(run(d, bin, "--push").status).toBe(2);
  });
});
