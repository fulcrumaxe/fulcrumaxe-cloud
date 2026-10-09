/**
 * Refusal probes: the one declared exception to the production write fence.
 *
 * A pack lists each probe in `pack.json` `probes` as `{ method, path, expect }`. The API client sends it only
 * from a fresh state (no cookie, no storage state, no Authorization, no redirect followed: a 3xx answer is an error), and the test fails
 * unless the answer is one of the 4xx statuses the pack expects. A probe that expects a 2xx or 3xx cannot be
 * declared, so a probe can never be used to write.
 */
import { readFileSync } from "node:fs";
import type { ApiClient } from "./client.js";

export const PROBE_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;

export interface Probe {
  method: string;
  path: string;
  /** One 4xx status, or a non-empty list of them. */
  expect: number | number[];
}

const PROBE_KEYS = ["method", "path", "expect"] as const;
const PATH_SHAPE = /^\/[^\s\\#]*$/;

function isStatus4xx(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 400 && v <= 499;
}

/** Problems with a pack's `probes` value, each prefixed with the pack. Empty means it is well formed. */
export function probeErrors(raw: unknown, packId: string): string[] {
  const errors: string[] = [];
  const bad = (i: number, msg: string): void => {
    errors.push(`pack ${packId}: probes[${i}] ${msg}`);
  };
  if (!Array.isArray(raw)) return [`pack ${packId}: "probes" must be a list`];
  raw.forEach((p: unknown, i) => {
    if (typeof p !== "object" || p === null || Array.isArray(p)) {
      bad(i, "must be an object { method, path, expect }");
      return;
    }
    const o = p as Record<string, unknown>;
    for (const key of Object.keys(o)) if (!(PROBE_KEYS as readonly string[]).includes(key)) bad(i, `has unknown key "${key}"`);
    for (const key of PROBE_KEYS) if (!(key in o)) bad(i, `is missing "${key}"`);
    if ("method" in o && !(typeof o.method === "string" && (PROBE_METHODS as readonly string[]).includes(o.method))) {
      bad(i, `"method" must be one of ${PROBE_METHODS.join(", ")} (upper case)`);
    }
    if ("path" in o) {
      if (typeof o.path !== "string" || !PATH_SHAPE.test(o.path) || o.path.startsWith("//")) {
        bad(i, `"path" must be a path on the target: it starts with a single "/" and carries no origin (got ${JSON.stringify(o.path)})`);
      }
    }
    if ("expect" in o) {
      const list = Array.isArray(o.expect) ? o.expect : [o.expect];
      if (list.length === 0 || !list.every(isStatus4xx)) {
        bad(i, `"expect" must be a 4xx status or a non-empty list of 4xx statuses (a probe never expects 2xx or 3xx)`);
      }
    }
  });
  return errors;
}

export function expectedStatuses(probe: Pick<Probe, "expect">): number[] {
  return Array.isArray(probe.expect) ? probe.expect : [probe.expect];
}

export interface ProbeResult {
  probe: Probe;
  status: number;
  /** True when the answer is one of the expected 4xx statuses. */
  refused: boolean;
}

/** Sends one probe through the client's fresh-state path and judges the answer. */
export async function runProbe(client: ApiClient, probe: Probe): Promise<ProbeResult> {
  const res = await client.probe(probe);
  return { probe, status: res.status, refused: expectedStatuses(probe).includes(res.status) };
}

/** The probes a pack declares, read from the `pack.json` next to the given spec file URL. */
export function declaredProbes(specUrl: string): Probe[] {
  const raw: unknown = JSON.parse(readFileSync(new URL("./pack.json", specUrl), "utf8"));
  const probes = (raw as { probes?: unknown }).probes;
  const errors = probeErrors(probes, "(spec)");
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return probes as Probe[];
}
