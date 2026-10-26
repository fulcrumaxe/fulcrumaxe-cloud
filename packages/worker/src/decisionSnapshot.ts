import type { PoolClient } from "pg";
import {
  CATALOGUE,
  CATALOGUE_VERSION,
  PRESETS,
  decide,
  findUnresolvedDeclarations,
  decisionLabel,
  getCatalogueEntry,
  type CatalogueEntry,
  type Disposition,
  type PresetName,
} from "@fx/decisions";
import { FIXED_INVARIANT_KEYS, findDialInvariantCollisions } from "@fx/db/src/dialInventory.js";
import { getCurrentDialSetting } from "@fx/db/src/decisions.js";
import { loadRoleCard } from "@fx/roles/cards";
import { recordDecisionSnapshotEvent } from "@fx/runner";

/**
 * D#7 DP4b-1 (correction DP-C11, R-7-DP4b-1): the run's decision snapshot.
 *
 * A role is never told a catalogue id, a class, a preset or a dial. It is told opaque per-run keys (`d1`, `d2`, ...), and the orchestrator maps a key
 * back through this snapshot: one `run_events` row of kind `decision.snapshot`, written in the run's create transaction so a run never exists without
 * one, holding `{catalogue_version, entries: [{key, decision_type, disposition, dial_version}]}`. The disposition is frozen at spawn: a dial change
 * during a run applies to the next run. This file is the build, the write and the read; the call site that uses it and the prompt block that offers
 * the keys are DP4b-2 and DP4b-3.
 *
 * `buildDecisionSnapshot` is pure. `readSnapshotDials` and `writeDecisionSnapshot` take the caller's `withTenant` client.
 */

/** The `run_events.kind` of the snapshot row. */
export const DECISION_SNAPSHOT_KIND = "decision.snapshot";
/** A key: `d1` to `d99`. The only form an agent can name a decision by (R-7-DP4b-1). */
export const SNAPSHOT_KEY_PATTERN = /^d[1-9][0-9]?$/;
export const MAX_SNAPSHOT_ENTRIES = 99;
const INT4_MAX = 2147483647;

export interface DecisionSnapshotEntry {
  /** `d1`, `d2`, ... in declaration order. */
  key: string;
  decision_type: string;
  /** The disposition frozen at spawn. `act` and `announce` both read to the role as "decide yourself and report it"; `ask` as "stop and ask". */
  disposition: Disposition;
  /** The dial row's version in force at spawn; 0 when no row exists and the catalogue default applies. */
  dial_version: number;
}

export interface DecisionSnapshot {
  catalogue_version: number;
  entries: DecisionSnapshotEntry[];
}

/** A dial row as stored (`decision_settings`), reduced to what a disposition needs. `version` is 1 or more. */
export interface SnapshotDial {
  version: number;
  disposition: string;
  preset: string | null;
}

const PRESET_NAMES: readonly string[] = PRESETS.map((p) => p.name);
const DISPOSITIONS: readonly string[] = ["act", "announce", "ask"];

/**
 * Owner ruling 2026-10-25: a repository with no dial row behaves as Balanced. This is an explicit default applied where a run's disposition is frozen and
 * again where the intake recomputes it (both go through `dispositionForDial`). The catalogue's own `defaultDisposition` values are not changed (they pin the
 * catalogue hash, and other readers such as the runner claim keep their own no-row rules). Class 1 stays `act` and class 3 stays `ask` under it, and an entry
 * whose allowed values exclude the preset's value is clamped toward `ask` by `decide()`, exactly as for a row that adopted Balanced.
 */
export const NO_DIAL_ROW_PRESET: PresetName = "balanced";

const isPreset = (value: unknown): value is PresetName => typeof value === "string" && PRESET_NAMES.includes(value);

/**
 * The disposition a dial row means for one catalogue entry, as the snapshot freezes it and as the call site recomputes it (the tamper check,
 * DP4b-2). Pure.
 *  - No row (version 0): the Balanced preset's value for the entry (owner ruling 2026-10-25), see `NO_DIAL_ROW_PRESET`. Catalogue defaults are unchanged.
 *  - A row that adopted a preset: `decide()` under that preset, so the class, the preset and the entry's allowed values clamp it exactly as everywhere else.
 *  - A row that is a per-type override (no preset): the stored disposition if the entry allows it, else `ask` (fails closed, as `resolveStoredDial`).
 */
export function dispositionForDial(entry: CatalogueEntry, dial: SnapshotDial | null): Disposition {
  if (dial === null) return decide(entry, { preset: NO_DIAL_ROW_PRESET }, { type: entry.id, options: ["yes", "no"], proposed: "yes", rationale: "snapshot" }).disposition;
  if (isPreset(dial.preset)) {
    return decide(entry, { preset: dial.preset }, { type: entry.id, options: ["yes", "no"], proposed: "yes", rationale: "snapshot" }).disposition;
  }
  const stored = dial.disposition as Disposition;
  return DISPOSITIONS.includes(dial.disposition) && entry.allowedDispositions.includes(stored) ? stored : "ask";
}

/** The `decision_types: [a, b]` line a role card carries in its frontmatter (the DP5 declaration convention), as a list. A card without the line declares none. */
export function declaredTypesOfCard(cardText: string | undefined): string[] {
  const frontmatter = cardText?.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  const list = frontmatter?.match(/^decision_types:\s*\[([^\]]*)\]\s*$/m)?.[1];
  if (list === undefined) return [];
  return list
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter((s) => s.length > 0);
}

/** The decision types a role declares (its dev card, the one the declared-classes guard reads). A role outside the manifest, or with no card, declares none. */
export function declaredDecisionTypes(role: string): string[] {
  return declaredTypesOfCard(loadRoleCard(role));
}

export interface BuildSnapshotInput {
  role: string;
  /** The dial rows in force, by decision type; a type with no entry has no row (version 0). */
  dials: ReadonlyMap<string, SnapshotDial>;
  /** Test seam; defaults to `declaredDecisionTypes(role)`. */
  declared?: readonly string[];
  /** Test seam: the invariant keys the collision guard checks against; defaults to the real four. */
  invariantKeys?: readonly string[];
  /** A fixed-code line sink for a dropped type; never receives agent text. */
  warn?: (line: string) => void;
}

/**
 * Pure. Offers exactly the role's declared types that resolve to a catalogue entry (a declaration that does not resolve is dropped, never guessed
 * at), minus any type `findDialInvariantCollisions()` flags, with keys `d1..dN` in declaration order. A repeated declaration is offered once.
 * A role with no declarations gets an empty snapshot.
 */
export function buildDecisionSnapshot(input: BuildSnapshotInput): DecisionSnapshot {
  const warn = input.warn ?? (() => undefined);
  const declared = [...new Set(input.declared ?? declaredDecisionTypes(input.role))];
  const unresolved = new Set(findUnresolvedDeclarations(declared.map((decisionType) => ({ source: input.role, decisionType }))).map((d) => d.decisionType));
  const resolvable = declared.filter((id) => !unresolved.has(id));
  for (const id of unresolved) warn(JSON.stringify({ event: "decision.snapshot_dropped", reason: "not_in_catalogue", decision_type: id.slice(0, 64) }));
  const colliding = new Set(findDialInvariantCollisions(resolvable, input.invariantKeys ?? FIXED_INVARIANT_KEYS));
  for (const id of colliding) warn(JSON.stringify({ event: "decision.snapshot_dropped", reason: "invariant_collision", decision_type: id }));
  const offered = resolvable.filter((id) => !colliding.has(id)).slice(0, MAX_SNAPSHOT_ENTRIES);
  const entries = offered.map((id, i): DecisionSnapshotEntry => {
    const entry = getCatalogueEntry(id) as CatalogueEntry;
    const dial = input.dials.get(id) ?? null;
    return { key: `d${i + 1}`, decision_type: id, disposition: dispositionForDial(entry, dial), dial_version: dial === null ? 0 : dial.version };
  });
  return { catalogue_version: CATALOGUE_VERSION, entries };
}

/** The dial rows in force for `repoId`, for the types a role declares that are in the catalogue. `client` must come from `withTenant`. */
export async function readSnapshotDials(client: PoolClient, repoId: string, decisionTypes: readonly string[]): Promise<Map<string, SnapshotDial>> {
  const dials = new Map<string, SnapshotDial>();
  for (const id of new Set(decisionTypes)) {
    if (!CATALOGUE.some((e) => e.id === id)) continue;
    const row = await getCurrentDialSetting(client, repoId, id);
    if (row !== null) dials.set(id, { version: row.version, disposition: row.disposition, preset: row.preset });
  }
  return dials;
}

/** Thrown by `readDecisionSnapshot` for a row that exists but is not a valid snapshot. The caller refuses every request of that run (fails closed). */
export class DecisionSnapshotInvalidError extends Error {
  constructor() {
    super("decision_snapshot_invalid");
    this.name = "DecisionSnapshotInvalidError";
  }
}

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(value, k));
};

/** Total and strict: the snapshot a payload is, or null. Unknown keys, duplicate keys, a non-catalogue-looking type, an unknown disposition or a bad version all refuse. */
export function parseDecisionSnapshot(payload: unknown): DecisionSnapshot | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  if (!hasExactKeys(p, ["catalogue_version", "entries"])) return null;
  const version = p.catalogue_version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1 || version > INT4_MAX) return null;
  if (!Array.isArray(p.entries) || p.entries.length > MAX_SNAPSHOT_ENTRIES) return null;
  const seenKeys = new Set<string>();
  const entries: DecisionSnapshotEntry[] = [];
  for (const raw of p.entries as unknown[]) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const e = raw as Record<string, unknown>;
    if (!hasExactKeys(e, ["key", "decision_type", "disposition", "dial_version"])) return null;
    if (typeof e.key !== "string" || !SNAPSHOT_KEY_PATTERN.test(e.key) || seenKeys.has(e.key)) return null;
    if (typeof e.decision_type !== "string" || e.decision_type === "" || e.decision_type.length > 64) return null;
    if (typeof e.disposition !== "string" || !DISPOSITIONS.includes(e.disposition)) return null;
    if (typeof e.dial_version !== "number" || !Number.isInteger(e.dial_version) || e.dial_version < 0 || e.dial_version > INT4_MAX) return null;
    seenKeys.add(e.key);
    entries.push({ key: e.key, decision_type: e.decision_type, disposition: e.disposition as Disposition, dial_version: e.dial_version });
  }
  return { catalogue_version: version, entries };
}

/**
 * Writes the run's one `decision.snapshot` row on the given client. Call it from the run's create transaction (`inCreateTransaction`), so a failure
 * rolls the run back. The tenant is the client's own (`withTenant`); a client with none is refused before anything is written.
 */
export async function writeDecisionSnapshot(client: PoolClient, runId: string, snapshot: DecisionSnapshot): Promise<void> {
  if (parseDecisionSnapshot(snapshot) === null) throw new DecisionSnapshotInvalidError();
  const { rows } = await client.query<{ account_id: string | null }>("SELECT NULLIF(current_setting('app.account_id', true), '') AS account_id");
  const accountId = rows[0]?.account_id;
  if (!accountId) throw new Error("decision_snapshot_no_tenant");
  await recordDecisionSnapshotEvent(client, { accountId, runId, payload: { ...snapshot } });
}

/**
 * Reads a run's snapshot: `null` when the run has none (the caller refuses every request as `decision_snapshot_missing`), the snapshot when it has
 * exactly one valid row, and throws `DecisionSnapshotInvalidError` when a row fails its own schema or there is more than one. `client` must come from `withTenant`.
 */
export async function readDecisionSnapshot(client: PoolClient, runId: string): Promise<DecisionSnapshot | null> {
  const { rows } = await client.query<{ payload: unknown }>(
    "SELECT payload FROM run_events WHERE run_id = $1::uuid AND kind = $2 ORDER BY seq LIMIT 2",
    [runId, DECISION_SNAPSHOT_KIND],
  );
  if (rows.length === 0) return null;
  const parsed = rows.length === 1 ? parseDecisionSnapshot(rows[0]!.payload) : null;
  if (parsed === null) throw new DecisionSnapshotInvalidError();
  return parsed;
}

/** One line of the prompt's decisions block, as the pipeline renders it. The label is a fixed catalogue name, never text from a repository or a person. */
export interface DecisionOfferItem {
  key: string;
  label: string;
  /** `decide`: "decide yourself and report it" (`act` and `announce` both read so). `ask`: "stop and ask". */
  instruction: "decide" | "ask";
}

/** Fails closed by construction: only `act` and `announce` read as "decide yourself and report it"; `ask` and anything else read as "stop and ask". */
export function offerInstruction(disposition: Disposition): DecisionOfferItem["instruction"] {
  return disposition === "act" || disposition === "announce" ? "decide" : "ask";
}

export interface DecisionOffer {
  items: DecisionOfferItem[];
  snapshot: DecisionSnapshot;
}

/**
 * D#7 DP4b-3: what a new executor run is offered, resolved once at spawn from the dials in force for the item's repository: the snapshot to write in the run's
 * create transaction and the list the prompt shows. Both come from one `buildDecisionSnapshot`, so the keys in the prompt are the keys in the row.
 * `client` must come from `withTenant`. The label of an entry is `decisionLabel(decision_type)`, a constant table; nothing a repository or a person wrote reaches it.
 */
export async function resolveDecisionOffer(client: PoolClient, repoId: string, role: string, warn?: (line: string) => void): Promise<DecisionOffer> {
  const declared = declaredDecisionTypes(role);
  const dials = await readSnapshotDials(client, repoId, declared);
  const snapshot = buildDecisionSnapshot({ role, dials, declared, ...(warn ? { warn } : {}) });
  return {
    snapshot,
    items: snapshot.entries.map((e): DecisionOfferItem => ({ key: e.key, label: decisionLabel(e.decision_type), instruction: offerInstruction(e.disposition) })),
  };
}
