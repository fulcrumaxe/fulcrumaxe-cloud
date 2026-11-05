import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { QUEUE_WAIT_STOP_CODES } from '../src/work-items/mergeReadiness.js';
import { classifyStall, STOP_WORDS, type StallFacts } from '../src/work-items/stalled.js';

/**
 * A ratchet on the words a stalled card shows for a merge-queue stop. Every reason the queue code can stop an entry with is found by reading the source
 * (nothing is copied by hand), and must have a sentence in STOP_WORDS, a place where another table words it (COVERED_ELSEWHERE), or an entry in
 * KNOWN_GAPS. A new reason in none of them fails; so does a KNOWN_GAPS entry that has since got a sentence, so the list only shrinks.
 */
const SRC = new URL('../../pipeline/src/', import.meta.url).pathname;
const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : n.endsWith('.ts') ? [join(dir, n)] : []));
const lits = (s: string): string[] => [...s.matchAll(/"([a-z][a-z_]*)"/g)].map((m) => m[1]!);

/** Dynamic `reason:` expressions in stopEntry calls, each resolved from the source that fixes its values. */
const DYNAMIC: Record<string, (src: string) => string[]> = {
  'mergeQueue/refresh.ts|started.reason': (src) => [...src.matchAll(/started\.reason === "([a-z_]+)"\) \{\s*await stopEntry/g)].map((m) => m[1]!),
  'mergeQueue/store.ts|removalStopReason(v.verdict)': (src) => [...src.matchAll(/const HOST_(?:DEQUEUED|RETRY_USED)_REASON = "([a-z_]+)"/g)].map((m) => m[1]!),
  // The gate's own refusal reasons (the MergeBlockReason union): the entry stops with the first, and the card words it through the merge_gate fact's table (GATE_REASON_WORDS), not a `stopped` fact.
  'mergeQueue/tick.ts|reason': () => [],
  'mergeQueue/conflictComplete.ts|reason': (src) => [...src.matchAll(/kind: "stop", reason: "([a-z_]+)"/g), ...src.matchAll(/judgeRoundHead\(ports, who, round, "([a-z_]+)"\)/g)].map((m) => m[1]!),
  'build/planWriteback.ts|input.cause': (src) => lits(/export type RestartCause =([^;]+);/.exec(src)![1]!),
};

function stopReasonsFromSource(): { reasons: Set<string>; unresolved: string[] } {
  const reasons = new Set<string>();
  const unresolved: string[] = [];
  for (const abs of files(SRC)) {
    const rel = abs.slice(SRC.length);
    const src = readFileSync(abs, 'utf8');
    for (const m of src.matchAll(/stopEntry\(\s*\w+,\s*\{([^}]*)\}/g)) {
      const found = /(?:^|[\s,{])reason(?:\s*:\s*([^,}]+))?\s*(?:,|$)/.exec(m[1]!);
      if (found === null) continue; // the definition in store.ts takes no literal
      const raw = (found[1] ?? 'reason').replace(/\s+satisfies\s+\w+\s*$/, '').trim();
      const lit = /^"([a-z_]+)"$/.exec(raw);
      const konst = /^[A-Z_]+$/.test(raw) ? new RegExp(`const ${raw} = "([a-z_]+)"`).exec(src) : null;
      const resolver = DYNAMIC[`${rel}|${raw}`];
      if (lit) reasons.add(lit[1]!);
      else if (konst) reasons.add(konst[1]!);
      else if (resolver) resolver(src).forEach((r) => reasons.add(r));
      else unresolved.push(`${rel}: reason: ${raw}`);
    }
    for (const m of src.matchAll(/state = 'stopped', reason = '([a-z_]+)'/g)) reasons.add(m[1]!);
  }
  return { reasons, unresolved };
}

/** Reasons whose card words live in another table. The value names the table; a test below checks each is really there. */
const COVERED_ELSEWHERE: Readonly<Record<string, string>> = {
  merge_conflict: 'mergeReadiness',
  merge_dependency_closed: 'mergeReadiness',
  retarget_failed: 'mergeReadiness',
  branch_behind: 'QUEUE_WAIT_STOP_CODES',
  ordered_resource_out_of_order: 'QUEUE_WAIT_STOP_CODES',
  history_rewritten: 'QUEUE_WAIT_STOP_CODES',
};

/** Reasons that still show the generic fallback. Each one needs a sentence of its own; when it gets one, delete it from here. */
const KNOWN_GAPS: readonly string[] = [
  'writeback_changed_by_other',
  'refused_spend',
  'renumber_out_of_scope',
  'ordered_resource_unreadable',
  'merge_queue_no_answer',
  'removed_from_merge_queue',
  'merge_call_refused',
  'ci_not_green',
];

describe('stalled card words for merge-queue stops', () => {
  const { reasons, unresolved } = stopReasonsFromSource();

  it('every stop site in the source resolves to a fixed reason (a new dynamic site needs a resolver)', () => {
    expect(unresolved).toEqual([]);
    expect(reasons.size).toBeGreaterThan(5);
    expect(reasons.has('ordered_resource_path_too_long')).toBe(true);
  });

  it('every reason has a sentence, a place that words it, or a KNOWN_GAPS entry', () => {
    const lost = [...reasons].filter((r) => STOP_WORDS[r] === undefined && COVERED_ELSEWHERE[r] === undefined && !KNOWN_GAPS.includes(r));
    expect(lost).toEqual([]);
  });

  it('a KNOWN_GAPS entry that now has a sentence (or is covered elsewhere, or is gone from the source) is stale', () => {
    expect(KNOWN_GAPS.filter((r) => STOP_WORDS[r] !== undefined || COVERED_ELSEWHERE[r] !== undefined || !reasons.has(r))).toEqual([]);
  });

  it('COVERED_ELSEWHERE names a real place for each entry, and no entry also sits in STOP_WORDS', () => {
    const readiness = readFileSync(new URL('../src/work-items/mergeReadiness.ts', import.meta.url), 'utf8');
    for (const [reason, table] of Object.entries(COVERED_ELSEWHERE)) {
      expect(reasons.has(reason), `${reason} is not a stop reason in the source`).toBe(true);
      expect(STOP_WORDS[reason], `${reason} is in both`).toBeUndefined();
      if (table === 'QUEUE_WAIT_STOP_CODES') expect(QUEUE_WAIT_STOP_CODES as readonly string[]).toContain(reason);
      else expect(readiness).toContain(`'${reason}'`);
    }
  });

  it('a path too long for the numbered-file check reads as its own sentence, not the generic fallback', () => {
    const f: StallFacts = { stage: 'review_passed', halted: false, liveRun: false, pendingRequest: false, waitingAsk: false, last: { kind: 'stopped', code: 'ordered_resource_path_too_long', reasons: [], at: new Date(0) }, lastActivity: new Date(0), now: new Date(60 * 60_000) };
    const s = classifyStall(f)!;
    expect(s.why).toBe(STOP_WORDS.ordered_resource_path_too_long);
    expect(s.why).not.toContain('The pipeline stopped');
    expect(s.why).toContain('512');
  });
});
