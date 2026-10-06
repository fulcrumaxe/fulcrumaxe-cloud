import { promises as fs } from "node:fs";
import type { CheckOptions, CheckResult, Finding } from "../types.js";
import { findHtmlFiles, urlFor } from "../lib/walk.js";

/**
 * Port of os-site-v2/tools/check-meta.py.
 *
 * Hard failures: a missing <title>/description, or two pages sharing one.
 * Length is advisory (search-engine truncation guidance), never a failure —
 * failing on advice is how a check stops being run.
 */

export interface MetaOptions extends CheckOptions {
  titleMax?: number;
  descMin?: number;
  descMax?: number;
}

const TITLE_MAX_DEFAULT = 70;
const DESC_MIN_DEFAULT = 70;
const DESC_MAX_DEFAULT = 200;

function meta(doc: string): { title: string | null; desc: string | null } {
  const title = /<title>([\s\S]*?)<\/title>/.exec(doc);
  const desc = /<meta name="description" content="([\s\S]*?)">/.exec(doc);
  return {
    title: title ? (title[1] ?? "").trim() : null,
    desc: desc ? (desc[1] ?? "").trim() : null,
  };
}

export async function run(renderedDir: string, options: MetaOptions = {}): Promise<CheckResult> {
  const titleMax = options.titleMax ?? TITLE_MAX_DEFAULT;
  const descMin = options.descMin ?? DESC_MIN_DEFAULT;
  const descMax = options.descMax ?? DESC_MAX_DEFAULT;

  const findings: Finding[] = [];
  const titles = new Map<string, string[]>();
  const descs = new Map<string, string[]>();
  const files = await findHtmlFiles(renderedDir);

  for (const file of files) {
    const doc = await fs.readFile(file, "utf-8");
    const url = urlFor(renderedDir, file);
    const { title, desc } = meta(doc);

    if (!title) {
      findings.push({ path: url, kind: "missing_title", message: "no <title>", severity: "error" });
    } else {
      titles.set(title, [...(titles.get(title) ?? []), url]);
      if (title.length > titleMax) {
        findings.push({
          path: url,
          kind: "title_length",
          message: `title is ${title.length} chars (over ${titleMax})`,
          severity: "advisory",
        });
      }
    }

    if (!desc) {
      findings.push({ path: url, kind: "missing_description", message: "no meta description", severity: "error" });
    } else {
      descs.set(desc, [...(descs.get(desc) ?? []), url]);
      if (desc.length < descMin) {
        findings.push({
          path: url,
          kind: "description_length",
          message: `description is ${desc.length} chars (under ${descMin})`,
          severity: "advisory",
        });
      } else if (desc.length > descMax) {
        findings.push({
          path: url,
          kind: "description_length",
          message: `description is ${desc.length} chars (over ${descMax})`,
          severity: "advisory",
        });
      }
    }
  }

  for (const [value, urls] of titles) {
    if (urls.length > 1) {
      findings.push({
        path: urls.join(", "),
        kind: "duplicate_title",
        message: `share a title: "${value.slice(0, 50)}"`,
        severity: "error",
      });
    }
  }
  for (const [value, urls] of descs) {
    if (urls.length > 1) {
      findings.push({
        path: urls.join(", "),
        kind: "duplicate_description",
        message: `share a description: "${value.slice(0, 50)}"`,
        severity: "error",
      });
    }
  }

  const ok = findings.every((f) => f.severity !== "error");
  return { ok, findings, summary: { pages: files.length } };
}
