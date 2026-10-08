import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLIENT_ANONYMOUS_CODE, CLIENT_ERROR_CODES, CLIENT_WINDOW_IDS, OTHER_ERROR_CODE, OWN_ERROR_CODES, errorCodeOrOther, isAllowedErrorCode, safeLabel, safeTagPart } from "../src/errorCodes.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

describe("the error-code allowlist", () => {
  it("keeps our codes, SQLSTATE, Node ERR_*, errno and known Stripe codes", () => {
    for (const code of ["validation_failed", "not_found", "23505", "42P01", "P0001", "ERR_INVALID_IP_ADDRESS", "ERR_SOCKET_CLOSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "card_declined", "resource_missing", "other", "error_overflow", "runner_notice_failed", "runner_notice_backlog"]) {
      expect(isAllowedErrorCode(code), code).toBe(true);
      expect(errorCodeOrOther(code)).toBe(code);
    }
  });

  it("stores anything else as other: an upstream word, a repository name, free text, a non-string", () => {
    const rejected = ["octocat", "my-repo", "acme/widgets", "abc 23505", "2350", "235055", "REPOS", "err_lowercase", "ERR_", "Econnreset", "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "", " ", "x".repeat(200)];
    for (const code of rejected) {
      expect(isAllowedErrorCode(code), code).toBe(false);
      expect(errorCodeOrOther(code)).toBe(OTHER_ERROR_CODE);
    }
    for (const value of [undefined, null, 5, {}, [], Symbol("x"), () => "validation_failed"]) expect(errorCodeOrOther(value)).toBe(OTHER_ERROR_CODE);
  });

  it("keeps the fixed client.* codes and no other code under that prefix", () => {
    for (const code of [...CLIENT_ERROR_CODES, CLIENT_ANONYMOUS_CODE]) expect(errorCodeOrOther(code), code).toBe(code);
    for (const code of ["client.", "client.made_up", "client.render_failed ", "Client.render_failed", "client.octocat"]) expect(errorCodeOrOther(code), code).toBe(OTHER_ERROR_CODE);
  });

  it("lists window ids that are plain lowercase words, each usable as a stage once its dashes become underscores", () => {
    for (const id of CLIENT_WINDOW_IDS) expect(safeLabel(`client.${id.replace(/-/g, "_")}`, "x"), id).not.toBe("x");
    expect(new Set(CLIENT_WINDOW_IDS).size).toBe(CLIENT_WINDOW_IDS.length);
  });

  it("keeps the sandbox reaper's alert codes (D#2 SANDBOX-REAPER-1b) instead of folding them into other", () => {
    for (const code of ["sandbox_cap_exceeded", "sandbox_total_high", "sandbox_orphan_found", "sandbox_unsettled_stale", "sandbox_name_mismatch", "sandbox_reap_mode_invalid", "sandbox_reap_unconfigured"]) {
      expect(errorCodeOrOther(code), code).toBe(code);
    }
  });

  it("has no duplicate in our own list", () => {
    expect(new Set(OWN_ERROR_CODES).size).toBe(OWN_ERROR_CODES.length);
  });

  it("replaces a label outside its pattern, never echoing it", () => {
    expect(safeLabel("sync", "x")).toBe("sync");
    expect(safeLabel("repo_sync.list", "x")).toBe("repo_sync.list");
    for (const bad of ["Sync", "octo/repo", "1sync", "", "a b", "s".repeat(41), undefined, 3]) expect(safeLabel(bad, "fallback")).toBe("fallback");
  });

  it("keeps a short tag word, and refuses one shaped like a token", () => {
    expect(safeTagPart("InstallationTokenError")).toBe("InstallationTokenError");
    for (const bad of ["ghs_16C7e42F292c6912E7710c838347Ae178B4a", "github_pat_11ABC", "eyJhbGciOiJSUzI1NiJ9", "a b", "x".repeat(41), "", 1]) expect(safeTagPart(bad)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------------
// The thrown-code scan: every code literal that a source file passes to ApiError (directly, or from a
// subclass's super call) must be on the allowlist, so a new code cannot ship as `other` by accident.
// A code passed through a variable (DenyError's reason) cannot be read statically; those are listed by hand.
// ---------------------------------------------------------------------------------------------------------
const SKIPPED_DIRS = new Set(["node_modules", ".next", "dist", "test", "__tests__", "fixtures"]);
const SOURCE = /\.(ts|tsx|mts|js|mjs)$/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) sourceFiles(path.join(dir, entry.name), out);
    } else if (SOURCE.test(entry.name) && !entry.name.includes(".test.")) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

/** Every file in the scanned roots: `<root>/packages/*\/src` and `<root>/apps/web`. */
function scannedFiles(root: string): string[] {
  const out: string[] = [];
  const packages = path.join(root, "packages");
  let names: string[] = [];
  try {
    names = readdirSync(packages);
  } catch {
    // none
  }
  for (const name of names) sourceFiles(path.join(packages, name, "src"), out);
  sourceFiles(path.join(root, "apps", "web"), out);
  return out;
}

const QUOTED = `["'\`]([^"'\`$]+)["'\`]`;
const DIRECT = new RegExp(`new\\s+ApiError\\(\\s*\\d{3}\\s*,\\s*${QUOTED}`, "g");
const SUBCLASS = new RegExp(`super\\(\\s*\\d{3}\\s*,\\s*${QUOTED}`, "g");

/** The code literals thrown through ApiError in the scanned roots, as [code, file]. */
function thrownCodes(root: string): [string, string][] {
  const found: [string, string][] = [];
  for (const file of scannedFiles(root)) {
    const text = readFileSync(file, "utf8");
    if (!text.includes("ApiError")) continue;
    for (const m of text.matchAll(DIRECT)) found.push([m[1]!, file]);
    for (const m of text.matchAll(SUBCLASS)) found.push([m[1]!, file]);
  }
  return found;
}

const unlisted = (root: string): string[] => thrownCodes(root).filter(([code]) => !isAllowedErrorCode(code)).map(([code, file]) => `${code} (${path.relative(root, file)})`);

describe("the thrown-code scan", () => {
  it("passes on the tree: every code literal passed to ApiError is on the allowlist", () => {
    const found = thrownCodes(REPO_ROOT);
    expect(found.length).toBeGreaterThan(30); // the scan really reads the tree
    expect(unlisted(REPO_ROOT)).toEqual([]);
  });

  it("passes on the tree: every `readonly code = \"...\"` literal on an error class is on the allowlist", () => {
    const READONLY_CODE = /readonly\s+code\s*=\s*["']([^"'`$]+)["']/g;
    const found: [string, string][] = [];
    for (const file of scannedFiles(REPO_ROOT)) {
      for (const m of readFileSync(file, "utf8").matchAll(READONLY_CODE)) found.push([m[1]!, path.relative(REPO_ROOT, file)]);
    }
    expect(found.length).toBeGreaterThan(0);
    expect(found.filter(([code]) => !isAllowedErrorCode(code)).map(([code, file]) => `${code} (${file})`)).toEqual([]);
  });

  it("fails on a fixture that throws a code that is not on the list, direct or from a subclass", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fx-thrown-codes-"));
    try {
      mkdirSync(path.join(dir, "packages", "demo", "src"), { recursive: true });
      mkdirSync(path.join(dir, "apps", "web", "app"), { recursive: true });
      writeFileSync(
        path.join(dir, "packages", "demo", "src", "a.ts"),
        'import { ApiError } from "@fx/api";\nexport const a = () => { throw new ApiError(422, "brand_new_code", "m"); };\nexport const ok = () => new ApiError(404, "not_found", "m");\n',
      );
      writeFileSync(
        path.join(dir, "apps", "web", "app", "b.ts"),
        'import { ApiError } from "@fx/api";\nexport class SubError extends ApiError {\n  constructor() {\n    super(409,\n      "another_new_code", "m");\n  }\n}\n',
      );
      expect(unlisted(dir).map((s) => s.split(" ")[0]).sort()).toEqual(["another_new_code", "brand_new_code"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
