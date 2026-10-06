#!/usr/bin/env -S pnpm exec tsx
/**
 * D#2606 K03 pass/fail item 1: `pnpm --filter @fx/sitekit-template
 * build:fixture` statically renders test/fixtures/site.json to HTML.
 *
 * Usage: tsx scripts/build-fixture.ts [inputPath] [outDir]
 * Defaults: test/fixtures/site.json -> dist-fixture/
 *
 * Zero model tokens, zero network calls: this only parses a local JSON
 * fixture, runs it through gateSite, and writes static files.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { SiteContent, type RenderContext } from "@fx/sitekit-claims";
import { RenderBlockedError, renderSite, writeRenderedSite } from "../src/render.js";

/** Fixed for every fixture build — the fixture's ATTESTED claims (see
 * test/fixtures/site.json's legal-page and one pricing plan) carry this
 * same version id in their attestation. A real pipeline (K07) would pass
 * whatever site_versions id is actually being published instead. */
const FIXTURE_VERSION_ID = "fixture-v1";

async function main(): Promise<number> {
  const inputPath = path.resolve(process.argv[2] ?? "test/fixtures/site.json");
  const outDir = path.resolve(process.argv[3] ?? "dist-fixture");
  const assetRoot = path.resolve("test/fixtures/assets");

  const raw = JSON.parse(fs.readFileSync(inputPath, "utf-8"));
  const content = SiteContent.parse(raw);
  const context: RenderContext = { repoSha: content.repo_sha, versionId: FIXTURE_VERSION_ID };

  let rendered;
  try {
    rendered = renderSite(content, context, assetRoot);
  } catch (err) {
    if (err instanceof RenderBlockedError) {
      console.error(`build failed: ${err.blockers.length} blocking claim(s)`);
      for (const b of err.blockers) {
        console.error(`  [${b.reason}] claim=${b.claimId ?? "(none)"} ${b.detail}`);
      }
      console.error(`blocking claim ids: ${err.claimIds.join(", ")}`);
      return 1;
    }
    throw err;
  }

  await writeRenderedSite(rendered, outDir);
  console.log(`rendered ${rendered.pages.length} page(s) to ${outDir}`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
