import { promises as fs } from "node:fs";
import type { CheckOptions, CheckResult, Finding } from "../types.js";

/**
 * Port of os-site-v2/tools/check-headers.py: every root-level data file the
 * site serves must have a caching rule, or the host sends
 * `max-age=0, must-revalidate` for a file that only changes on deploy.
 *
 * The original read formal-support/vercel.json. Here the caller supplies the
 * config the publish step deploys with, and a missing config FAILS: with no
 * rules to compare against, "nothing is unruled" would be a vacuous pass.
 */
export interface HeadersOptions extends CheckOptions {
  /** REQUIRED. Vercel's `headers` shape. */
  headers: { source: string; headers: { key: string; value: string }[] }[];
  /** Extensions of root-level files a browser fetches. Default [".json", ".xml", ".txt"]. */
  servedExtensions?: string[];
  /** Sources deliberately never cached. Default ["/vercel.json", "/package.json", "/package-lock.json"]. */
  noCache?: string[];
  /** Files in the root that are never served. Default ["vercel.json", "package.json", "package-lock.json"]. */
  notServed?: string[];
}

/** `options` is typed loosely so `run` stays a `CheckRun`; `headers` is validated at runtime. */
export async function run(renderedDir: string, rawOptions?: CheckOptions): Promise<CheckResult> {
  const options = rawOptions as Partial<HeadersOptions> | undefined;
  const config = options?.headers;
  if (!Array.isArray(config)) {
    return {
      ok: false,
      findings: [
        {
          path: "/",
          kind: "headers_config_missing",
          message: "options.headers (the deployed headers config) is required and was not an array",
          severity: "error",
        },
      ],
      summary: { checked: 0 },
    };
  }

  const served = options?.servedExtensions ?? [".json", ".xml", ".txt"];
  const noCache = new Set(options?.noCache ?? ["/vercel.json", "/package.json", "/package-lock.json"]);
  const notServed = new Set(options?.notServed ?? ["vercel.json", "package.json", "package-lock.json"]);

  const ruled = new Set<string>();
  for (const entry of config) {
    const hs = Array.isArray(entry?.headers) ? entry.headers : [];
    if (hs.some((h) => String(h?.key).toLowerCase() === "cache-control")) ruled.add(entry.source);
  }

  const findings: Finding[] = [];
  let checked = 0;
  const entries = await fs.readdir(renderedDir, { withFileTypes: true });
  for (const name of entries.filter((e) => e.isFile()).map((e) => e.name).sort()) {
    if (!served.some((ext) => name.endsWith(ext)) || notServed.has(name)) continue;
    checked++;
    const source = "/" + name;
    // A catch-all rule counts.
    if (noCache.has(source) || ruled.has(source) || ruled.has("/(.*)")) continue;
    findings.push({
      path: source,
      kind: "missing_cache_rule",
      message: `${name} has no cache-control rule; the host would send max-age=0, must-revalidate`,
      severity: "error",
    });
  }

  return { ok: findings.length === 0, findings, summary: { checked } };
}
