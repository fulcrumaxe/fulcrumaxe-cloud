/**
 * Regression tests for the review of #529 (security and code review): each must-fix has its repro here, with
 * fake secrets built at run time.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { MASK_FILE_ENV, MaskError, MaskRegistry, checkMaskStat, envSecretValues } from "../src/mask.js";
import { buildResults, issueTitle, summaryTable, writeReport, writeScrubbed } from "../src/report.js";
import { describeFinding, detect, scanDir, type Finding } from "../src/scrub.js";
import { filler, noiseBytes } from "./artifacts.js";
import { makeIo } from "./helpers.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "t2a_hard_"));
}
function dirWith(files: Record<string, Buffer | string>): string {
  const dir = scratch();
  for (const [name, data] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), data);
  }
  return dir;
}
const kinds = (f: Finding[]) => [...new Set(f.map((x) => x.kind))];
const silent = (extra: { file?: string; create?: boolean } = {}) => new MaskRegistry({ emit: () => undefined, ...extra });
/** A runtime secret with no shape of its own, registered so that only the registry can find it. */
const RT = ["rt", filler("hard", 30)].join("Q");
function withRt(): { registry: MaskRegistry } {
  const registry = silent();
  registry.register(RT);
  return { registry };
}
const found = (files: Record<string, Buffer | string>) => scanDir(dirWith(files), { ...withRt(), env: {} });
const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");

describe("1. mask file creation and reuse", () => {
  it("refuses a file that already exists, even a harmless one, and leaves it alone", () => {
    const file = join(scratch(), "mask.txt");
    writeFileSync(file, "", { mode: 0o644 });
    expect(() => silent({ file, create: true })).toThrow(/already exists/);
    expect(statSync(file).mode & 0o777).toBe(0o644);
  });

  it("refuses to open (not create) a pre-existing group/other-readable file, and writes nothing into it", () => {
    const file = join(scratch(), "mask.txt");
    writeFileSync(file, "", { mode: 0o644 });
    expect(() => silent({ file })).toThrow(/accessible to group or others \(mode 644\)/);
    expect(readFileSync(file, "utf8")).toBe("");
  });

  it("refuses a symlink at the path for both the owner and the others, and never writes through it", () => {
    const dir = scratch();
    const target = join(dir, "target.txt");
    writeFileSync(target, "", { mode: 0o600 });
    const link = join(dir, "mask.txt");
    symlinkSync(target, link);
    expect(() => silent({ file: link, create: true })).toThrow(/already exists|symbolic link/);
    expect(() => silent({ file: link })).toThrow(/symbolic link/);
    expect(readFileSync(target, "utf8")).toBe("");
  });

  it("the check-then-create race: a dangling symlink planted before creation is refused and its target never appears", () => {
    const dir = scratch();
    const victim = join(dir, "victim.txt");
    const link = join(dir, "mask.txt");
    symlinkSync(victim, link);
    expect(() => silent({ file: link, create: true })).toThrow(MaskError);
    expect(existsSync(victim)).toBe(false);
  });

  it("two owners cannot both create the file: the second is refused", () => {
    const file = join(scratch(), "mask.txt");
    silent({ file, create: true });
    expect(() => silent({ file, create: true })).toThrow(/already exists/);
  });

  it("a file swapped for a symlink, or loosened, after creation is caught at the next write", () => {
    const dir = scratch();
    const file = join(dir, "mask.txt");
    const registry = silent({ file, create: true });
    registry.register("first-secret-value");
    chmodSync(file, 0o644);
    expect(() => registry.register("second-secret-value")).toThrow(/accessible to group or others/);
    chmodSync(file, 0o600);
    const other = join(dir, "other.txt");
    writeFileSync(other, "", { mode: 0o600 });
    const moved = join(dir, "moved.txt");
    writeFileSync(moved, readFileSync(file));
    // replace the file by a symlink to another file
    execFileSync("rm", [file]);
    symlinkSync(other, file);
    expect(() => registry.register("third-secret-value")).toThrow(/symbolic link/);
    expect(readFileSync(other, "utf8")).toBe("");
  });

  it("a missing file is an error for a non-owner, not a silent empty registry", () => {
    expect(() => silent({ file: join(scratch(), "nope.txt") })).toThrow(/does not exist/);
  });

  it("checkMaskStat enforces: regular file, our uid, no group or other access", () => {
    const ok = { isFile: () => true, uid: 1000, mode: 0o100600 };
    expect(() => checkMaskStat(ok, 1000, "m")).not.toThrow();
    expect(() => checkMaskStat({ ...ok, uid: 0 }, 1000, "m")).toThrow(/owned by another user/);
    expect(() => checkMaskStat({ ...ok, isFile: () => false }, 1000, "m")).toThrow(/not a regular file/);
    expect(() => checkMaskStat({ ...ok, mode: 0o100640 }, 1000, "m")).toThrow(/group or others/);
    expect(() => checkMaskStat({ ...ok, mode: 0o100602 }, 1000, "m")).toThrow(/group or others/);
  });

  it("the gate exits 1 (not a crash) when the mask file is unsafe or missing", async () => {
    const dir = dirWith({ "a.log": "x" });
    const loose = join(scratch(), "mask.txt");
    writeFileSync(loose, "", { mode: 0o644 });
    for (const file of [loose, join(scratch(), "missing.txt")]) {
      const { io, err } = makeIo(dir, { [MASK_FILE_ENV]: file });
      expect(await main(["scrub", "--dir", dir], io)).toBe(1);
      expect(err.join("\n")).toMatch(/SECRET \.: unscannable:mask file/);
    }
  });
});

describe("3. base64 that does not start where the run starts", () => {
  it("is decoded after URL path segments, an id prefix, and any prefix length", () => {
    const blob = b64(`{"t":"${RT}"}`);
    expect(kinds(found({ "a.log": `GET https://x.test/cb/ab/${blob} 200` }).findings)).toContain("runtime-value");
    expect(kinds(found({ "a.log": `id_${b64(`xx${RT}yy`)}` }).findings)).toContain("runtime-value");
    for (let n = 0; n < 10; n += 1) {
      for (const encode of [b64, (s: string) => Buffer.from(s).toString("base64url")]) {
        expect(kinds(found({ "a.log": `${"Q".repeat(n)}/${encode(`pad${RT}`)}` }).findings), `prefix ${n}`).toContain("runtime-value");
        expect(kinds(found({ "a.log": `${"Q".repeat(n)}${encode(`${"z".repeat(n)}${RT}`)}` }).findings), `prefix ${n} b`).toContain("runtime-value");
      }
    }
  });
});

describe("4. escaped JSON, more than once", () => {
  const twice = (v: unknown) => JSON.stringify(JSON.stringify(v));
  const thrice = (v: unknown) => JSON.stringify(twice(v));
  const cases: [string, string, unknown][] = [
    ["authorization header", "authorization-header", { authorization: `token ${filler("d1", 30)}` }],
    ["bypass header", "bypass-secret", { ["x-vercel-protection-" + "bypass"]: filler("d2", 32) }],
    ["HAR header pair", "header-pair", { headers: [{ name: "Authorization", value: `Negotiate ${filler("d3", 30)}` }] }],
    ["cookie header", "cookie-header", { cookie: `sid=${filler("d4", 30)}; other=1` }],
  ];
  for (const [name, kind, value] of cases) {
    it(`finds the ${name} after one, two and three rounds of JSON.stringify`, () => {
      for (const text of [JSON.stringify(value), twice(value), thrice(value)]) {
        expect(kinds(scanDir(dirWith({ "r.json": text }), { env: {} }).findings), text.slice(0, 40)).toContain(kind);
      }
    });
  }
});

describe("5. credentials in URLs of any scheme", () => {
  it("finds user:pw@host for postgres, redis, mongodb+srv, amqps and an empty user", () => {
    for (const url of [
      `postgres://neondb_owner:${filler("u1", 24)}@ep-x.neon.tech/db`,
      `redis://:${filler("u2", 24)}@cache.test:6379`,
      `mongodb+srv://app:${filler("u3", 24)}@c0.mongodb.test/x`,
      `amqps://u:${filler("u4", 24)}@mq.test`,
      `https://:${filler("u5", 24)}@host.test/`,
    ]) {
      expect(kinds(scanDir(dirWith({ "a.log": `connect ${url}` }), { env: {} }).findings), url.slice(0, 12)).toContain("url-credentials");
    }
  });

  it("leaves ordinary URLs and ssh remotes alone", () => {
    const text = "see https://example.test:8443/a/b and git@github.com:fulcrumaxe/cloud.git and postgres://host.test/db";
    expect(scanDir(dirWith({ "a.log": text }), { env: {} }).findings).toEqual([]);
  });
});

describe("6. findings never echo raw names", () => {
  it("the mask file inside the folder, and file names, symlinks and special files", () => {
    const dir = scratch();
    symlinkSync("/etc/hostname", join(dir, `link-${RT}`));
    mkdirSync(join(dir, `dir-${RT}`));
    writeFileSync(join(dir, `dir-${RT}`, "f.txt"), "clean");
    writeFileSync(join(dir, `name-${RT}.log`), "x");
    writeFileSync(join(dir, `other-${RT}.zip`), "x");
    let fifo = false;
    try {
      execFileSync("mkfifo", [join(dir, `fifo-${RT}`)]);
      fifo = true;
    } catch {
      /* no mkfifo on this machine */
    }
    const registry = silent({ file: join(dir, `mask-${RT}.txt`), create: true });
    registry.register(RT);
    const result = scanDir(dir, { registry, env: {} });
    expect(kinds(result.findings)).toContain("unscannable:mask-file-inside-artifacts");
    expect(result.notUploaded.some((n) => n.type === "symlink")).toBe(true);
    expect(result.notUploaded.some((n) => n.type === "zip")).toBe(true);
    if (fifo) expect(result.notUploaded.some((n) => n.type === "special-file")).toBe(true);
    expect(JSON.stringify(result)).not.toContain(RT);
    expect(result.findings.map(describeFinding).join("\n")).not.toContain(RT);
  });
});

describe("7. large and hostile input does not crash the gate", () => {
  it("a 16 MB base64 run scans without a stack overflow, and a value inside it is found", () => {
    const half = noiseBytes(6 * 1024 * 1024, 529);
    const clean = scanDir(dirWith({ "big.txt": `x="${Buffer.concat([half, half]).toString("base64")}"` }), withRt());
    expect(clean.findings).toEqual([]);
    const planted = Buffer.concat([half, Buffer.from(RT), half]).toString("base64");
    expect(kinds(scanDir(dirWith({ "big.txt": `x="${planted}"` }), withRt()).findings)).toContain("runtime-value");
  }, 120_000);

  it("a value straddling the boundary of two decoding windows is still found", () => {
    // the first window ends at character 1048576 (byte 786432); put the value across that boundary
    const at = 786432 - Math.floor(RT.length / 2);
    const data = Buffer.concat([noiseBytes(at, 531), Buffer.from(RT), noiseBytes(2 * 1024 * 1024, 533)]);
    expect(kinds(scanDir(dirWith({ "big.txt": data.toString("base64") }), withRt()).findings)).toContain("runtime-value");
  }, 120_000);

  it("a file that cannot be read is a finding, not a skipped file", () => {
    if (process.getuid?.() === 0) return; // root reads everything
    const dir = dirWith({ "a.log": "x", "b.log": "y" });
    chmodSync(join(dir, "b.log"), 0o000);
    expect(scanDir(dir, { env: {} }).findings).toEqual([{ path: "b.log", kind: "unscannable:read-failed", via: "plain" }]);
  });

  it("32k repeats of '-eyJ' do not make the JWT shape quadratic", () => {
    const text = "-eyJ".repeat(32_000);
    const t = Date.now();
    detect(text, {});
    expect(Date.now() - t).toBeLessThan(3000);
  });

  it("an internal error becomes an unscannable finding, and the CLI exits 1 instead of throwing", async () => {
    const boom = { values: () => { throw new RangeError("Maximum call stack size exceeded"); }, version: 0, file: undefined, loadFile: () => undefined } as unknown as MaskRegistry;
    const dir = dirWith({ "a.log": "x" });
    const { findings } = scanDir(dir, { registry: boom, env: {} });
    expect(kinds(findings)).toContain("unscannable:internal-error");
    expect(JSON.stringify(findings)).not.toContain("call stack");
  });
});

describe("should-fix: more encodings", () => {
  it("finds a value as hex, as Node's <Buffer ..> form, and as HTML entities", () => {
    const hex = Buffer.from(RT).toString("hex");
    const spaced = hex.match(/../g)!.join(" ");
    expect(kinds(found({ "a.log": `v=${hex}` }).findings)).toContain("runtime-value");
    expect(kinds(found({ "a.log": `v=abc${hex}` }).findings)).toContain("runtime-value");
    expect(kinds(found({ "a.log": `<Buffer ${spaced}>` }).findings)).toContain("runtime-value");
    expect(kinds(found({ "a.log": [...RT].map((c) => `&#${c.charCodeAt(0)};`).join("") }).findings)).toContain("runtime-value");
    expect(kinds(found({ "a.log": [...RT].map((c) => `&#x${c.charCodeAt(0).toString(16)};`).join("") }).findings)).toContain("runtime-value");
  });

  it("finds a value in base64 wrapped across lines (76 columns, and short lines)", () => {
    const blob = b64(`prefix-${RT}-suffix-padding-padding-padding`);
    for (const width of [76, 64, 20]) {
      const wrapped = blob.match(new RegExp(`.{1,${width}}`, "g"))!.join("\n");
      expect(kinds(found({ "a.log": wrapped }).findings), `width ${width}`).toContain("runtime-value");
      expect(kinds(found({ "a.log": wrapped.replace(/\n/g, "\r\n") }).findings), `crlf ${width}`).toContain("runtime-value");
    }
  });

  it("does not claim to see a value split across lines (documented limit)", () => {
    expect(found({ "a.log": `${RT.slice(0, 15)}\n${RT.slice(15)}` }).findings).toEqual([]);
  });
});

describe("should-fix: credential names, tokens and the report", () => {
  it("treats PAT, PASS, DSN, DATABASE_URL and CONNECTION_STRING names as secret, but not PATH", () => {
    const env = {
      GITHUB_PAT: filler("e1", 30),
      INPUT_PAT: filler("e2", 30),
      RUNNER_PASS: filler("e3", 30),
      PLAYWRIGHT_DSN: filler("e4", 30),
      DATABASE_URL: filler("e5", 30),
      XDG_CONNECTION_STRING: filler("e6", 30),
      PATH: "/usr/bin:/usr/local/bin:/bin",
      GITHUB_PATH: "/home/runner/work/_temp/_runner_file_commands/add_path_x",
    };
    const secret = envSecretValues(env);
    for (const k of ["GITHUB_PAT", "INPUT_PAT", "RUNNER_PASS", "PLAYWRIGHT_DSN", "DATABASE_URL", "XDG_CONNECTION_STRING"] as const) expect(secret, k).toContain(env[k]);
    expect(secret).not.toContain(env.PATH);
    expect(secret).not.toContain(env.GITHUB_PATH);
  });

  it("the issue-title error does not echo the rejected input", () => {
    const secret = filler("title", 20);
    try {
      issueTitle(`Bad ${secret}`, "staging");
      throw new Error("expected a throw");
    } catch (err) {
      expect((err as Error).message).not.toContain(secret);
    }
  });

  it("the summary and the writers report how many values they redacted", () => {
    const secret = ["sk", "_live_", filler("count", 24)].join("");
    const results = buildResults({
      target: "staging",
      started_at: "2026-10-05T10:00:00Z",
      finished_at: "2026-10-05T10:01:00Z",
      packs: [{ id: "platform", outcome: "FAIL", duration_ms: 1, devices: [], cost_usd: 0, tests: [{ title: "t", device: "desktop", status: "failed", duration_ms: 1, error: `bad ${secret} here` }] }],
    });
    const dir = scratch();
    const { summaryPath, redactions } = writeReport(dir, results, { env: {} });
    expect(redactions).toBe(1);
    expect(readFileSync(summaryPath, "utf8")).toContain("Redacted before writing: 1 value(s).");
    expect(summaryTable(results, 3)).toContain("Redacted before writing: 3 value(s).");
    expect(writeScrubbed(join(dir, "x.log"), `a ${secret} b ${secret}`, { env: {} })).toBe(2);
    expect(writeScrubbed(join(dir, "y.log"), "nothing here", { env: {} })).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Recheck of 57d9bed7: hex, token prefixes

describe("10. long unbroken hex does not overflow the stack", () => {
  it("16 MB of hex digits and 16 MB of 'A' scan without an internal error", () => {
    const clean = scanDir(dirWith({ "h.txt": Buffer.from("ab".repeat(8 * 1024 * 1024)), "a.txt": Buffer.from("A".repeat(16 * 1024 * 1024)) }), withRt());
    expect(kinds(clean.findings)).not.toContain("unscannable:internal-error");
    expect(clean.findings).toEqual([]);
  }, 180_000);

  it("a value hex-encoded inside a long hex dump is found, across a window boundary too", () => {
    const hex = Buffer.from(RT).toString("hex");
    for (const at of [1000, 1_044_480 - 10]) {
      const dump = `${"ab".repeat(at)}${hex}${"cd".repeat(2000)}`;
      expect(kinds(found({ "h.txt": dump }).findings), `at ${at}`).toContain("runtime-value");
    }
  }, 120_000);
});

describe("11. tokens with a known prefix are caught at any length", () => {
  it("catches Slack, AWS, Google, GitLab and npm tokens, and a short bearer Slack token", () => {
    for (const text of [
      ["xo", "xb-", "AbCdEfGh"].join(""),
      `bearer ${["xo", "xb-", "AbCdEfGh"].join("")}`,
      ["AK", "IA", "ABCDEFGHIJKLMNOP"].join(""),
      ["AI", "za", filler("g", 35)].join(""),
      ["gl", "pat-", filler("gl", 20)].join(""),
      ["npm", "_", filler("n", 36)].join(""),
    ]) {
      expect(scanDir(dirWith({ "a.log": `v ${text} w` }), { env: {} }).findings.length, text.slice(0, 6)).toBeGreaterThan(0);
    }
  });

  it("leaves lookalike words alone", () => {
    expect(scanDir(dirWith({ "a.log": "AKIA is a prefix, npm_config is a variable, AIza alone, glpat- alone, xoxb- alone" }), { env: {} }).findings).toEqual([]);
  });
});
