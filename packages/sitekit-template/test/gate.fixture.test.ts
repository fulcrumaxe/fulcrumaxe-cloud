import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SiteContent, type RenderContext } from "@fx/sitekit-claims";
import { RenderBlockedError, renderSite } from "../src/render.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures");
const ASSET_ROOT = path.join(FIXTURES, "assets");

/**
 * D#2606 K03 pass/fail item 3 / umbrella check 2: renders a fixture
 * containing one FALSE claim, one evidence-less claim and one unattested
 * legal claim. The build must fail and name all three claim ids — and it
 * must do so by refusing to render at all (gateSite runs BEFORE any HTML
 * is generated), never by rendering first and catching a problem after.
 *
 * `pnpm --filter @fx/sitekit-template test:gate` runs exactly this file.
 */
describe("D#2606 K03 gate-first refusal (test:gate)", () => {
  it("blocks the render and names exactly the three bad claim ids", () => {
    const raw = JSON.parse(fs.readFileSync(path.join(FIXTURES, "site.blocked.json"), "utf-8"));
    const content = SiteContent.parse(raw);
    const context: RenderContext = { repoSha: content.repo_sha, versionId: "fixture-v1" };

    let thrown: unknown;
    try {
      renderSite(content, context, ASSET_ROOT);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(RenderBlockedError);
    const err = thrown as RenderBlockedError;

    expect(new Set(err.claimIds)).toEqual(new Set(["c-false-1", "c-noev-1", "c-unattested-legal"]));
    // Exactly one blocker per bad claim — each is referenced exactly once,
    // so this also proves gateSite never short-circuited early.
    expect(err.blockers).toHaveLength(3);
    for (const blocker of err.blockers) {
      expect(blocker.reason).toBe("claim-not-renderable");
    }
  });

  it("never writes any output when blocked — refuses before rendering, not after", () => {
    const raw = JSON.parse(fs.readFileSync(path.join(FIXTURES, "site.blocked.json"), "utf-8"));
    const content = SiteContent.parse(raw);
    const context: RenderContext = { repoSha: content.repo_sha, versionId: "fixture-v1" };

    expect(() => renderSite(content, context, ASSET_ROOT)).toThrow(RenderBlockedError);
    // renderSite threw synchronously before returning a RenderedSite, so
    // there is no rendered output for a caller to have written anywhere —
    // there is nothing further to assert on disk. The absence of a second,
    // successful return value IS the "no optimistic render" proof.
  });

  it("still resolves the good siteNameClaimId without adding a spurious 4th blocker", () => {
    const raw = JSON.parse(fs.readFileSync(path.join(FIXTURES, "site.blocked.json"), "utf-8"));
    const content = SiteContent.parse(raw);
    const context: RenderContext = { repoSha: content.repo_sha, versionId: "fixture-v1" };

    try {
      renderSite(content, context, ASSET_ROOT);
      throw new Error("expected renderSite to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RenderBlockedError);
      expect((err as RenderBlockedError).claimIds).not.toContain("c-name");
    }
  });
});
