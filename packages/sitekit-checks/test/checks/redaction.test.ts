import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { GENERIC_LEAK_PATTERNS, GENERIC_LEAK_PLANTS, run as checkRedaction } from "../../src/checks/redaction.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "check-redaction");

describe("check-redaction", () => {
  it("passes a fixture with no secrets and no denied strings", async () => {
    const result = await checkRedaction(path.join(FIXTURES, "pass"), {
      denyAccounts: ["rivertail-labs"],
      denyHosts: ["build.rivertail-labs.internal.example"],
    });
    expect(result.ok).toBe(true);
  });

  it("fails the B5 shape: a private GitHub account and a private host, parameterized per site", async () => {
    // Placeholder names invented for this fixture — not the real private
    // names from the os-site-v2 accuracy report (D#2606 K02 item 3).
    const result = await checkRedaction(path.join(FIXTURES, "fail"), {
      denyAccounts: ["rivertail-labs"],
      denyHosts: ["build.rivertail-labs.internal.example"],
    });
    expect(result.ok).toBe(false);
    const messages = result.findings.map((f) => f.message).join("\n");
    expect(messages).toContain("rivertail-labs");
    expect(messages).toContain("build.rivertail-labs.internal.example");
  });

  it("without a deny-list, the B5 fixture's private strings are NOT generic secrets and pass", async () => {
    // Proves the per-site parameters are load-bearing, not decorative.
    const result = await checkRedaction(path.join(FIXTURES, "fail"), {});
    expect(result.ok).toBe(true);
  });

  it("negative control: every generic pattern fires on its own canonical plant", () => {
    for (const [name, re] of GENERIC_LEAK_PATTERNS) {
      re.lastIndex = 0;
      expect(re.test(GENERIC_LEAK_PLANTS[name]), `${name} never fires`).toBe(true);
    }
  });
});

// Evidence-commit exemption (opt-in). Every case plants a different way of trying to slip a 40+ hex string through.
const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "89abcdef0123456789abcdef0123456789abcdef";
const SHA64 = SHA + "89abcdef0123456789abcdef";
const REPO = "acme/widget-kit";
const EV = { host: "github.com" as const, repo: REPO, shas: [SHA, SHA64] };
const link = (url: string) => `<a class="evidence" href="${url}">[source]</a>`;
const good = (sha = SHA) => link(`https://github.com/${REPO}/blob/${sha}/src/a.ts#L1-L2`);

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function site(files: Record<string, string>): string {
  const d = mkdtempSync(path.join(tmpdir(), "redaction-ev-"));
  dirs.push(d);
  for (const [name, body] of Object.entries(files)) { mkdirSync(path.dirname(path.join(d, name)), { recursive: true }); writeFileSync(path.join(d, name), body); }
  return d;
}
const page = (body: string) => `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;
const withEv = (files: Record<string, string>, ev = EV) => checkRedaction(site(files), { evidenceCommits: ev });

describe("check-redaction evidence-commit exemption", () => {
  it("exempts the exact commit segment of a known evidence link (40 and 64 hex)", async () => {
    expect((await withEv({ "index.html": page(good() + good(SHA64)) })).findings).toEqual([]);
  });

  it("S6: without the option the same page is refused, and an unrelated option changes nothing", async () => {
    const dir = site({ "index.html": page(good()) });
    for (const opts of [undefined, {}, { denyHosts: ["x.test"], denyAccounts: ["nobody"] }]) {
      const r = await checkRedaction(dir, opts);
      expect(r.ok).toBe(false);
      expect(r.findings.map((f) => f.message)).toEqual([`40+ char hex blob: ${JSON.stringify(SHA)}`]);
    }
  });

  it("S1: outside the one position nothing changes", async () => {
    const cases: Record<string, Record<string, string>> = {
      "page text": { "index.html": page(`<p>${SHA}</p>`) },
      "src attribute": { "index.html": page(`<img src="${SHA}.png" alt="">`) },
      "data attribute": { "index.html": page(`<p data-x="${SHA}">x</p>`) },
      "meta content": { "index.html": page(`<meta name="k" content="${SHA}">`) },
      "title attribute": { "index.html": page(`<a href="/x" title="${SHA}">x</a>`) },
      "href on a non-anchor": { "index.html": page(`<link href="https://github.com/${REPO}/blob/${SHA}/a.ts">`) },
      "json": { "a.json": JSON.stringify({ u: `https://github.com/${REPO}/blob/${SHA}/a.ts` }) },
      "js": { "a.js": `var x = "https://github.com/${REPO}/blob/${SHA}/a.ts";` },
      "css": { "a.css": `a{content:"${SHA}"}` },
      "txt": { "a.txt": `https://github.com/${REPO}/blob/${SHA}/a.ts` },
      "xml": { "a.xml": `<u>https://github.com/${REPO}/blob/${SHA}/a.ts</u>` },
      "gitlab": { "index.html": page(link(`https://gitlab.com/${REPO}/blob/${SHA}/a.ts`)) },
      "lookalike host": { "index.html": page(link(`https://github.com.evil.test/${REPO}/blob/${SHA}/a.ts`)) },
      "path host": { "index.html": page(link(`https://evil.test/github.com/${REPO}/blob/${SHA}/a.ts`)) },
      "userinfo": { "index.html": page(link(`https://user@github.com/${REPO}/blob/${SHA}/a.ts`)) },
      "port": { "index.html": page(link(`https://github.com:8443/${REPO}/blob/${SHA}/a.ts`)) },
      "http": { "index.html": page(link(`http://github.com/${REPO}/blob/${SHA}/a.ts`)) },
      "other repo": { "index.html": page(link(`https://github.com/acme/other/blob/${SHA}/a.ts`)) },
      "owner slot": { "index.html": page(link(`https://github.com/${SHA}/widget-kit/blob/${SHA}/a.ts`)) },
      "after the sha": { "index.html": page(link(`https://github.com/${REPO}/blob/${SHA}/${SHA}.ts`)) },
      "query": { "index.html": page(link(`https://github.com/${REPO}/blob/${SHA}/a.ts?x=${SHA}`)) },
      "fragment": { "index.html": page(link(`https://github.com/${REPO}/blob/${SHA}/a.ts#${SHA}`)) },
      "commit url": { "index.html": page(link(`https://github.com/${REPO}/commit/${SHA}`)) },
      "tree url": { "index.html": page(link(`https://github.com/${REPO}/tree/${SHA}/src`)) },
      "raw url": { "index.html": page(link(`https://github.com/${REPO}/raw/${SHA}/a.ts`)) },
      "inside a comment": { "index.html": page(`<!-- ${good()} -->`) },
      "inside a script": { "index.html": page(`<script>var a = '${good()}';</script>`) },
      "two hrefs": { "index.html": page(`<a href="/ok" href="https://github.com/${REPO}/blob/${SHA}/a.ts">x</a>`) },
      "href inside another attribute": { "index.html": page(`<a title=" href='https://github.com/${REPO}/blob/${SHA}/a.ts'" href="/ok">x</a>`) },
      "entity-encoded prefix": { "index.html": page(link(`https://github.com/${REPO}&#47;blob/${SHA}/a.ts`)) },
    };
    for (const [name, files] of Object.entries(cases)) {
      const r = await withEv(files);
      expect(r.ok, name).toBe(false);
      expect(r.findings.some((f) => f.message.startsWith("40+ char hex blob: ")), name).toBe(true);
    }
  });

  it("S2: a well-formed slot holding a 40-hex that is not the site's commit is refused", async () => {
    const r = await withEv({ "index.html": page(good(OTHER)) });
    expect(r.ok).toBe(false);
    expect(r.findings[0].message).toBe(`40+ char hex blob: ${JSON.stringify(OTHER)}`);
  });

  it("S3: exact shape only, even when the stored value itself is malformed", async () => {
    const odd = [SHA.slice(0, 39), SHA + "a", SHA64.slice(0, 63), SHA.toUpperCase(), SHA + "-x"];
    for (const sha of odd) {
      const r = await withEv({ "index.html": page(good(sha)) }, { ...EV, shas: [...EV.shas, sha] });
      // 39 hex is below the rule's threshold, so it is allowed to pass the hex rule; every longer or odd one is refused.
      expect(r.ok, sha).toBe(sha.length < 40);
    }
  });

  it("S4: an exempt commit early in a page cannot hide a bare 40-hex later in the same file", async () => {
    const r = await withEv({ "index.html": page(good() + `<p>${OTHER}</p>`) });
    expect(r.ok).toBe(false);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].message).toBe(`40+ char hex blob: ${JSON.stringify(OTHER)}`);
    // Also when the later one is the known commit outside the slot.
    expect((await withEv({ "index.html": page(good() + `<p>${SHA}</p>`) })).ok).toBe(false);
  });

  it("S5: other patterns still see the whole evidence URL", async () => {
    const rests = { "GitHub token": "ghp_abcdefghijklmnopqrstuv", "email address": "me@example.org", "absolute home path": "home/someone/x.ts" };
    for (const [name, rest] of Object.entries(rests)) {
      const r = await withEv({ "index.html": page(link(`https://github.com/${REPO}/blob/${SHA}/${rest}`)) });
      expect(r.ok, name).toBe(false);
      expect(r.findings.map((f) => f.message.split(":")[0]), name).toEqual([name]);
    }
  });

  it("S8: the finding text still shows at most the first 60 characters of the match", async () => {
    const long = "a".repeat(100);
    const r = await withEv({ "index.html": page(`<p>${long}</p>`) });
    expect(r.findings[0].message).toBe(`40+ char hex blob: ${JSON.stringify("a".repeat(60))}`);
  });

  it("ignores a malformed repo option instead of widening the exemption", async () => {
    for (const repo of ["", "acme", "acme/widget/kit", "acme/*"]) {
      expect((await withEv({ "index.html": page(good()) }, { ...EV, repo })).ok, repo).toBe(false);
    }
  });
});

// The scan runs server-side over customer-controlled HTML, so its cost must be linear in the input. Chosen bound: a
// generous wall clock on the whole check-redaction run (the quadratic scan takes minutes at these sizes, so the margin
// against a loaded CI host is several orders of magnitude) — not a per-operation counter, which would not see work done
// inside a single regex call.
describe("check-redaction evidence-commit scan is linear", () => {
  const LIMIT_MS = 5000;
  const LINK_LIMIT_MS = 5000; // each evidence link costs a URL parse; the quadratic lookup took ~10 s at 50k links, ~150 s at 200k
  const shapes: Record<string, () => string> = {
    "1M spaces inside one tag": () => `<a${" ".repeat(1_000_000)}href="/x">x</a>`,
    "1M spaces, tag never closed": () => `<a${" ".repeat(1_000_000)}`,
    "500k tabs inside one tag": () => `<a${"\t".repeat(500_000)}href="/x">x</a>`,
    "500k newlines inside one tag": () => `<a${"\n".repeat(500_000)}href="/x">x</a>`,
    "500k slashes and spaces": () => `<a${"/ ".repeat(250_000)}href="/x">x</a>`,
    "500k equals signs": () => `<a ${"=".repeat(500_000)}>x</a>`,
    "many unterminated <a openings": () => "<a ".repeat(200_000),
    "many unterminated <a openings with attributes": () => "<a href=x ".repeat(100_000),
    "100k attributes": () => `<a ${'d="1" '.repeat(100_000)}href="/x">x</a>`,
    "100k whitespace-padded attributes": () => `<a ${"d   =   '1'   ".repeat(60_000)}href="/x">x</a>`,
    "200k evidence links": () => good().repeat(200_000),
    "200k evidence links, each followed by the same hex": () => `${good()}<i>`.repeat(200_000) + `<p>${OTHER}</p>`,
  };
  for (const [name, build] of Object.entries(shapes)) {
    const limit = name.includes("evidence links") ? LINK_LIMIT_MS : LIMIT_MS;
    it(`${name} finishes well inside ${limit} ms`, async () => {
      const dir = site({ "index.html": build() });
      const t0 = performance.now();
      await checkRedaction(dir, { evidenceCommits: EV });
      const ms = performance.now() - t0;
      console.log(`redaction-linear ${name}: ${ms.toFixed(0)} ms`);
      expect(ms).toBeLessThan(limit);
    });
  }

  it("still exempts the evidence link and refuses the stray hex after a huge whitespace run", async () => {
    const big = `<a${" ".repeat(300_000)}class="evidence"${"\n".repeat(300_000)}href="https://github.com/${REPO}/blob/${SHA}/a.ts">x</a>`;
    expect((await withEv({ "index.html": page(big) })).findings).toEqual([]);
    const r = await withEv({ "index.html": page(big + `<p>${OTHER}</p>`) });
    expect(r.findings.map((f) => f.message)).toEqual([`40+ char hex blob: ${JSON.stringify(OTHER)}`]);
  });
});
