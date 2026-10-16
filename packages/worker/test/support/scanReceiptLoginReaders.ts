import { readFileSync } from "node:fs";
import path from "node:path";
import {
  NAMES_ONLY,
  PROVISIONERS,
  SCANNED_TOPS,
  fold,
  listFiles,
  namesOnlyViolations,
  provisionerViolation,
  tokenize,
} from "./scanRunnerLoginReaders.js";

/**
 * D#7 DP4b-1 (R-7-DP4b-5): the single-reader scan for the RECEIPT login, in the shape of the runner login's (CARRY-8). The variable's name is built here,
 * not written, so this file and every test that uses it never names it in source. Exactly one module reads it, `packages/worker/src/pools.ts`;
 * it exports a pool builder, and any other module (D#31 API-11's answer route included) gets the pool from there, never from the environment.
 *
 * Same threat model as the runner scan: it catches ACCIDENTAL reads and keeps the allowlist narrow. Deliberate obfuscation is a review matter.
 * The runner scan's other rules (provisioners, names-only manifest) apply here in the same two forms: a provisioning script or the settings manifest
 * may NAME the variable, only inside a quoted literal (the manifest: only as data), and never read it.
 */
export const RECEIPT_LOGIN_NAME = ["FX", "RECEIPT", "LOGIN", "URL"].join("_");

const NAME_RE = new RegExp(`(?<![A-Za-z0-9_])${RECEIPT_LOGIN_NAME}(?![A-Za-z0-9_])`);

/** The one file allowed to read the variable. */
export const RECEIPT_ONLY_READER = path.join("packages", "worker", "src", "pools.ts");
const OWN_TEST_DIR = path.join("packages", "worker", "test") + path.sep;
const WORKER_DIR = path.join("packages", "worker") + path.sep;

/** True when a bracket expression made only of literals and constants (`a + B + "c"`) evaluates to the name. */
function bracketResolvesToName(source: string): boolean {
  const consts = new Map<string, string>();
  for (const m of source.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*(['"`])([^'"`\\\n]*)\2/g)) consts.set(m[1]!, m[3]!);
  for (const m of source.matchAll(/\[([^\[\]\n]+)\]/g)) {
    let value = "";
    let ok = true;
    for (const token of m[1]!.split("+").map((t) => t.trim())) {
      const lit = /^(['"`])([^'"`\\\n]*)\1$/.exec(token);
      if (lit) value += lit[2];
      else if (consts.has(token)) value += consts.get(token);
      else ok = false;
    }
    if (ok && NAME_RE.test(value)) return true;
  }
  return false;
}

/** Why `source` reads the variable, or names a way to, outside the allowed files; undefined when clean. */
export function receiptViolationIn(source: string, insideWorkerPackage: boolean, underApps = true): string | undefined {
  if (NAME_RE.test(source)) return "names the variable";
  if (NAME_RE.test(fold(source))) return "builds the variable's name from literals";
  if (bracketResolvesToName(source)) return "indexes with a key that resolves to the name";
  if (underApps && /Object\.(keys|entries|values|assign)\(\s*process\.env|\.\.\.\s*process\.env/.test(source)) return "enumerates process.env";
  if (underApps && /\{[^}]*(\[|\.\.\.)[^}]*\}\s*=\s*process\.env/.test(source)) return "destructures process.env with a computed key or rest";
  const folded = fold(source);
  if (!insideWorkerPackage && /(?:from|import|require)\s*\(?\s*['"`][^'"`]*worker\/src\//.test(folded)) return "imports a worker internal module";
  if (!insideWorkerPackage && /export\s+(?:\*|\{[^}]*\})\s+from\s*['"`][^'"`]*worker\/src\//.test(folded)) return "re-exports a worker internal module";
  return undefined;
}

/**
 * A provisioning file may NAME the variable, only inside a quoted literal. It must also pass the runner scan's provisioner rules (no whole-environment
 * copy, no process alias, no computed require, no worker import), and must not read the receipt variable by a literal key.
 */
export function receiptProvisionerViolation(source: string): string | undefined {
  const runnerRules = provisionerViolation(source);
  if (runnerRules) return runnerRules;
  const literals: string[] = [];
  const code = tokenize(source, literals);
  if (NAME_RE.test(code)) return "names the variable outside a quoted literal";
  const envKey = /\bprocess\s*(?:\?\.)?\s*\.\s*env\s*\??\.?\s*\[\s*"§(\d+)"\s*\]/g;
  for (let m = envKey.exec(code); m; m = envKey.exec(code)) {
    if (NAME_RE.test(literals[Number(m[1])] ?? "")) return "reads the variable by a literal key";
  }
  return receiptViolationIn(source.split(RECEIPT_LOGIN_NAME).join("MASKED_NAME"), false, true);
}

/** Every file under apps, packages, sites and scripts of `root` (except the one allowed reader) that reads or can reach the receipt variable. */
export function scanReceiptLoginReaders(root: string): string[] {
  const found: string[] = [];
  for (const top of SCANNED_TOPS) {
    for (const file of listFiles(root, top)) {
      const rel = path.relative(root, file);
      if (rel === RECEIPT_ONLY_READER) continue;
      // This package's test directory holds the fixtures' source text.
      if (rel.startsWith(OWN_TEST_DIR)) continue;
      let source: string;
      try {
        source = readFileSync(file, "utf8");
      } catch {
        continue; // listed by git but deleted in the working tree
      }
      if (NAMES_ONLY.includes(rel)) {
        const shape = namesOnlyViolations(source);
        if (shape.length > 0) found.push(`${rel}: is not names-only (${shape.join("; ")})`);
        continue;
      }
      if (PROVISIONERS.includes(rel)) {
        const bad = receiptProvisionerViolation(source);
        if (bad) found.push(`${rel}: ${bad}`);
        continue;
      }
      const why = receiptViolationIn(source, rel.startsWith(WORKER_DIR), top === "apps");
      if (why) found.push(`${rel}: ${why}`);
    }
  }
  return found.sort();
}
