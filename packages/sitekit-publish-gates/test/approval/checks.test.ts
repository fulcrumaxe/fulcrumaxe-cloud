import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SiteContent } from "../../../sitekit-claims/src/index.js";
import { renderSite, writeRenderedSite } from "../../../sitekit-template/src/index.js";

const calls = vi.hoisted(() => [] as { fn: string; options: Record<string, unknown> | undefined }[]);
const FNS = vi.hoisted(() => ["checkLinks", "checkMeta", "checkNojs", "checkWeight", "checkRedaction", "checkA11y", "checkFreshness", "checkRender", "checkA11yStructure", "checkMotion", "checkDegrade"]);
vi.mock("@fx/sitekit-checks", () =>
  Object.fromEntries(FNS.map((fn) => [fn, async (_dir: string, options?: Record<string, unknown>) => (calls.push({ fn, options }), { ok: true, findings: [] })])),
);

import { BROWSER_CHECKS, STATIC_CHECKS, evidenceCommitsOf, runApprovalChecks } from "../../src/approval/checks.js";

const driver = { open: async () => { throw new Error("unused"); }, close: async () => {} };

describe("approval checks (K07c)", () => {
  it("pins the exact list: seven static and four browser checks, nothing else", async () => {
    expect([...STATIC_CHECKS]).toEqual(["check-links", "check-meta", "check-nojs", "check-weight", "check-redaction", "check-a11y", "check-freshness"]);
    expect([...BROWSER_CHECKS]).toEqual(["check-render", "check-a11y-structure", "check-motion", "check-degrade"]);
    calls.length = 0;
    const report = await runApprovalChecks("/x", { siteDomains: [], now: new Date(0) });
    expect(report.checks.map((c) => c.check)).toEqual([...STATIC_CHECKS, ...BROWSER_CHECKS]);
    expect(calls.map((c) => c.fn).sort()).toEqual([...FNS].sort());
  });

  it("runs links offline with the site's domains, freshness on the approval clock, and gives the driver to the browser checks only", async () => {
    calls.length = 0;
    const now = new Date("2026-09-29T00:00:00Z");
    await runApprovalChecks("/x", { siteDomains: ["example.com"], now, driver });
    const by = Object.fromEntries(calls.map((c) => [c.fn, c.options]));
    expect(by.checkLinks).toEqual({ live: false, siteDomains: ["example.com"] });
    expect(by.checkFreshness).toEqual({ now });
    for (const fn of ["checkRender", "checkA11yStructure", "checkMotion", "checkDegrade"]) expect(by[fn]).toEqual({ driver });
    for (const fn of ["checkMeta", "checkNojs", "checkWeight", "checkRedaction", "checkA11y"]) expect(by[fn]).toBeUndefined();
  });
});

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "89abcdef0123456789abcdef0123456789abcdef";

describe("evidence commits for check-redaction (D3-REDACT)", () => {
  it("is built from the version's own repo, repo_sha and claim rows, keeping only 40 or 64 lowercase hex", () => {
    const ev = evidenceCommitsOf({ repo: "acme/widget-kit" }, SHA, [{ checked_sha: OTHER }, { checked_sha: "a1b2c3d4e5f6" }, { checked_sha: SHA.toUpperCase() }, { checked_sha: null }, {}]);
    expect(ev).toEqual({ host: "github.com", repo: "acme/widget-kit", shas: [SHA, OTHER] });
    expect(evidenceCommitsOf({}, SHA, []).repo).toBe("");
  });

  it("runApprovalChecks hands the option to check-redaction only, and only when given", async () => {
    calls.length = 0;
    const evidenceCommits = { host: "github.com" as const, repo: "acme/widget-kit", shas: [SHA] };
    await runApprovalChecks("/x", { siteDomains: [], now: new Date(0), evidenceCommits });
    expect(calls.find((c) => c.fn === "checkRedaction")?.options).toEqual({ evidenceCommits });
    for (const c of calls.filter((c) => c.fn !== "checkRedaction")) expect(JSON.stringify(c.options ?? {})).not.toContain("evidenceCommits");
  });

  it("S7 end to end: a real render with 40-hex commit ids passes check-redaction, and one non-matching evidence sha fails it", async () => {
    const real = await vi.importActual<typeof import("@fx/sitekit-checks")>("@fx/sitekit-checks");
    const fixture = path.join(__dirname, "../../../sitekit-template/test/fixtures");
    const raw = readFileSync(path.join(fixture, "site.json"), "utf-8").split("a1b2c3d4e5f6").join(SHA);
    const render = async (json: string) => {
      const content = SiteContent.parse(JSON.parse(json));
      const dir = await mkdtemp(path.join(tmpdir(), "d3-redact-"));
      try {
        await writeRenderedSite(renderSite(content, { repoSha: content.repo_sha, versionId: "fixture-v1" }, path.join(fixture, "assets")), dir);
        const ev = evidenceCommitsOf(content, content.repo_sha, content.claims);
        return { without: await real.checkRedaction(dir), withOpt: await real.checkRedaction(dir, { evidenceCommits: ev }) };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    };
    const ok = await render(raw);
    expect(ok.without.ok).toBe(false);
    expect(ok.withOpt.findings).toEqual([]);
    expect(ok.withOpt.ok).toBe(true);

    // gateSite refuses a VERIFIED claim whose checked_sha differs from repo_sha, so the mismatch is planted in the
    // rendered page instead: one evidence link's commit segment becomes a different, well-formed 40-hex value.
    const content = SiteContent.parse(JSON.parse(raw));
    const dir = await mkdtemp(path.join(tmpdir(), "d3-redact-"));
    try {
      await writeRenderedSite(renderSite(content, { repoSha: content.repo_sha, versionId: "fixture-v1" }, path.join(fixture, "assets")), dir);
      const page = path.join(dir, "index.html");
      const html = readFileSync(page, "utf-8");
      expect(html).toContain(`/blob/${SHA}/`);
      writeFileSync(page, html.replace(`/blob/${SHA}/`, `/blob/${OTHER}/`));
      const r = await real.checkRedaction(dir, { evidenceCommits: evidenceCommitsOf(content, content.repo_sha, content.claims) });
      expect(r.ok).toBe(false);
      expect(r.findings.map((f) => f.message)).toEqual([`40+ char hex blob: ${JSON.stringify(OTHER)}`]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

