import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listSourcePaths } from "../../../packages/test-guard/src/sourceFiles.js";

/**
 * Static isolation scans (OPS-C2-7, -8, -11 and -13, with the owner-side rulings R-68-C2-2 and R-68-C2-4). They read the tree as
 * text, so they hold whatever the build does.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const OPS = path.join(ROOT, "apps", "ops");
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", ".swc", "dist", "build", ".turbo", "coverage", "public"]);
const TEXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json|sql|sh|yaml|yml|md)$/;

interface SourceFile {
  rel: string;
  text: string;
}
/** Git's file list, not a directory walk: ignored build output is scanned by the built-output checks below, not as source. */
const load = (dirs: string[]): SourceFile[] =>
  listSourcePaths(ROOT, dirs, SKIP_DIRS)
    .filter((f) => TEXT.test(f) && statSync(f).size < 2_000_000)
    .map((f) => ({ rel: path.relative(ROOT, f), text: readFileSync(f, "utf8") }));

// ----------------------------------------------------------------------------------------------- apps/ops contents

/** Names apps/ops must never reference: the tenant and platform doors, and the secrets only apps/web may hold. */
const FORBIDDEN_NAMES: RegExp[] = [
  /\bsignSession\b/,
  /\bwithTenant\b/,
  /\bwithPlatformOps\b/,
  /\bwithPartner\b/,
  /DATABASE_URL_PLATFORM_OPS/,
  /DATABASE_URL_APP_USER/,
  /FX_SESSION_SECRET/,
  /FX_KEK/,
  /STRIPE_SECRET_KEY/,
  /STRIPE_WEBHOOK_SECRET/,
];

/** R-68-C2-4: this file proves the scan (it must spell the names), and the cross-token test needs the tenant signer and its secret, and nothing else. */
const EXEMPT_FILES = new Set(["apps/ops/test/scan.test.ts"]);
const NAMES_ALLOWED_IN: Record<string, RegExp[]> = {
  "apps/ops/test/tenant-isolation.test.ts": [/\bsignSession\b/, /FX_SESSION_SECRET/],
};

export function forbiddenReferences(files: SourceFile[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (EXEMPT_FILES.has(f.rel)) continue;
    const allowed = NAMES_ALLOWED_IN[f.rel] ?? [];
    for (const re of FORBIDDEN_NAMES) {
      if (allowed.some((a) => a.source === re.source)) continue;
      if (re.test(f.text)) out.push(`${f.rel}: ${re.source}`);
    }
  }
  return out;
}

/** An import (static, dynamic, require or re-export) of the API package's routes, principal or event streams. Type-only imports are erased and allowed. */
export function bannedApiImports(files: SourceFile[]): string[] {
  const statement = /(?:^|[\s;])(import|export)(\s+type)?\s*(?:[^;'"`]*?\sfrom\s*|\s*)["']([^"']+)["']|(?:\bimport|\brequire)\(\s*["']([^"']+)["']\s*\)/g;
  const banned = (spec: string) => /^@fx\/api(\/|$)/.test(spec) || /(^|\/)packages\/api(\/|$)/.test(spec);
  const out: string[] = [];
  for (const f of files) {
    if (EXEMPT_FILES.has(f.rel)) continue;
    for (const m of f.text.matchAll(statement)) {
      const spec = m[3] ?? m[4];
      const typeOnly = m[1] !== undefined && m[2] !== undefined;
      if (spec && banned(spec) && !typeOnly) out.push(`${f.rel}: ${spec}`);
    }
  }
  return out;
}

const opsFiles = load(["apps/ops"]).filter((f) => !f.rel.endsWith("tsconfig.tsbuildinfo"));
const opsSource = opsFiles.filter((f) => !f.rel.startsWith("apps/ops/test/") && /\.(ts|tsx|mjs|js)$/.test(f.rel));

describe("apps/ops references (OPS-C2-7)", () => {
  it("scans a real set of files (sanity)", () => {
    expect(opsFiles.length).toBeGreaterThan(20);
    expect(opsFiles.some((f) => f.rel === "apps/ops/lib/withStaff.ts")).toBe(true);
  });

  it("no file imports a tenant or platform entry point or names a platform, tenant-session, KEK or Stripe secret", () => {
    expect(forbiddenReferences(opsFiles)).toEqual([]);
  });

  it("the scan can fail: it flags each forbidden name in a fixture, and honours only the exact exemption", () => {
    for (const re of FORBIDDEN_NAMES) {
      const name = re.source.replace(/\\b/g, "");
      expect(forbiddenReferences([{ rel: "apps/ops/lib/x.ts", text: `const a = ${name};` }]), name).toEqual([`apps/ops/lib/x.ts: ${re.source}`]);
    }
    const tenantTest = "apps/ops/test/tenant-isolation.test.ts";
    expect(forbiddenReferences([{ rel: tenantTest, text: "signSession(); FX_SESSION_SECRET" }])).toEqual([]);
    expect(forbiddenReferences([{ rel: tenantTest, text: "withTenant()" }])).toEqual([`${tenantTest}: \\bwithTenant\\b`]);
    expect(forbiddenReferences([{ rel: "apps/ops/test/other.test.ts", text: "signSession()" }])).toHaveLength(1);
  });

  it("only lib/withStaff.ts opens a transaction or takes a client from a pool", () => {
    const opens = opsSource.filter((f) => f.rel !== "apps/ops/lib/withStaff.ts" && /\bBEGIN\b|\.connect\(|\.transaction\(/.test(f.text));
    expect(opens.map((f) => f.rel)).toEqual([]);
    expect(/\bBEGIN\b/.test(opsFiles.find((f) => f.rel === "apps/ops/lib/withStaff.ts")!.text)).toBe(true);
  });
});

describe("apps/ops logging (OPS-C2-11)", () => {
  it("uses the telemetry logger and never console.log in lib/ or app/", () => {
    const logs = opsSource.filter((f) => /^apps\/ops\/(lib|app)\//.test(f.rel) && /\bconsole\.log\s*\(/.test(f.text));
    expect(logs.map((f) => f.rel)).toEqual([]);
    const adopters = opsSource.filter((f) => /^apps\/ops\/(lib|app)\//.test(f.rel) && /from\s+["']@fx\/telemetry["']/.test(f.text));
    expect(adopters.length).toBeGreaterThan(0);
    expect(opsSource.find((f) => f.rel === "apps/ops/lib/log.ts")!.text).toMatch(/createLogger/);
  });
});

describe("apps/ops imports (OPS-C2-13)", () => {
  it("imports nothing from the API package's routes, principal or event streams", () => {
    expect(bannedApiImports(opsFiles.filter((f) => /\.(ts|tsx|mjs|js)$/.test(f.rel)))).toEqual([]);
  });

  it("the scan can fail: it flags value imports in every form and lets type-only imports and pure packages through", () => {
    // Built from parts so the repo-wide declared-imports scan does not read these fixtures as imports.
    const API = ["@fx", "api"].join("/");
    const DESIGN = ["@fx", "design"].join("/");
    const sub = (t: string) => t.replaceAll("$APIDIR", "api").replaceAll("$API", API).replaceAll("$DESIGN", DESIGN);
    const text = sub([
      'import { x } from "$API";',
      'import y from "$API/src/routes/github";',
      'import { z } from "../../../packages/$APIDIR/src/principal";',
      'export { s } from "$API/src/sse/pools";',
      'import "$API";',
      'const m = await import("$API/src/sse/pools");',
      'const r = require("$API");',
      'import {\n  a,\n  b,\n} from "$API/src/routes/model-connection";',
      'import type { T } from "$API";',
      'export type { U } from "$API/src/principal";',
      'import { createLogger } from "@fx/telemetry";',
      'import { Header } from "$DESIGN/react";',
    ].join("\n"));
    const found = bannedApiImports([{ rel: "apps/ops/lib/x.ts", text }]).map((s) => s.split(": ")[1]);
    expect(found).toEqual(
      ["$API", "$API/src/routes/github", "../../../packages/$APIDIR/src/principal", "$API/src/sse/pools", "$API", "$API/src/sse/pools", "$API", "$API/src/routes/model-connection"].map(sub),
    );
  });
});

// ------------------------------------------------------------------------------------- the rest of the tree

/** R-68-C2-2: the OPS-C1 migration's header comment names the console's database setting. It is the one allowed mention outside apps/ops. */
const C1_COMMENT_FILE = "packages/db/migrations/0801_staff_console.sql";
const OPS_ONLY_NAMES = /DATABASE_URL_OPS_CONSOLE|FX_OPS_SESSION_SECRET/;

describe("the rest of the repository (OPS-C2-8)", () => {
  const rest = load(["apps/web", "packages"]);

  it("scans a real set of files (sanity)", () => {
    expect(rest.length).toBeGreaterThan(500);
  });

  it("nothing under apps/web or packages names the console's database login or session secret, except the one allowed comment", () => {
    const hits = rest.filter((f) => OPS_ONLY_NAMES.test(f.text)).map((f) => f.rel);
    expect(hits.filter((rel) => rel !== C1_COMMENT_FILE)).toEqual([]);
  });

  it("the allowed mention is still there: drop the exception once the comment no longer names the setting", () => {
    const file = rest.find((f) => f.rel === C1_COMMENT_FILE);
    expect(file, `${C1_COMMENT_FILE} exists`).toBeDefined();
    expect(file!.text).toMatch(OPS_ONLY_NAMES);
  });
});

// ------------------------------------------------------------------------------------------- built output (OPS-C2-11, -12)

const FORBIDDEN_IN_BUILD = [
  "DATABASE_URL_PLATFORM_OPS",
  "DATABASE_URL_APP_USER",
  "FX_SESSION_SECRET",
  "FX_KEK",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
];
const CANARY = "canary-must-not-be-built-in-4f1b9c7e";

function allFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) allFiles(full, out);
    else out.push(full);
  }
  return out;
}

/** Every `file: needle` pair found under `dir`. */
export function findInDir(dir: string, needles: string[]): string[] {
  const hits: string[] = [];
  for (const f of allFiles(dir)) {
    const text = readFileSync(f).toString("latin1");
    for (const n of needles) if (text.includes(n)) hits.push(`${path.relative(dir, f)}: ${n}`);
  }
  return hits;
}

describe("the scan of built output", () => {
  it("can fail: it finds a planted name in a copied tree and passes a clean one", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fx-ops-scan-"));
    try {
      mkdirSync(path.join(dir, "chunks"));
      writeFileSync(path.join(dir, "chunks", "a.js"), "const a = 1;");
      expect(findInDir(dir, FORBIDDEN_IN_BUILD)).toEqual([]);
      writeFileSync(path.join(dir, "chunks", "b.js"), 'process.env["FX_KEK_V1"]');
      expect(findInDir(dir, FORBIDDEN_IN_BUILD)).toEqual(["chunks/b.js: FX_KEK"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** What `pnpm --filter ops build` needs from the parent: where to find the tools, a home for caches, temp files, locale and the package manager's own settings. */
const BUILD_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SHELL",
  "CI",
  "PNPM_HOME",
  "COREPACK_HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "NODE_PATH",
  "NPM_CONFIG_USERCONFIG",
  "npm_config_store_dir",
  "npm_config_cache",
  "SSL_CERT_FILE",
  "NIX_SSL_CERT_FILE",
];

describe("pnpm --filter ops build", () => {
  it("exits 0, and no file in the built server output, moved to another directory, names a web-only setting or carries its value", () => {
    // The child gets an explicit list, never the whole environment, so the build cannot inherit whatever the shell holds.
    const env: NodeJS.ProcessEnv = { NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" };
    for (const k of BUILD_ENV_ALLOWLIST) if (process.env[k] !== undefined) env[k] = process.env[k];
    for (const n of FORBIDDEN_IN_BUILD) env[n] = CANARY;
    for (const n of ["DATABASE_URL_OPS_CONSOLE", "FX_OPS_SESSION_SECRET", "FX_OPS_ORIGIN"]) delete env[n];
    const build = spawnSync("pnpm", ["--filter", "ops", "build"], { cwd: ROOT, env, encoding: "utf8", timeout: 9 * 60_000, maxBuffer: 64 * 1024 * 1024 });
    expect(build.status, `${build.stdout}\n${build.stderr}`.slice(-3000)).toBe(0);

    const server = path.join(OPS, ".next", "server");
    expect(existsSync(server)).toBe(true);
    const moved = mkdtempSync(path.join(tmpdir(), "fx-ops-built-"));
    try {
      const target = path.join(moved, "server");
      cpSync(server, target, { recursive: true });
      expect(allFiles(target).length).toBeGreaterThan(10);
      expect(findInDir(target, [...FORBIDDEN_IN_BUILD, CANARY])).toEqual([]);
    } finally {
      rmSync(moved, { recursive: true, force: true });
    }
  }, 10 * 60_000);
});
