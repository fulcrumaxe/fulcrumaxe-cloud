import { promises as fs } from "node:fs";
import path from "node:path";
import type { CheckOptions, CheckResult, Finding } from "../types.js";

/**
 * Port of os-site-v2/tools/check-freshness.py: committed data files that pages
 * present as current must not go stale.
 *
 * Deliberate divergence: the original falls back to the file's mtime when no
 * timestamp is declared. In rendered output mtime is the build time, so that
 * fallback always passes. Here an undeclared or unparseable age is an
 * advisory (`sidecar_age_undeclared`), never a silent pass.
 */
export interface FreshnessOptions extends CheckOptions {
  /** Default []: a site with no sidecars passes. */
  sidecars?: { path: string; timestampKey?: string; maxAgeDays: number }[];
  /** The clock. Default new Date(); tests inject it. */
  now?: Date;
  /** Fail when .well-known/security.txt expires in fewer days than this. Default 30. */
  securityTxtMinDays?: number;
}

const DAY_MS = 86_400_000;

function dig(obj: unknown, dotted: string): unknown {
  let cur = obj;
  for (const part of dotted.split(".")) {
    if (typeof cur !== "object" || cur === null || !(part in cur)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** ISO 8601, "Z" accepted. A timestamp with no zone is taken as UTC, as the original does. */
function parseStamp(stamp: unknown): Date | null {
  if (typeof stamp !== "string" || !/^\d{4}-\d\d-\d\d/.test(stamp)) return null;
  const hasZone = /(Z|[+-]\d\d:?\d\d)$/i.test(stamp);
  const d = new Date(!hasZone && stamp.includes("T") ? stamp + "Z" : stamp);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function run(renderedDir: string, options: FreshnessOptions = {}): Promise<CheckResult> {
  const now = options.now ?? new Date();
  const sidecars = options.sidecars ?? [];
  const minDays = options.securityTxtMinDays ?? 30;
  const findings: Finding[] = [];

  for (const sc of sidecars) {
    const url = "/" + sc.path.replace(/^\/+/, "");
    let raw: string;
    try {
      raw = await fs.readFile(path.join(renderedDir, sc.path), "utf-8");
    } catch {
      findings.push({ path: url, kind: "sidecar_missing", message: `${sc.path} is missing`, severity: "error" });
      continue;
    }

    let when: Date | null = null;
    if (sc.timestampKey) {
      try {
        when = parseStamp(dig(JSON.parse(raw), sc.timestampKey));
      } catch {
        when = null;
      }
    }
    if (!when) {
      findings.push({
        path: url,
        kind: "sidecar_age_undeclared",
        message: `${sc.path} declares no parseable timestamp, so its age cannot be verified (file mtime is not used)`,
        severity: "advisory",
      });
      continue;
    }

    const days = Math.floor((now.getTime() - when.getTime()) / DAY_MS);
    if (days > sc.maxAgeDays) {
      findings.push({
        path: url,
        kind: "sidecar_stale",
        message: `${sc.path} is ${days}d old, limit ${sc.maxAgeDays}d`,
        severity: "error",
      });
    }
  }

  // RFC 9116 requires Expires; an expired file says the contact route is unmaintained.
  try {
    const txt = await fs.readFile(path.join(renderedDir, ".well-known", "security.txt"), "utf-8");
    const line = txt.split(/\r?\n/).find((l) => l.toLowerCase().startsWith("expires:"));
    const expires = line ? parseStamp(line.slice(line.indexOf(":") + 1).trim()) : null;
    if (expires) {
      const left = Math.floor((expires.getTime() - now.getTime()) / DAY_MS);
      if (left < minDays) {
        findings.push({
          path: "/.well-known/security.txt",
          kind: "security_txt_expiring",
          message: left < 0 ? `security.txt expired ${-left}d ago` : `security.txt expires in ${left}d (minimum ${minDays}d)`,
          severity: "error",
        });
      }
    }
  } catch {
    // No security.txt: no finding, as the original.
  }

  const ok = !findings.some((f) => f.severity === "error");
  return { ok, findings, summary: { checked: sidecars.length } };
}
