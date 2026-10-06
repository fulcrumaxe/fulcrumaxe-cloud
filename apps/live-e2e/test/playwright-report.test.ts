/**
 * Real Playwright output (1.63): the HTML report keeps stdout, errors and attachments in a deflate zip, base64
 * encoded in a <template id="playwrightReportBase64"> element. The fixture is built here with the same
 * structure (a report.json plus one <hash>.json per test file, all deflated); it is small and synthetic.
 * Fake secrets are built at run time.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { envSecretValues, isPathValue, MaskRegistry } from "../src/mask.js";
import { scanDir, type Finding } from "../src/scrub.js";
import { filler, makePng, noiseBytes, makeZip, type ZipFile } from "./artifacts.js";
import { makeIo } from "./helpers.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "t2a_pwr_"));
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
const RT = ["rt", filler("pwr", 30)].join("Q");
function scan(files: Record<string, Buffer | string>, env: Record<string, string | undefined> = {}) {
  const registry = new MaskRegistry({ emit: () => undefined });
  registry.register(RT);
  return scanDir(dirWith(files), { registry, env });
}

interface TestSpec {
  title: string;
  stdout?: string[];
  errors?: string[];
  attachments?: { name: string; contentType: string; body: Buffer }[];
}

/** One <hash>.json: the per-file data the HTML reporter stores (tests, results, stdout, errors, attachments). */
function fileJson(tests: TestSpec[]): string {
  return JSON.stringify({
    fileId: filler("fid", 20).toLowerCase(),
    fileName: "packs/platform/platform.spec.ts",
    tests: tests.map((t, i) => ({
      testId: `${filler("tid", 20).toLowerCase()}-${i}`,
      title: t.title,
      projectName: "desktop",
      location: { file: "packs/platform/platform.spec.ts", line: 10 + i, column: 5 },
      duration: 1200 + i,
      annotations: [],
      tags: ["@api"],
      outcome: t.errors ? "unexpected" : "expected",
      path: ["", "desktop", "platform.spec.ts"],
      ok: !t.errors,
      results: [
        {
          retry: 0,
          startTime: "2026-10-05T10:00:00.000Z",
          duration: 1200,
          steps: [{ title: "Navigate to /", startTime: "2026-10-05T10:00:00.100Z", duration: 300 }],
          errors: (t.errors ?? []).map((message) => ({ message })),
          stdout: (t.stdout ?? []).map((text) => ({ text })),
          stderr: [],
          status: t.errors ? "failed" : "passed",
          attachments: (t.attachments ?? []).map((a) => ({ name: a.name, contentType: a.contentType, body: a.body.toString("base64") })),
        },
      ],
    })),
  });
}

function reportHtml(tests: TestSpec[], extra: ZipFile[] = [], options: { bundle?: string; zip?: Buffer } = {}): string {
  const zip =
    options.zip ??
    makeZip([
      { name: "report.json", data: JSON.stringify({ metadata: { actualWorkers: 1 }, files: [{ fileName: "platform.spec.ts", tests: tests.length }], stats: { total: tests.length } }), timestamp: true },
      { name: `${filler("h", 20).toLowerCase()}.json`, data: fileJson(tests), timestamp: true },
      ...extra,
    ]);
  return `<!DOCTYPE html>\n<html><head><meta charset="UTF-8"><title>Playwright Test Report</title><script type="module">${options.bundle ?? "var a=1;"}</script></head><body><div id="root"></div><template id="playwrightReportBase64">data:application/zip;base64,${zip.toString("base64")}</template></body></html>`;
}

describe("Playwright HTML report", () => {
  it("a clean report is uploaded, listed in the manifest, and the gate exits 0", async () => {
    const html = reportHtml([{ title: "home renders", stdout: ["navigated to /"] }, { title: "second page" }]);
    const dir = dirWith({ "playwright-report/index.html": html, "results.json": "{}" });
    const manifest = join(scratch(), "m.json");
    const { io } = makeIo(dir);
    expect(await main(["scrub", "--dir", dir, "--manifest", manifest], io)).toBe(0);
    expect(JSON.parse(readFileSync(manifest, "utf8")).upload).toEqual(["playwright-report/index.html", "results.json"]);
  });

  const secrets = {
    stripe: ["rk", "_test_", filler("rep", 24)].join(""),
    jwt: [Buffer.from('{"alg":"HS256"}').toString("base64url"), Buffer.from('{"sub":"u1"}').toString("base64url"), filler("sg", 43)].join("."),
  };

  it("finds a secret printed to stdout, one in an error message, and one in a text attachment", () => {
    const cases: [string, TestSpec, string][] = [
      ["stdout", { title: "t", stdout: [`token is ${secrets.stripe}\n`] }, "stripe-key"],
      ["error text", { title: "t", errors: [`Error: expected 200\nBearer ${secrets.jwt} was rejected`] }, "bearer-token"],
      ["jwt in an error", { title: "t", errors: [`session ${secrets.jwt} invalid`] }, "jwt"],
      ["text attachment", { title: "t", attachments: [{ name: "response.txt", contentType: "text/plain", body: Buffer.from(`body ${RT}`) }] }, "runtime-value"],
    ];
    for (const [name, spec, kind] of cases) {
      const result = scan({ "playwright-report/index.html": reportHtml([spec]) });
      expect(kinds(result.findings), name).toContain(kind);
      expect(result.findings.some((f) => f.via.startsWith("report>")), name).toBe(true);
      expect(result.upload, name).toEqual([]);
      expect(JSON.stringify(result), name).not.toContain(secrets.stripe);
    }
  });

  it("finds a secret in an entry name", () => {
    const html = reportHtml([{ title: "t" }], [{ name: `data/${RT}.txt`, data: "x" }]);
    expect(kinds(scan({ "i.html": html }).findings)).toContain("runtime-value");
  });

  it("a binary attachment inside the report keeps the whole report out of the upload set (not an error)", () => {
    const html = reportHtml([{ title: "t" }], [{ name: "data/video.webm", data: randomBytes(300), method: 0 }]);
    const result = scan({ "playwright-report/index.html": html });
    expect(result.findings).toEqual([]);
    expect(result.upload).toEqual([]);
    expect(result.notUploaded).toEqual([{ path: "playwright-report/index.html", type: "report-binary-attachment" }]);
  });

  it("a PNG attachment inside the report is allowed when clean, and its text chunks are checked", () => {
    const clean = reportHtml([{ title: "t" }], [{ name: "data/shot.png", data: makePng("Software", "Chromium", "tEXt"), method: 0 }]);
    expect(scan({ "i.html": clean })).toMatchObject({ findings: [], upload: ["i.html"] });
    const leaky = reportHtml([{ title: "t" }], [{ name: "data/shot.png", data: makePng("Comment", `x ${RT}`, "zTXt"), method: 0 }]);
    const result = scan({ "i.html": leaky });
    expect(kinds(result.findings)).toContain("runtime-value");
    expect(result.findings.some((f) => f.via.startsWith("report>png-text"))).toBe(true);
  });

  it("is bounded: entry count, inflated size, compression ratio, methods, encryption, trailing data, shape", () => {
    const html = (zip: Buffer) => reportHtml([], [], { zip });
    const many = makeZip(Array.from({ length: 5001 }, (_, i) => ({ name: `e${i}.json`, data: "{}", method: 0 })));
    expect(kinds(scan({ "i.html": html(many) }).findings)).toContain("unscannable:report-too-many-entries");
    const huge = makeZip([{ name: "big.txt", data: Buffer.alloc(70 * 1024 * 1024) }]);
    expect(kinds(scan({ "i.html": html(huge) }).findings)).toContain("unscannable:report-too-large");
    const bomb = makeZip([{ name: "z.txt", data: Buffer.alloc(3 * 1024 * 1024) }]);
    expect(kinds(scan({ "i.html": html(bomb) }).findings)).toContain("unscannable:report-compression-ratio");
    expect(kinds(scan({ "i.html": html(makeZip([{ name: "a", data: "x", method: 14 }])) }).findings)).toContain("unscannable:report-zip-method-14");
    expect(kinds(scan({ "i.html": html(makeZip([{ name: "a", data: "x", encrypted: true }])) }).findings)).toContain("unscannable:report-zip-encrypted");
    expect(kinds(scan({ "i.html": html(Buffer.concat([makeZip([{ name: "a", data: "x" }]), Buffer.from("tail")])) }).findings)).toContain("unscannable:report-zip-trailing-data");
    expect(kinds(scan({ "i.html": html(Buffer.from("not a zip at all, just text")) }).findings)).toContain("unscannable:report-zip-invalid");
    const other = `<template id="playwrightReportBase64">data:text/plain;base64,${Buffer.from("x").toString("base64")}</template>`;
    expect(kinds(scan({ "i.html": other }).findings)).toContain("unscannable:report-unknown-format");
    expect(kinds(scan({ "i.html": '<template id="playwrightReportBase64">data:application/zip;base64,AAAA' }).findings)).toContain("unscannable:report-unknown-format");
  }, 120_000);

  it("only an .html file is treated as a report", () => {
    const body = reportHtml([{ title: "t", stdout: [secrets.stripe] }]);
    expect(kinds(scan({ "i.txt": body }).findings)).not.toContain("unscannable:report-zip-invalid");
  });
});

describe("other archives carried inside a text file are not uploaded (and not parsed)", () => {
  const zip = makeZip([{ name: "a.txt", data: `x ${RT}` }]);
  const gz = gzipSync(`x ${RT}`);
  it("a base64 zip or gzip, at any alignment, in any text file type, leaves the file out", () => {
    for (const ext of ["log", "json", "txt", "html", "md", "jsonl"]) {
      for (const [label, blob] of [["zip", zip], ["gzip", gz]] as const) {
        for (const prefix of ["", "a", "ab", "abc", "id_"]) {
          const text = `{"blob":"${prefix}${Buffer.concat([Buffer.from(prefix === "" ? "" : "\0\0\0"), blob]).toString("base64").slice(0)}"}`;
          const result = scan({ [`f.${ext}`]: text });
          expect(result.upload, `${label} ${ext} ${JSON.stringify(prefix)}`).toEqual([]);
          expect(result.notUploaded, `${label} ${ext} ${JSON.stringify(prefix)}`).toEqual([{ path: `f.${ext}`, type: "embedded-archive" }]);
        }
      }
    }
  });

  it("random base64, a PNG data URL and plain prose are still uploaded", () => {
    const text = `data:image/png;base64,${makePng("k", "clean", "tEXt").toString("base64")}\n${noiseBytes(100_000, 541).toString("base64")}\nsome prose`;
    expect(scan({ "f.html": text })).toMatchObject({ findings: [], upload: ["f.html"] });
  });
});

describe("clean realistic output does not fail the gate", () => {
  it("a 0.5 MB inline JS bundle with thousands of hex ids, a 400-entry JSON body and a 1000-line UUID log scan clean", () => {
    const hex = (n: number) => randomBytes(n).toString("hex");
    const bundle = Array.from({ length: 8000 }, (_, i) => `var _${i}="${hex(10)}",f${i}=function(a){return a+"${hex(4)}"};`).join("\n");
    const results = JSON.stringify({ suites: Array.from({ length: 400 }, (_, i) => ({ id: hex(10), attachments: [{ name: hex(20), path: `/tmp/pw/${hex(8)}/shot-${i}.png` }] })) });
    const uuid = () => `${hex(4)}-${hex(2)}-${hex(2)}-${hex(2)}-${hex(6)}`;
    const log = Array.from({ length: 1000 }, (_, i) => `${i} GET /api/x/${uuid()} 200`).join("\n");
    const started = Date.now();
    const result = scan({ "playwright-report/index.html": reportHtml([{ title: "t" }], [], { bundle }), "results.json": results, "request.log": log });
    expect(result.findings).toEqual([]);
    expect(result.upload.sort()).toEqual(["playwright-report/index.html", "request.log", "results.json"]);
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 60_000);
});

describe("environment values that are paths, token shapes next to letters, and *_KEY assignments", () => {
  it("path-valued variables are public, whatever their name; a secret that starts with a slash is not", () => {
    const env = {
      TEMPDIR: "/tmp/nix-shell.abc123/claude-1000/scratch",
      OUTPUT_DIR_SECRET_NAME: "/home/live-e2e/work/cloud/test-results",
      SEARCH_PATHS: "/usr/bin:/nix/store/abc-bin/bin:/opt/x",
      SLASH_SECRET: `/${filler("sl", 20)}+${filler("sm", 10)}=`,
      SLASH_TOKEN: `/${filler("st", 30)}`,
    };
    const values = envSecretValues(env);
    expect(values).not.toContain(env.TEMPDIR);
    expect(values).not.toContain(env.OUTPUT_DIR_SECRET_NAME);
    expect(values).not.toContain(env.SEARCH_PATHS);
    expect(values).toContain(env.SLASH_SECRET);
    expect(values).toContain(env.SLASH_TOKEN);
    expect(isPathValue("/etc/ssl/certs")).toBe(true);
    expect(isPathValue("/Zq9aXk3/abc")).toBe(false);
    expect(isPathValue("relative/path")).toBe(false);
  });

  it("a path variable's value in Playwright JSON is no false red", () => {
    const env = { TEMPDIR: "/tmp/nix-shell.abc123/claude-1000/scratch" };
    const json = JSON.stringify({ config: { rootDir: env.TEMPDIR, outputDir: `${env.TEMPDIR}/test-results` } });
    expect(scan({ "results.json": json }, env)).toMatchObject({ findings: [], upload: ["results.json"] });
  });

  it("static shapes match when glued to letters or digits, but not names like risk_test_something", () => {
    const key = ["sk", "_live_", filler("gl", 24)].join("");
    for (const glued of [`abc${key}`, `9${key}`, `${key}xyz`, `x${["ghp", "_", filler("g2", 36)].join("")}`, `q${["sk", "-ant-", filler("an", 30)].join("")}`, `z${["AK", "IA", "ABCDEFGHIJKLMNOP"].join("")}`]) {
      expect(scan({ "a.log": glued }).findings.length, glued.slice(0, 8)).toBeGreaterThan(0);
    }
    expect(scan({ "a.log": "risk_test_something and task_test_runner and mask_live_data" }).findings).toEqual([]);
  });

  it("*_KEY assignments are caught: STRIPE_SECRET_KEY=, SSH_KEY=, APP_PAT=", () => {
    for (const name of ["STRIPE_SECRET_KEY", "SSH_KEY", "APP_PAT", "DB_PASSWD", "AWS_CREDENTIALS", "SERVICE_DSN"]) {
      expect(kinds(scan({ "a.log": `${name}=${filler(name, 24)}` }).findings), name).toContain("env-assignment");
    }
    expect(scan({ "a.log": "NODE_ENV=production and KEY_COUNT=12345678" }).findings).toEqual([]);
  });
});
