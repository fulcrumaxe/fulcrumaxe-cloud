import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(__dirname, "..", "src");

/**
 * D#2 H09b, correction C10, pass/fail 9: `startAgentRun.ts`/`cancelRun.ts`/
 * `workflows/**` import none of `sandboxPort`/`fakeSandbox`/
 * `firewallPolicy`/`sandboxEnv`/`networkPolicy`/`@fx/spend`; only
 * `targets/sandboxTarget.ts` imports them. No line in `src` reads
 * `process.env` (comments stripped).
 *
 * `executionTarget.ts` is excluded from the "only sandboxTarget.ts" scan
 * below -- it's the one file that wires `SandboxTarget` into
 * `EXECUTION_TARGETS`, the whole point of a registry (see its own file
 * header). `index.ts` (the package barrel) is excluded too: `export *
 * from` isn't an IMPORT in this criterion's sense. `workflows/**` doesn't
 * exist yet (H09b2's), so that half is vacuously satisfied today.
 */

const FORBIDDEN_SPECIFIERS = [
  "sandboxPort",
  "fakeSandbox",
  "firewallPolicy",
  "sandboxEnv",
  "networkPolicy",
  "@fx/spend",
];

// D#6 R3a: the runner target is restricted too. It holds no money and has no sandbox.
const RESTRICTED_FILES = ["startAgentRun.ts", "cancelRun.ts", path.join("targets", "runnerTarget.ts"), path.join("targets", "jobIssuer.ts"), path.join("targets", "githubRepoVisibility.ts")];

/** The forbidden modules (plus `connectionStatusPort.ts`, the same
 * "sandbox-adjacent" surface) are exempt from the scan below: they
 * legitimately reference each other (`fakeSandbox.ts` implements
 * `SandboxPort`; `firewallPolicy.ts` calls `networkPolicy`) -- H09a's
 * pre-existing structure. The criterion is about OTHER files reaching
 * into this cluster, not its own internal edges. */
const FORBIDDEN_MODULE_FILES = new Set([
  "sandboxPort.ts",
  "fakeSandbox.ts",
  "firewallPolicy.ts",
  "sandboxEnv.ts",
  "networkPolicy.ts",
  "connectionStatusPort.ts",
  // D#2 H14c-2: the real `SandboxPort` implements sandboxPort.ts and
  // reuses fakeSandbox.ts's env assertion -- the same internal edges.
  "vercelSandboxPort.ts",
  // D#66 correction C3: githubForwardConfig.ts imports
  // STRICT_HOSTNAME_RE/RESERVED_FORWARD_HOST_NAMES from networkPolicy.ts
  // rather than keeping a pinned duplicate. Its only consumers are
  // firewallPolicy.ts and targets/sandboxTarget.ts, and it already
  // type-imports networkPolicy.ts, so it belongs to this cluster.
  "githubForwardConfig.ts",
]);

function listWorkflowFiles(): string[] {
  const dir = path.join(SRC_DIR, "workflows");
  try {
    if (!statSync(dir).isDirectory()) return [];
  } catch {
    return [];
  }
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => path.join("workflows", f));
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** Real (non-type-only) `import ... from "specifier"` lines only --
 * never `export * from`, never `import type`. Multi-line import
 * statements are first joined onto one logical line per statement
 * (split on `;`) so a specifier on its own line is still found. */
function realImportSpecifiers(source: string): string[] {
  const stripped = stripComments(source);
  const statements = stripped.split(";");
  const specifiers: string[] = [];
  for (const stmt of statements) {
    const s = stmt.trim();
    if (!s.startsWith("import")) continue;
    if (/^import\s+type\b/.test(s)) continue;
    const m = s.match(/from\s+["']([^"']+)["']/);
    if (m) specifiers.push(m[1]);
  }
  return specifiers;
}

describe("import boundary (pass/fail 9)", () => {
  const relativeFiles = [...RESTRICTED_FILES, ...listWorkflowFiles()];

  it.each(relativeFiles)("%s imports none of the sandbox-specific modules", (relFile) => {
    const source = readFileSync(path.join(SRC_DIR, relFile), "utf8");
    const specifiers = realImportSpecifiers(source);
    for (const specifier of specifiers) {
      for (const forbidden of FORBIDDEN_SPECIFIERS) {
        expect(specifier).not.toContain(forbidden);
      }
    }
  });

  /** Every import of `runnerTarget.ts`, type-only ones included: a type import of `@fx/spend` or of the sandbox target
   * would still tie the runner target to the cluster it exists to stay out of. */
  it("D#6 R3a: targets/runnerTarget.ts imports none of the sandbox cluster, @fx/spend or sandboxTarget, not even as a type", () => {
    const stripped = stripComments(readFileSync(path.join(SRC_DIR, "targets", "runnerTarget.ts"), "utf8"));
    const specifiers = [...stripped.matchAll(/(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      for (const forbidden of [...FORBIDDEN_SPECIFIERS, "sandboxTarget", "@fx/model-connection", "fakeSandbox"]) {
        expect(specifier, `${specifier} must not contain ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("only targets/sandboxTarget.ts imports the sandbox-specific modules", () => {
    const allSrcFiles = walk(SRC_DIR).filter((f) => f.endsWith(".ts"));
    const offenders: string[] = [];
    for (const file of allSrcFiles) {
      const rel = path.relative(SRC_DIR, file);
      if (rel === path.join("targets", "sandboxTarget.ts")) continue;
      if (rel === "index.ts") continue; // barrel re-export -- see file header.
      if (FORBIDDEN_MODULE_FILES.has(rel)) continue; // the cluster's own internal edges -- see its own doc comment.
      const specifiers = realImportSpecifiers(readFileSync(file, "utf8"));
      for (const specifier of specifiers) {
        for (const forbidden of FORBIDDEN_SPECIFIERS) {
          if (specifier.includes(forbidden)) {
            offenders.push(`${rel} -> ${specifier}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no line in packages/runner/src reads process.env (comments stripped)", () => {
    const allSrcFiles = walk(SRC_DIR).filter((f) => f.endsWith(".ts"));
    const offenders: string[] = [];
    for (const file of allSrcFiles) {
      const stripped = stripComments(readFileSync(file, "utf8"));
      if (stripped.includes("process.env")) {
        offenders.push(path.relative(SRC_DIR, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  /** D#66, pass/fail 16: "grep -rn 'githubForwardHost' packages/runner/src
   * finds no string-literal host value." Every real match is a bare
   * identifier (a parameter/property name or reference) -- none pairs
   * `githubForwardHost` on the same line with a quoted, dot-containing
   * literal, which is what an inlined real hostname would look like. */
  it("D#66: no line mentioning githubForwardHost carries a string-literal host value", () => {
    const allSrcFiles = walk(SRC_DIR).filter((f) => f.endsWith(".ts"));
    const offenders: string[] = [];
    for (const file of allSrcFiles) {
      const lines = stripComments(readFileSync(file, "utf8")).split("\n");
      for (const line of lines) {
        if (line.includes("githubForwardHost") && /["'][^"']*\.[^"']*["']/.test(line)) {
          offenders.push(`${path.relative(SRC_DIR, file)}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}
