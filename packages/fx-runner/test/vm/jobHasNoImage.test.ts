import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JobSchema } from "@fulcrumaxe/runner-protocol";
import { describe, expect, it } from "vitest";
import { jobFor } from "../helpers/signedJob.js";

/** D#587 B-1 acceptance 8: no job field names an image. A job reaches a VM only through the template the runner itself is set up with. */
const PROTOCOL_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "runner-protocol", "src");
const jobFiles = readdirSync(PROTOCOL_SRC).filter((f) => /^job.*\.ts$/.test(f));

describe("the job has no image-reference field", () => {
  it("`rg -n image packages/runner-protocol/src/job*.ts` finds only comments, and the comment says there is no such field", () => {
    expect(jobFiles.length).toBeGreaterThan(0);
    const hits: string[] = [];
    for (const file of jobFiles) {
      readFileSync(path.join(PROTOCOL_SRC, file), "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (/image/i.test(line)) hits.push(`${file}:${i + 1}:${line.trim()}`);
        });
    }
    for (const hit of hits) expect(hit, "a line that is code").toMatch(/^[^:]+:\d+:(\*|\/\/|\/\*)/);
    expect(hits.join("\n")).toMatch(/No field can carry a\s*$|an image or binary reference/);
  });

  it("no key anywhere in the strict job schema is image-like, and a job carrying one does not parse", () => {
    const keys = new Set<string>();
    const walk = (schema: unknown): void => {
      const s = schema as { shape?: Record<string, unknown>; _def?: { innerType?: unknown; schema?: unknown; type?: unknown } };
      if (s?.shape !== undefined) {
        for (const [k, v] of Object.entries(s.shape)) {
          keys.add(k);
          walk(v);
        }
      }
      if (s?._def?.innerType !== undefined) walk(s._def.innerType);
      if (s?._def?.schema !== undefined) walk(s._def.schema);
    };
    walk(JobSchema);
    expect(keys.size).toBeGreaterThan(15);
    expect([...keys].filter((k) => /image|template|rootfs|kernel|vm/i.test(k))).toEqual([]);
    expect(JobSchema.safeParse(jobFor()).success).toBe(true);
    for (const extra of [{ image: "ubuntu" }, { template: "fx-agent" }, { rootfs: "x" }]) expect(JobSchema.safeParse({ ...jobFor(), ...extra }).success, JSON.stringify(extra)).toBe(false);
    expect(JobSchema.safeParse({ ...jobFor(), repo: { ...jobFor().repo, image: "x" } }).success).toBe(false);
  });
});
