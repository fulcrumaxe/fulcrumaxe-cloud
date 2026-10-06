#!/usr/bin/env node
// apps/web/scripts/check-env-manifest.mjs
//
// Production build gate for the settings list in apps/web/env-manifest.ts.
//
// - FX_ENFORCE_ENV_MANIFEST unset (or "" / "0"): returns at once, before
//   loading anything, so local builds and previews are never blocked.
// - FX_ENFORCE_ENV_MANIFEST=1: the build FAILS when a setting required for the
//   deploy kind is missing or invalid. FX_DEPLOY_KIND picks the kind
//   (staging | production | local); unset means production, because setting
//   the flag at all says "hold this build to the deployed list".
// - Messages carry variable names and fixed reason codes only, never a value.
//
// Run by apps/web's "prebuild" script after copy-workspace and before the
// migrate step, so a build with a bad setting stops before it touches the
// database. `--write-docs` rewrites the generated settings tables in
// docs/ops/staging.md from the manifest instead of checking anything.
//
// The manifest and checker are TypeScript; this file is plain JS and loads
// them with `node --experimental-strip-types`.

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const FLAG = "FX_ENFORCE_ENV_MANIFEST";
export const KIND_VAR = "FX_DEPLOY_KIND";

export class EnvManifestError extends Error {
  constructor(message) {
    super(message);
    this.name = "EnvManifestError";
  }
}

async function loadModules() {
  const [manifest, check] = await Promise.all([
    import(new URL("../env-manifest.ts", import.meta.url).href),
    import(new URL("../lib/env/check.ts", import.meta.url).href),
  ]);
  return { ENV_MANIFEST: manifest.ENV_MANIFEST, evaluateEnv: check.evaluateEnv, isDeployKind: check.isDeployKind };
}

/**
 * Returns { status: "skipped" } or { status: "checked", report }.
 * Throws EnvManifestError (message safe to print) when the flag is set and a required setting is missing or invalid.
 */
export async function checkEnvManifest({ env = process.env, log = console.log, load = loadModules } = {}) {
  const flag = env[FLAG];
  if (flag === undefined || flag === "" || flag === "0") return { status: "skipped" };
  if (flag !== "1") throw new EnvManifestError(`${FLAG} must be 1 to check the settings list, or unset; got an unrecognised value`);

  const { ENV_MANIFEST, evaluateEnv, isDeployKind } = await load();
  const declared = env[KIND_VAR]?.trim();
  if (declared && !isDeployKind(declared)) {
    throw new EnvManifestError(`${KIND_VAR} must be staging, production or local; got an unrecognised value`);
  }
  const kind = declared || "production";
  const report = evaluateEnv(ENV_MANIFEST, env, kind);

  for (const item of report.invalidOptional) {
    log(`check-env-manifest: warning - optional ${item.name} is set but invalid (${item.reason})`);
  }
  if (!report.ok) {
    const parts = [];
    if (report.missing.length > 0) parts.push(`missing: ${report.missing.join(", ")}`);
    if (report.invalid.length > 0) parts.push(`invalid: ${report.invalid.map((i) => `${i.name} (${i.reason})`).join(", ")}`);
    throw new EnvManifestError(
      `required settings for a ${kind} build are not usable (${parts.join("; ")}). Set them in the Vercel project's environment. See docs/ops/staging.md. No value was printed.`,
    );
  }
  log(`check-env-manifest: ${kind} settings ok (${report.disabled.length} optional feature(s) off)`);
  return { status: "checked", report };
}

async function writeDocs() {
  const { ENV_MANIFEST } = await loadModules();
  const docs = await import(new URL("../lib/env/docs.ts", import.meta.url).href);
  const file = new URL("../../../docs/ops/staging.md", import.meta.url);
  const next = docs.replaceGeneratedBlock(readFileSync(file, "utf8"), docs.renderEnvDocs(ENV_MANIFEST));
  if (next === null) throw new EnvManifestError("docs/ops/staging.md has no env-manifest markers");
  writeFileSync(file, next);
  console.log("check-env-manifest: docs/ops/staging.md updated");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.includes("--write-docs")) await writeDocs();
    else await checkEnvManifest();
  } catch (err) {
    console.error(`check-env-manifest: FAILED - ${err instanceof EnvManifestError ? err.message : "unexpected error"}`);
    process.exit(1);
  }
}
