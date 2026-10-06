import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkLinkPolicy, runPublishGates, scanLeaks } from "../src/index.js";

const dirs: string[] = [];
async function site(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "k06r2-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), body);
  }
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const page = (inner: string) => `<html><body>${inner}</body></html>`;
const TOKEN = "ghp_" + "Y".repeat(36);
const AWS = "AKIA" + "ABCDEFGHIJKLMNOP";

describe("round 2 (recheck MUSTs and SHOULD)", () => {
  it("MUST 1: a token in a link path is masked everywhere in the report", async () => {
    const hook = `https://hooks.partner.example/services/T0/B0/${TOKEN}`;
    const dir = await site({ "index.html": page(`<a href="${hook}">p</a>`) });
    const rep = await runPublishGates(dir);
    expect(JSON.stringify(rep)).not.toContain(TOKEN);
    expect(rep.pendingLinks).toEqual(["https://hooks.partner.example/services/T0/B0/***"]);
    expect((await checkLinkPolicy(dir, { approvedLinks: [hook] })).ok).toBe(true);
  });

  it.each([
    "https&#58//evil.example/x",
    "https&#x3a//evil.example/x",
    "https&#X3A//evil.example/x",
    "https&#58;//evil.example/x",
    "https&colon;//evil.example/x",
    "https:&sol;&sol;evil.example/x",
  ])("MUST 2: finds the link in %s", async (href) => {
    const dir = await site({ "index.html": page(`<a href="${href}">p</a>`) });
    const res = await checkLinkPolicy(dir, { siteDomains: ["acme.example"] });
    expect(res.findings.map((f) => f.kind)).toEqual(["unapproved_outbound_link"]);
  });

  it("MUST 2: legacy named references decode without a semicolon", async () => {
    const dir = await site({
      "index.html": page(`<a href="https://evil.example/a?x=1&ampy=2">p</a><a href="https://evil2.example/&nbsp">q</a><a href="https://evil3.example/&quot">r</a>`),
    });
    const res = await checkLinkPolicy(dir);
    expect(res.findings.map((f) => f.message.match(/to (\S+) /)?.[1]).sort()).toEqual(["evil.example", "evil2.example", "evil3.example"]);
  });

  it("SHOULD: UTF-16 text (BOM or not, either endianness) is scanned decoded", async () => {
    const dir = await site({});
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`key ${TOKEN}`, "utf16le")]);
    const be = Buffer.from(`key ${AWS}`, "utf16le").swap16();
    await writeFile(path.join(dir, "a.txt"), le);
    await writeFile(path.join(dir, "b.txt"), be);
    const res = await scanLeaks(dir);
    expect(res.ok).toBe(false);
    expect(res.findings.map((f) => `${f.path}:${f.kind}`).sort()).toEqual(["/a.txt:github_token", "/b.txt:aws_access_key"]);
  });

  it("SHOULD: a NUL-bearing non-binary file is an error; a real binary stays advisory", async () => {
    const dir = await site({ "notes.txt": `\u0000${TOKEN}`, "logo.png": "\u0089PNG\u0000\u0000x" });
    const res = await scanLeaks(dir);
    const byPath = Object.fromEntries(res.findings.map((f) => [f.path, f]));
    expect(byPath["/notes.txt"]).toMatchObject({ kind: "unscanned_file", severity: "error" });
    expect(byPath["/logo.png"]).toMatchObject({ kind: "unscanned_file", severity: "advisory" });
    expect(res.ok).toBe(false);
  });
});
