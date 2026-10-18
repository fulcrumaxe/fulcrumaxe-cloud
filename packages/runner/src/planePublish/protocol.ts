import { PLANE_REFUSAL_CODES, type PlaneRefusalCode } from "@fulcrumaxe/runner-protocol/planePush";

/**
 * D#598 P1f-5a: what the worker and the `fx-plane-publish` hook in a publish sandbox say to each other, and nothing else.
 *
 *   in   one JSON file the worker writes (`PLANE_PUBLISH_INPUT_PATH`). It holds repository names, commit ids, the branch, the PR text, the platform
 *        identity and the pairing. It holds no credential: the sandbox has none, and the proxy adds every GitHub credential outside the VM.
 *   out  fixed-shape JSON lines on standard output, one per phase. No field can carry file content, a diff, a matched value or a token; every
 *        string is checked against a pattern on the way out (`phaseLine`) and again on the way in (`parsePhaseLines`).
 */
export const PLANE_PUBLISH_DIR = "/fx/plane-publish";
export const PLANE_PUBLISH_HOOK_PATH = `${PLANE_PUBLISH_DIR}/fx-plane-publish.mjs`;
export const PLANE_PUBLISH_INPUT_PATH = `${PLANE_PUBLISH_DIR}/input.json`;
export const MAX_INPUT_BYTES = 1024 * 1024;

const OBJECT_ID = /^[0-9a-f]{40}$/;
const OWNER = /^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const CODE_REPO = /^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/;
const RULE_PATH = /^[A-Za-z0-9._/-]{1,300}$/;
const SHOWN = /^[\x20-\x7e]{1,300}$/;

export interface PlanePublishInput {
  /** The private repository the change comes from. */
  own: { owner: string; name: string };
  /** The paired public repository, `owner/name`. */
  codeRepo: string;
  privateBase: string;
  privateHead: string;
  /** The public branch, the PR text and the commit identity: the platform's own text, never the agent's. */
  branch: string;
  title: string;
  body: string;
  identity: { name: string; email: string };
  commitTime: number;
  pairing: { overlayGlobs: string[]; identifierRulesPath: string | null; planDataRulesPath: string | null };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strictKeys = (v: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length >= 1 && v.length <= max;

/** The input as parsed, or `undefined` for anything that is not exactly the shape above. Field-level rules the route owns (branch, title, body, identity) are the route's. */
export function parsePlanePublishInput(raw: string): PlanePublishInput | undefined {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    // fx-swallow-ok: a file that is not JSON is the same closed answer as any other bad input
    return undefined;
  }
  if (!isObject(v) || !strictKeys(v, ["own", "codeRepo", "privateBase", "privateHead", "branch", "title", "body", "identity", "commitTime", "pairing"])) return undefined;
  const { own, identity, pairing } = v;
  if (!isObject(own) || !strictKeys(own, ["owner", "name"]) || typeof own.owner !== "string" || !OWNER.test(own.owner) || typeof own.name !== "string" || !NAME.test(own.name)) return undefined;
  if (typeof v.codeRepo !== "string" || !CODE_REPO.test(v.codeRepo)) return undefined;
  if (typeof v.privateBase !== "string" || !OBJECT_ID.test(v.privateBase) || typeof v.privateHead !== "string" || !OBJECT_ID.test(v.privateHead)) return undefined;
  if (!text(v.branch, 400) || !text(v.title, 300) || !text(v.body, 60_000) || typeof v.commitTime !== "number") return undefined;
  if (!isObject(identity) || !strictKeys(identity, ["name", "email"]) || !text(identity.name, 200) || !text(identity.email, 200)) return undefined;
  if (!isObject(pairing) || !strictKeys(pairing, ["overlayGlobs", "identifierRulesPath", "planDataRulesPath"])) return undefined;
  const { overlayGlobs, identifierRulesPath, planDataRulesPath } = pairing;
  if (!Array.isArray(overlayGlobs) || overlayGlobs.length > 500 || !overlayGlobs.every((g) => text(g, 300))) return undefined;
  for (const p of [identifierRulesPath, planDataRulesPath]) if (p !== null && !(typeof p === "string" && RULE_PATH.test(p) && !p.startsWith("/") && !p.split("/").includes(".."))) return undefined;
  return v as unknown as PlanePublishInput;
}

export const PHASES = ["building", "scanning", "pushed", "pr_opened", "pr_failed", "refused", "no_change"] as const;
export type PlanePublishPhase = (typeof PHASES)[number];
export const TERMINAL_PHASES: readonly PlanePublishPhase[] = ["pr_opened", "pr_failed", "refused", "no_change"];

export interface PlanePublishLine {
  phase: PlanePublishPhase;
  code?: PlaneRefusalCode;
  refusals?: Array<{ kind: string; place: string; rule_key: string }>;
  branch?: string;
  head_sha?: string;
  tip_sha?: string;
  pr_number?: number;
}

const MARK = '{"fx":"plane_publish",';
const FIELDS = ["phase", "code", "refusals", "branch", "head_sha", "tip_sha", "pr_number"] as const;

/** True for a line whose every field is within its pattern. Used to print and to read, so the two cannot disagree. */
function wellFormed(l: Record<string, unknown>): l is Record<string, unknown> & PlanePublishLine {
  if (!Object.keys(l).every((k) => (FIELDS as readonly string[]).includes(k)) || !(PHASES as readonly unknown[]).includes(l.phase)) return false;
  if (l.code !== undefined && !(PLANE_REFUSAL_CODES as readonly unknown[]).includes(l.code)) return false;
  if (l.branch !== undefined && !(typeof l.branch === "string" && SHOWN.test(l.branch))) return false;
  for (const k of ["head_sha", "tip_sha"]) if (l[k] !== undefined && !(typeof l[k] === "string" && OBJECT_ID.test(l[k] as string))) return false;
  if (l.pr_number !== undefined && !(Number.isSafeInteger(l.pr_number) && (l.pr_number as number) > 0)) return false;
  if (l.refusals !== undefined) {
    if (!Array.isArray(l.refusals) || l.refusals.length > 100) return false;
    for (const r of l.refusals) {
      if (!isObject(r) || !strictKeys(r, ["kind", "place", "rule_key"]) || !["kind", "place", "rule_key"].every((k) => typeof r[k] === "string" && SHOWN.test(r[k] as string))) return false;
    }
  }
  return true;
}

/** One output line. Throws when a field is outside its pattern, so a bad value is a crash (no terminal line), never a sent line. */
export function phaseLine(line: PlanePublishLine): string {
  if (!wellFormed({ ...line })) throw new Error("plane publish: a phase line field is outside its pattern");
  return `${MARK}${JSON.stringify(line).slice(1)}`;
}

/** The well-formed phase lines in a command's output, in order. Any other line (a warning, noise) is dropped. */
export function parsePhaseLines(stdout: string): PlanePublishLine[] {
  const out: PlanePublishLine[] = [];
  for (const raw of stdout.split("\n")) {
    if (!raw.startsWith(MARK) || out.length >= 20) continue;
    try {
      const rest = JSON.parse(raw) as Record<string, unknown>;
      delete rest.fx;
      if (wellFormed(rest)) out.push(rest as unknown as PlanePublishLine);
    } catch {
      // fx-swallow-ok: a line that is not JSON is dropped like any other noise
    }
  }
  return out;
}

/** The one terminal line of a run, or `undefined` when there is none (a crash, a kill, or a command that ended early). */
export function terminalLine(lines: readonly PlanePublishLine[]): PlanePublishLine | undefined {
  const done = lines.filter((l) => TERMINAL_PHASES.includes(l.phase));
  return done.length === 1 ? done[0] : undefined;
}
