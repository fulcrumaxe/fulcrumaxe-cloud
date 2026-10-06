import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { MASK_FILE_ENV, MaskError, MaskRegistry, envSecretValues } from "../src/mask.js";
import { buildResults, writeReport, writeScrubbed } from "../src/report.js";
import {
  ScrubError,
  SHAPE_KINDS,
  assertClean,
  describeFinding,
  detect,
  redact,
  scanDir,
  type Finding,
  type ScrubContext,
} from "../src/scrub.js";
import { filler, makePng, makeZip, pngChunk, plantedShapes, type PngTextKind } from "./artifacts.js";
import { GOOD_HOST, makeIo, scratchRoot } from "./helpers.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "t2a_scrub_"));
}

function dirWith(files: Record<string, Buffer | string>): string {
  const dir = scratch();
  for (const [name, data] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), data);
  }
  return dir;
}

function kinds(findings: Finding[]): string[] {
  return [...new Set(findings.map((f) => f.kind))];
}

const SHAPES = plantedShapes();
const silent = () => new MaskRegistry({ emit: () => undefined });

// Every artifact type that may be uploaded, each holding the planted text. (HAR, traces, video and archives are
// not uploaded at all; see "the upload allowlist".)
const ARTIFACT_TYPES: [string, (text: string) => Record<string, Buffer | string>][] = [
  ["log", (t) => ({ "logs/run.log": `2026-10-05T10:00:00Z INFO step done\n${t}\n2026-10-05T10:00:01Z INFO next\n` })],
  ["request log", (t) => ({ "request-log.json": JSON.stringify([{ method: "GET", url: "https://x.test/a", status: 200, note: t }], null, 2) })],
  ["network log (JSON lines)", (t) => ({ "network.jsonl": `${JSON.stringify({ request: { method: "GET", comment: t } })}\n` })],
  ["markdown", (t) => ({ "notes.md": `# Run\n\n${t}\n` })],
  ["HTML report", (t) => ({ "report/index.html": `<html><body><pre>${t.replace(/</g, "&lt;")}</pre></body></html>` })],
  ["screenshot metadata", (t) => ({ "shots/fail.png": makePng("Comment", t.replace(/\n/g, " "), "tEXt") })],
  ["JSON report", (t) => ({ "results.json": JSON.stringify({ packs: [{ id: "platform", outcome: "FAIL", tests: [{ error: t }] }] }) })],
];

describe("planted secrets: every shape in every artifact type is reported", () => {
  for (const [type, place] of ARTIFACT_TYPES) {
    for (const p of SHAPES) {
      it(`${p.kind} in a ${type}`, () => {
        const { files, findings } = scanDir(dirWith(place(p.text)), { env: {} });
        expect(files).toBe(1);
        expect(kinds(findings)).toContain(p.kind);
      });
    }
  }

  it("covers every static shape the scrub declares", () => {
    const planted = new Set(SHAPES.map((s) => s.kind));
    // header-pair is the HAR name/value form, planted in its own test below.
    for (const k of SHAPE_KINDS.filter((k) => k !== "header-pair")) expect(planted, `no planted secret for ${k}`).toContain(k);
  });

  it("finds header and cookie pairs in the HAR name/value form", () => {
    const secret = filler("pair", 30);
    const har = JSON.stringify({
      log: {
        entries: [
          {
            request: {
              headers: [
                { name: "Accept", value: "text/html" },
                { name: "Authorization", value: `Negotiate ${secret}` },
              ],
              cookies: [{ name: "__Host-fx_session", value: secret }],
            },
          },
        ],
      },
    });
    const { findings } = scanDir(dirWith({ "network.json": har }), { env: {} });
    expect(kinds(findings)).toContain("header-pair");
  });
});

describe("planted secrets: every encoding is looked through", () => {
  const encodings: [string, (text: string) => Record<string, Buffer | string>][] = [
    ["url-encoded", (t) => ({ "run.log": `GET /cb?state=${encodeURIComponent(t)}\n` })],
    ["base64 in JSON", (t) => ({ "r.json": JSON.stringify({ blob: Buffer.from(t).toString("base64") }) })],
    ["base64url in JSON", (t) => ({ "r.json": JSON.stringify({ blob: Buffer.from(t).toString("base64url") }) })],
    ["JSON unicode escapes", (t) => ({ "r.json": `{"m":"${[...t].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")}"}` })],
    ["base64 inside URL-encoding", (t) => ({ "run.log": encodeURIComponent(Buffer.from(t).toString("base64")) })],
    ["HTML entities", (t) => ({ "r.html": [...t].map((c) => `&#${c.charCodeAt(0)};`).join("") })],
    ["hex", (t) => ({ "r.txt": Buffer.from(t).toString("hex") })],
  ];
  for (const [label, place] of encodings) {
    for (const p of SHAPES) {
      it(`${p.kind}: ${label}`, () => {
        const { findings } = scanDir(dirWith(place(p.text)), { env: {} });
        expect(kinds(findings)).toContain(p.kind);
      });
    }
  }

  const pngKinds: PngTextKind[] = ["tEXt", "zTXt", "iTXt", "iTXt-compressed"];
  for (const kind of pngKinds) {
    it(`finds a secret in a PNG ${kind} chunk`, () => {
      const p = SHAPES[0]!;
      const { findings } = scanDir(dirWith({ "s.png": makePng("Comment", p.text, kind) }), { env: {} });
      expect(kinds(findings)).toContain(p.kind);
    });
  }
});

describe("runtime values and the run's own environment", () => {
  const runtimeSecret = filler("runtime", 36);
  const envSecret = filler("env", 36);

  it("finds a registered runtime value in every artifact type, wrapped in plain context", () => {
    const registry = silent();
    registry.register(runtimeSecret);
    for (const [type, place] of ARTIFACT_TYPES) {
      const { findings } = scanDir(dirWith(place(`value is ${runtimeSecret}`)), { registry, env: {} });
      expect(kinds(findings), type).toContain("runtime-value");
    }
  });

  it("finds a registered value that is base64, URL-encoded, hex or in a PNG chunk", () => {
    const registry = silent();
    registry.register(runtimeSecret);
    const cases: Record<string, Record<string, Buffer | string>> = {
      base64: { "x.json": JSON.stringify({ b: Buffer.from(runtimeSecret).toString("base64") }) },
      url: { "x.log": encodeURIComponent(`${runtimeSecret}`) },
      hex: { "x.txt": Buffer.from(runtimeSecret).toString("hex") },
      png: { "s.png": makePng("k", runtimeSecret, "zTXt") },
    };
    for (const [name, files] of Object.entries(cases)) {
      expect(kinds(scanDir(dirWith(files), { registry, env: {} }).findings), name).toContain("runtime-value");
    }
  });

  it("catches a value registered after the scan started, in a file already scanned", () => {
    const registry = silent();
    const dir = dirWith({ "a.log": `first ${runtimeSecret}`, "b.log": "nothing", "c.json": JSON.stringify({ z: runtimeSecret }) });
    let registered = false;
    const result = scanDir(dir, { registry, env: {} }, {
      onFileScanned: () => {
        if (!registered) {
          registered = true;
          registry.register(runtimeSecret);
        }
      },
    });
    expect(registered).toBe(true);
    expect(result.findings.filter((f) => f.kind === "runtime-value").map((f) => f.path)).toEqual(["a.log", "c.json"]);
    expect(result.upload).toEqual(["b.log"]);
  });

  it("without the registration the same folder is clean (the value has no shape of its own)", () => {
    const dir = dirWith({ "a.log": `first ${runtimeSecret}` });
    expect(scanDir(dir, { registry: silent(), env: {} }).findings).toEqual([]);
  });

  it("fails closed when the registry keeps changing during the scan", () => {
    const registry = silent();
    const dir = dirWith({ "a.log": "x" });
    let n = 0;
    const result = scanDir(dir, { registry, env: {} }, { onFileScanned: () => registry.register(filler(`s${(n += 1)}`, 20)) });
    expect(kinds(result.findings)).toEqual(["unscannable:mask-registry-kept-changing"]);
    expect(result.upload).toEqual([]);
  });

  it("a file-backed registry carries values between processes (two instances on one file)", () => {
    const maskDir = scratch();
    const file = join(maskDir, "mask.txt");
    new MaskRegistry({ emit: () => undefined, file, create: true }).register(runtimeSecret);
    const reader = new MaskRegistry({ emit: () => undefined, file });
    expect(reader.values()).toContain(runtimeSecret);
    expect(kinds(scanDir(dirWith({ "a.log": runtimeSecret }), { registry: reader, env: {} }).findings)).toContain("runtime-value");
  });

  it("a mask file inside the scanned folder is itself a finding", () => {
    const dir = scratch();
    const registry = new MaskRegistry({ emit: () => undefined, file: join(dir, "mask.txt"), create: true });
    registry.register(runtimeSecret);
    const { findings } = scanDir(dir, { registry, env: {} });
    expect(kinds(findings)).toContain("unscannable:mask-file-inside-artifacts");
  });

  it("finds a secret-looking value of the run's own environment, however it is wrapped", () => {
    const env = { LIVE_E2E_SOMETHING_ELSE: envSecret };
    for (const [type, place] of ARTIFACT_TYPES) {
      expect(kinds(scanDir(dirWith(place(`x ${envSecret} y`)), { env }).findings), type).toContain("env-value");
    }
    expect(kinds(scanDir(dirWith({ "a.json": JSON.stringify({ x: Buffer.from(envSecret).toString("base64") }) }), { env }).findings)).toContain("env-value");
  });

  it("treats runner-provided public values as public, and anything credential-named as secret", () => {
    const env = {
      GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
      GITHUB_REPOSITORY: "fulcrumaxe/cloud",
      PATH: "/usr/bin:/bin:/usr/local/bin",
      HOME: "/home/live-e2e",
      GITHUB_TOKEN: filler("gh", 30),
      VERCEL_AUTOMATION_BYPASS_SECRET: filler("by", 32),
      GITHUB_ENV: "/home/runner/work/_temp/_runner_file_commands/set_env_x",
    };
    const values = envSecretValues(env);
    expect(values).toContain(env.GITHUB_TOKEN);
    expect(values).toContain(env.VERCEL_AUTOMATION_BYPASS_SECRET);
    expect(values).not.toContain(env.GITHUB_SHA);
    expect(values).not.toContain(env.PATH);
    expect(values).not.toContain(env.GITHUB_ENV);
  });

  it("a declared env name counts as secret even if its name does not say so", () => {
    expect(envSecretValues({ GITHUB_REPOSITORY_ID: "1234567890" }, ["GITHUB_REPOSITORY_ID"])).toEqual(["1234567890"]);
  });
});

describe("an allowed file that is not what it claims is a finding (fail closed)", () => {
  const png = makePng("k", "clean", "tEXt");
  const cases: [string, Record<string, Buffer | string>, string][] = [
    ["a .log that is not UTF-8", { "a.log": Buffer.from([0x68, 0x69, 0xff, 0xfe, 0x20, 0x21]) }, "unscannable:not-utf8"],
    ["a .json holding NUL bytes (UTF-16 text)", { "a.json": Buffer.from('{"a":1}', "utf16le") }, "unscannable:not-text"],
    ["a .txt that is really a gzip file", { "a.txt": Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x4b, 0x04]) }, "unscannable:not-text"],
    ["a .png that is not a PNG", { "a.png": "plain text" }, "unscannable:png-invalid"],
    ["a PNG without IEND", { "a.png": png.subarray(0, png.length - 12) }, "unscannable:png-no-iend"],
    ["a PNG cut off in a chunk", { "a.png": png.subarray(0, 45) }, "unscannable:png-truncated"],
    ["a PNG with data after IEND", { "a.png": Buffer.concat([png, Buffer.from("trailer")]) }, "unscannable:png-trailing-data"],
    ["a PNG with a corrupt zTXt stream", { "a.png": Buffer.concat([png.subarray(0, png.length - 12), pngChunk("zTXt", Buffer.from("k\0\0not zlib data")), png.subarray(png.length - 12)]) }, "unscannable:png-inflate-failed-or-too-large"],
  ];
  for (const [name, files, kind] of cases) {
    it(`reports ${name}, and leaves it out of the upload set`, () => {
      const result = scanDir(dirWith(files), { env: {} });
      expect(kinds(result.findings)).toContain(kind);
      expect(result.upload).toEqual([]);
    });
  }

  it("an empty folder is clean with zero files", () => {
    expect(scanDir(scratch(), { env: {} })).toEqual({ files: 0, findings: [], upload: [], notUploaded: [], includedUnscanned: [] });
  });
});

describe("the upload allowlist", () => {
  const allowed = {
    "logs/run.log": "x",
    "a.txt": "x",
    "notes.md": "# x",
    "r.json": "{}",
    "e.jsonl": "{}\n",
    "report/index.html": "<p>x</p>",
    "shots/s.png": makePng("k", "clean", "tEXt"),
  };
  const notAllowed: Record<string, [string, Buffer | string]> = {
    "trace.zip": ["zip", makeZip([{ name: "a", data: "x" }])],
    "out.tar": ["tar", Buffer.alloc(1024)],
    "test-results/0-trace.trace": ["trace", '{"type":"log"}\n'],
    "network.har": ["har", "{}"],
    "video.webm": ["video", Buffer.from([0x1a, 0x45, 0xdf, 0xa3])],
    "blob.bin": ["unknown", Buffer.from([1, 2, 3])],
    "noext": ["unknown", "text without an extension"],
    "x.gz": ["gzip", Buffer.from([0x1f, 0x8b])],
  };

  it("uploads exactly the allowed types, sorted, and lists every other file as not uploaded (not an error)", () => {
    const files: Record<string, Buffer | string> = { ...allowed };
    for (const [name, [, data]] of Object.entries(notAllowed)) files[name] = data;
    const result = scanDir(dirWith(files), { env: {} });
    expect(result.findings).toEqual([]);
    expect(result.upload.sort()).toEqual(Object.keys(allowed).sort());
    expect(result.notUploaded.map((n) => [n.path, n.type]).sort()).toEqual(Object.entries(notAllowed).map(([n, [t]]) => [n, t]).sort());
    expect(result.includedUnscanned).toEqual([]);
  });

  it("a not-uploaded file is not opened: a secret in it is no finding, and it is not in the upload set", () => {
    const secret = SHAPES[0]!.text;
    const result = scanDir(dirWith({ "network.har": secret, "trace.zip": makeZip([{ name: "a", data: secret }]) }), { env: {} });
    expect(result.findings).toEqual([]);
    expect(result.upload).toEqual([]);
  });

  it("a file with a finding is not in the upload set, a clean neighbour is", () => {
    const result = scanDir(dirWith({ "bad.log": SHAPES[0]!.text, "good.log": "fine" }), { env: {} });
    expect(result.upload).toEqual(["good.log"]);
  });

  it("symlinks and special files are never followed or uploaded", () => {
    const dir = dirWith({ "a.log": "x" });
    symlinkSync("/etc/hostname", join(dir, "link.log"));
    const result = scanDir(dir, { env: {} });
    expect(result.upload).toEqual(["a.log"]);
    expect(result.notUploaded).toEqual([{ path: "link.log", type: "symlink" }]);
  });

  it("the opt-in puts matching non-allowlisted files in the upload set unscanned, and says so", () => {
    const dir = dirWith({ "trace.zip": makeZip([{ name: "a", data: "x" }]), "keep/net.har": "{}", "other.zip": "zz", "a.log": "x" });
    const result = scanDir(dir, { env: {} }, { includeUnscanned: ["trace.zip", "keep/*.har"] });
    expect(result.findings).toEqual([]);
    expect(result.upload.sort()).toEqual(["a.log", "keep/net.har", "trace.zip"]);
    expect(result.includedUnscanned.sort()).toEqual(["keep/net.har", "trace.zip"]);
    expect(result.notUploaded).toEqual([{ path: "other.zip", type: "zip" }]);
  });

  it("the opt-in still checks the raw bytes of an included file, and drops it on a match", () => {
    const secret = SHAPES[0]!.text;
    const result = scanDir(dirWith({ "network.har": `{"x":"${secret}"}` }), { env: {} }, { includeUnscanned: ["*.har"] });
    expect(kinds(result.findings)).toContain("stripe-key");
    expect(result.upload).toEqual([]);
  });

  it("the opt-in never makes a name-only match upload an allowed-type check bypass: text files are still checked", () => {
    const result = scanDir(dirWith({ "a.log": SHAPES[0]!.text }), { env: {} }, { includeUnscanned: ["*.log"] });
    expect(kinds(result.findings)).toContain("stripe-key");
    expect(result.includedUnscanned).toEqual([]);
  });

  it("glob rules: ** crosses folders, * does not, ? is one character, a slash-free glob matches the file name", () => {
    const dir = dirWith({ "a/b/c.zip": "z", "a/c.zip": "z", "c1.zip": "z", "cc.zip": "z" });
    const only = (g: string) => scanDir(dir, { env: {} }, { includeUnscanned: [g] }).includedUnscanned.sort();
    expect(only("**/*.zip")).toEqual(["a/b/c.zip", "a/c.zip", "c1.zip", "cc.zip"]);
    expect(only("a/*.zip")).toEqual(["a/c.zip"]);
    expect(only("c?.zip")).toEqual(["c1.zip", "cc.zip", "a/b/c.zip", "a/c.zip"].filter((x) => !x.includes("/")).sort());
    expect(only("c.zip")).toEqual(["a/b/c.zip", "a/c.zip"]);
  });
});

describe("findings never echo the secret", () => {
  it("a secret in a file name stays out of every finding and every listing", () => {
    const secret = ["sk", "_live_", filler("name", 24)].join("");
    const dir = dirWith({ [`${secret}.log`]: "x", [`${secret}.zip`]: "z" });
    symlinkSync("/etc/hostname", join(dir, `link-${secret}.log`));
    const result = scanDir(dir, { env: {} });
    expect(result.findings.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.findings.map(describeFinding).join("\n")).not.toContain(secret);
  });

  it("every planted shape: no finding contains the secret", () => {
    for (const p of SHAPES) {
      const findings = scanDir(dirWith({ "r.log": p.text }), { env: {} }).findings;
      expect(JSON.stringify(findings)).not.toContain(p.secret);
    }
  });
});

describe("findings never echo the secret", () => {
  it("a secret in a file name, a zip entry name and a nested path stays out of every finding", () => {
    const secret = ["sk", "_live_", filler("name", 24)].join("");
    const dir = dirWith({ [`${secret}.log`]: "x", "a.zip": makeZip([{ name: `dir-${secret}.txt`, data: `body ${secret}` }]) });
    const findings = scanDir(dir, { env: {} }).findings;
    expect(findings.length).toBeGreaterThan(0);
    expect(JSON.stringify(findings)).not.toContain(secret);
    expect(findings.map(describeFinding).join("\n")).not.toContain(secret);
  });

  it("every planted shape: no finding contains the secret", () => {
    for (const p of SHAPES) {
      const findings = scanDir(dirWith({ "r.log": p.text }), { env: {} }).findings;
      expect(JSON.stringify(findings)).not.toContain(p.secret);
    }
  });
});

describe("no false alarms on what a healthy run writes", () => {
  it("passes a request log that keeps header names only, prose, a commit sha and redaction markers", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const files = {
      "request-log.json": JSON.stringify([
        { method: "GET", url: "https://staging.example.test/api/health", status: 200, headers: ["authorization", "cookie", "x-vercel-protection-bypass", "set-cookie"] },
      ]),
      "run.log": [
        "platform: refused without bearer tokens, as expected",
        "expected 401 without an Authorization header",
        "the cookie was not set; no session cookie jar exists",
        `deployed commit ${sha}`,
        "Authorization: [REDACTED:authorization-header]",
        "stripe key sk_live_[REDACTED:stripe-key]",
      ].join("\n"),
      "results.json": JSON.stringify({ commit: sha, packs: [] }),
    };
    expect(scanDir(dirWith(files), { env: { GITHUB_SHA: sha } }).findings).toEqual([]);
  });
});

describe("redact", () => {
  it("removes every planted shape from text, leaving a marker and none of the secret", () => {
    for (const p of SHAPES) {
      const out = redact(`before\n${p.text}\nafter`, { env: {} });
      expect(out, p.kind).not.toContain(p.secret);
      expect(out).toContain("[REDACTED");
      expect(detect(out, { env: {} }), p.kind).toEqual([]);
    }
  });

  it("is idempotent", () => {
    for (const p of SHAPES) {
      const once = redact(p.text, { env: {} });
      expect(redact(once, { env: {} })).toBe(once);
    }
  });

  it("removes registered and env values, including their URL-encoded and base64 forms", () => {
    const registry = silent();
    const rt = `${filler("rt", 20)}/+${filler("rt2", 8)}`;
    registry.register(rt);
    const env = { WHATEVER_NAME: filler("ev", 24) };
    const ctx: ScrubContext = { registry, env };
    const text = [rt, encodeURIComponent(rt), Buffer.from(rt).toString("base64"), Buffer.from(rt).toString("base64url"), env.WHATEVER_NAME].join(" | ");
    const out = redact(text, ctx);
    expect(out).not.toContain(rt);
    expect(out).not.toContain(env.WHATEVER_NAME);
    expect(out).not.toContain(encodeURIComponent(rt));
    expect(out).not.toContain(Buffer.from(rt).toString("base64"));
    expect(detect(out, ctx)).toEqual([]);
  });

  it("assertClean refuses what redaction cannot rewrite (a base64 copy of a shaped secret)", () => {
    const p = SHAPES[0]!;
    const hidden = Buffer.from(p.text).toString("base64");
    const out = redact(`blob ${hidden}`, { env: {} });
    expect(out).toContain(hidden);
    expect(() => assertClean(out, { env: {} })).toThrow(ScrubError);
    expect(() => assertClean(out, { env: {} })).toThrow(/stripe-key \(base64\)/);
  });
});

describe("nothing is written to disk unless it is clean", () => {
  const results = (error: string) =>
    buildResults({
      target: "staging",
      started_at: "2026-10-05T10:00:00Z",
      finished_at: "2026-10-05T10:01:00Z",
      packs: [{ id: "platform", outcome: "FAIL", duration_ms: 10, devices: ["desktop"], cost_usd: 0, tests: [{ title: "t", device: "desktop", status: "failed", duration_ms: 1, error }] }],
    });

  it("the written report holds none of the planted shapes, and a scan of the folder is clean", () => {
    for (const p of SHAPES) {
      const dir = scratch();
      writeReport(dir, results(`expected 200\n${p.text}\nreceived 401`), { env: {} });
      const written = readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
      expect(written, p.kind).not.toContain(p.secret);
      expect(scanDir(dir, { env: {} }).findings, p.kind).toEqual([]);
    }
  });

  it("the written report holds no registered runtime value or env value", () => {
    const registry = silent();
    const rt = filler("rep", 30);
    registry.register(rt);
    const env = { SOME_RUN_VALUE: filler("rep2", 30) };
    const dir = scratch();
    writeReport(dir, results(`${rt} and ${env.SOME_RUN_VALUE}`), { registry, env });
    const written = readFileSync(join(dir, "results.json"), "utf8");
    expect(written).not.toContain(rt);
    expect(written).not.toContain(env.SOME_RUN_VALUE);
  });

  it("writeScrubbed (logs, the request log) redacts before the file exists", () => {
    const dir = scratch();
    for (const p of SHAPES) {
      const file = join(dir, `${filler(p.kind + p.secret, 6)}.log`);
      writeScrubbed(file, `line\n${p.text}\n`, { env: {} });
      expect(readFileSync(file, "utf8")).not.toContain(p.secret);
    }
    expect(scanDir(dir, { env: {} }).findings).toEqual([]);
  });

  it("when a secret survives redaction nothing is written at all", () => {
    const hidden = Buffer.from(SHAPES[0]!.text).toString("base64");
    const dir = scratch();
    expect(() => writeReport(dir, results(`blob ${hidden}`), { env: {} })).toThrow(ScrubError);
    expect(readdirSync(dir)).toEqual([]);
    const file = join(dir, "x.log");
    expect(() => writeScrubbed(file, `blob ${hidden}`, { env: {} })).toThrow(ScrubError);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("a secret in a key of the data is redacted too", () => {
    const secret = ["ghp", "_", filler("key", 36)].join("");
    const dir = scratch();
    writeReport(dir, { ...results("x"), extra: { [secret]: 1 } } as never, { env: {} });
    expect(readFileSync(join(dir, "results.json"), "utf8")).not.toContain(secret);
  });
});

describe("mask registry", () => {
  it("announces the mask before returning, one add-mask command per line, with workflow-command escaping", () => {
    const lines: string[] = [];
    const registry = new MaskRegistry({ emit: (l) => lines.push(l) });
    expect(registry.register("abc%def\nsecond line value")).toBe(true);
    expect(lines).toEqual(["::add-mask::abc%25def", "::add-mask::second line value"]);
  });

  it("announces a value that is too short to track, but does not track it", () => {
    const lines: string[] = [];
    const registry = new MaskRegistry({ emit: (l) => lines.push(l) });
    expect(registry.register("short")).toBe(false);
    expect(lines).toEqual(["::add-mask::short"]);
    expect(registry.values()).toEqual([]);
  });

  it("refuses an empty value", () => {
    expect(() => silent().register("")).toThrow(MaskError);
  });

  it("writes the backing file readable by its owner only", () => {
    const file = join(scratch(), "mask.txt");
    new MaskRegistry({ emit: () => undefined, file, create: true }).register("a-long-enough-secret");
    expect(statMode(file)).toBe(0o600);
  });

  it("rejects a corrupt mask file instead of ignoring it", () => {
    const file = join(scratch(), "mask.txt");
    writeFileSync(file, "not json\n", { mode: 0o600 });
    expect(() => new MaskRegistry({ emit: () => undefined, file })).toThrow(MaskError);
  });
});

describe("live-e2e scrub (the upload gate)", () => {
  it("exits 0 and says so on a clean folder", async () => {
    const dir = dirWith({ "a.log": "all good" });
    const { io, out } = makeIo(dir);
    expect(await main(["scrub", "--dir", dir], io)).toBe(0);
    expect(out.join("\n")).toContain("1 file(s) scanned, 1 to upload, 0 not uploaded, 0 finding(s)");
  });

  it("exits 1 on each of: a secret in a log, base64 in a JSON file, URL-encoded in a log, a PNG text chunk", async () => {
    const secret = SHAPES[0]!.text;
    const cases: Record<string, Record<string, Buffer | string>> = {
      log: { "run.log": secret },
      base64InJson: { "d.json": JSON.stringify({ blob: Buffer.from(secret).toString("base64") }) },
      urlEncodedLog: { "run.log": `redirect ${encodeURIComponent(secret)}` },
      png: { "s.png": makePng("k", secret, "zTXt") },
    };
    for (const [name, files] of Object.entries(cases)) {
      const dir = dirWith(files);
      const { io, err } = makeIo(dir);
      expect(await main(["scrub", "--dir", dir], io), name).toBe(1);
      expect(err.join("\n"), name).toContain("SECRET");
      expect(err.join("\n"), name).not.toContain(SHAPES[0]!.secret);
    }
  });

  it("lists not-uploaded files, exits 0, and writes the upload set as a manifest", async () => {
    const dir = dirWith({ "a.log": "x", "trace.zip": "z", "net.har": "{}" });
    const manifest = join(scratch(), "m", "upload.json");
    const { io, out } = makeIo(dir);
    expect(await main(["scrub", "--dir", dir, "--manifest", manifest], io)).toBe(0);
    expect(out).toContain("not-uploaded:zip trace.zip");
    expect(out).toContain("not-uploaded:har net.har");
    expect(JSON.parse(readFileSync(manifest, "utf8"))).toEqual({
      version: 1,
      upload: ["a.log"],
      not_uploaded: [{ path: "net.har", type: "har" }, { path: "trace.zip", type: "zip" }],
      included_unscanned: [],
    });
  });

  it("--include-unscanned puts the file in the manifest on staging, says so, and needs --target", async () => {
    const dir = dirWith({ "a.log": "x", "trace.zip": "z" });
    const manifest = join(scratch(), "upload.json");
    const root = scratchRoot([]);
    const { io, out, err } = makeIo(root);
    expect(await main(["scrub", "--dir", dir, "--manifest", manifest, "--include-unscanned", "*.zip", "--target", "staging"], io)).toBe(0);
    expect(out).toContain("included-unscanned trace.zip");
    expect(JSON.parse(readFileSync(manifest, "utf8")).upload).toEqual(["a.log", "trace.zip"]);
    expect(await main(["scrub", "--dir", dir, "--include-unscanned", "*.zip"], io)).toBe(2);
    expect(err.join("\n")).toContain("needs --target");
  });

  it("--include-unscanned is refused on production, and nothing is scanned or written", async () => {
    const dir = dirWith({ "a.log": "x", "trace.zip": "z" });
    const manifest = join(scratch(), "upload.json");
    const root = scratchRoot([]);
    const { io, err } = makeIo(root);
    expect(await main(["scrub", "--dir", dir, "--manifest", manifest, "--include-unscanned", "*.zip", "--target", "production"], io)).toBe(2);
    expect(err.join("\n")).toContain("REFUSED include-unscanned-on-production");
    expect(existsSync(manifest)).toBe(false);
    expect(await main(["scrub", "--dir", dir, "--include-unscanned", "*.zip", "--target", "nowhere"], io)).toBe(2);
  });

  it("uses the mask file and the environment of the process it runs in", async () => {
    const dir = dirWith({ "a.log": `x ${filler("gate", 30)} y`, "b.log": `z ${filler("gate2", 30)}` });
    const maskFile = join(scratch(), "mask.txt");
    new MaskRegistry({ emit: () => undefined, file: maskFile, create: true }).register(filler("gate", 30));
    const { io, err } = makeIo(dir, { [MASK_FILE_ENV]: maskFile, ANOTHER_VALUE: filler("gate2", 30) }, GOOD_HOST);
    expect(await main(["scrub", "--dir", dir], io)).toBe(1);
    expect(err.filter((l) => l.includes("runtime-value")).length).toBe(1);
    expect(err.filter((l) => l.includes("env-value")).length).toBe(1);
  });

  it("exits 2 on bad usage", async () => {
    const { io, err } = makeIo(scratch());
    expect(await main(["scrub"], io)).toBe(2);
    expect(await main(["scrub", "--dir"], io)).toBe(2);
    expect(await main(["scrub", "--dir", "a", "b"], io)).toBe(2);
    expect(await main(["scrub", "--dir", "a", "--bogus", "b"], io)).toBe(2);
    expect(err.length).toBe(4);
  });
});

function statMode(file: string): number {
  return statSync(file).mode & 0o777;
}
