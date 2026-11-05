import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { operatorVerdict, type OperatorFacts } from '../src/work-items/operatorActions.js';
import { QUEUE_WAIT_STOP_CODES } from '../src/work-items/mergeReadiness.js';
import { classifyStall, STALL_ACTION_LABELS, stallActionLabel, STOP_WORDS, type StallFacts } from '../src/work-items/stalled.js';

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

/** True when the text before `idx` on its line leaves `idx` in code: not in a comment line, a trailing comment, a block comment opened on the line, or a string literal. */
export function inCode(src: string, idx: number): boolean {
  const line = src.slice(src.lastIndexOf('\n', idx - 1) + 1, idx);
  if (/^\s*(\/\/|\*)/.test(line)) return false;
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]!;
    if (quote !== null) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '/' && line[i + 1] === '/') return false;
    else if (c === '/' && line[i + 1] === '*') {
      const close = line.indexOf('*/', i + 2);
      if (close === -1) return false;
      i = close + 1;
    }
  }
  return quote === null;
}

/** Every `stopEntry(` call in the source, counted on its own (comments, string literals and the definition left out), so the parser below cannot miss a call without this count showing it. */
function stopEntryCallCount(): number {
  let n = 0;
  for (const abs of files(SRC)) {
    const src = readFileSync(abs, 'utf8');
    for (const m of src.matchAll(/\bstopEntry\(/g)) {
      if (inCode(src, m.index!) && !/function\s+$/.test(src.slice(0, m.index!))) n += 1;
    }
  }
  return n;
}

function stopReasonsFromSource(): { reasons: Set<string>; unresolved: string[]; sites: number } {
  const reasons = new Set<string>();
  const unresolved: string[] = [];
  let sites = 0;
  for (const abs of files(SRC)) {
    const rel = abs.slice(SRC.length);
    const src = readFileSync(abs, 'utf8');
    for (const m of src.matchAll(/stopEntry\(\s*\w+,\s*\{([^}]*)\}/g)) {
      if (!inCode(src, m.index!)) continue;
      const found = /(?:^|[\s,{])reason(?:\s*:\s*([^,}]+))?\s*(?:,|$)/.exec(m[1]!);
      if (found === null) {
        unresolved.push(`${rel}: a stopEntry call with no reason before its first nested brace`);
        continue;
      }
      sites += 1;
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
  return { reasons, unresolved, sites };
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
const KNOWN_GAPS: readonly string[] = [];

describe('stalled card words for merge-queue stops', () => {
  const { reasons, unresolved, sites } = stopReasonsFromSource();

  it('every stop site in the source resolves to a fixed reason (a new dynamic site needs a resolver)', () => {
    expect(unresolved).toEqual([]);
    expect(reasons.size).toBeGreaterThan(5);
    expect(reasons.has('ordered_resource_path_too_long')).toBe(true);
  });

  it('the parser resolves every stopEntry call (a first argument that is not a bare name, an object built beforehand, or a nested brace before the reason would otherwise be missed)', () => {
    expect(sites).toBe(stopEntryCallCount());
    expect(sites).toBeGreaterThan(15);
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
  it('inCode ignores a stopEntry( in a comment line, a trailing comment, a block comment or a string, and keeps one in code', () => {
    const at = (line: string): boolean => inCode(line, line.indexOf('stopEntry('));
    expect(at('  await stopEntry(c, {')).toBe(true);
    expect(at('  /* note */ await stopEntry(c, {')).toBe(true);
    expect(at('  // await stopEntry(c, {')).toBe(false);
    expect(at('  * see stopEntry(c, {')).toBe(false);
    expect(at('  run(); // then stopEntry(c, {')).toBe(false);
    expect(at('  run(); /* then stopEntry(c, {')).toBe(false);
    expect(at('  log("stopEntry(c, {')).toBe(false);
    expect(at("  log('it\\'s stopEntry(c, {")).toBe(false);
    expect(at('  log(`x ${a} stopEntry(c, {')).toBe(false);
    expect(at('  log("a" + stopEntry(c, {')).toBe(true);
  });

  /**
   * A sentence that says the merge is looked at again without anyone pressing anything must name a requeue the code really does. A push to the branch only records
   * the push and a person's Check the merge is the only thing that re-checks, so a claim of an automatic re-check is true only for a stop in AUTO_REQUEUE, whose
   * value is the store function that moves a stopped entry of that reason back to queued.
   */
  const AUTO_REQUEUE: Readonly<Record<string, string>> = { ci_not_green: 'requeueCiStopped' };
  const CLAIMS_AUTOMATIC_RECHECK = /\b(is|are|gets) (checked|tried|run|queued|looked at) again\b|\bby itself\b|\bautomatically\b|\bon its own\b/i;

  it('a sentence that claims an automatic re-check is for a stop the code requeues on its own', () => {
    const store = readFileSync(new URL('../../pipeline/src/mergeQueue/store.ts', import.meta.url), 'utf8');
    const claiming = Object.entries(STOP_WORDS).filter(([, text]) => CLAIMS_AUTOMATIC_RECHECK.test(text)).map(([code]) => code);
    expect(claiming.filter((c) => AUTO_REQUEUE[c] === undefined)).toEqual([]);
    for (const [code, fn] of Object.entries(AUTO_REQUEUE)) {
      expect(STOP_WORDS[code], `${code} is in AUTO_REQUEUE but makes no such claim`).toMatch(CLAIMS_AUTOMATIC_RECHECK);
      const requeue = new RegExp(`export async function ${fn}\\b[\\s\\S]*?SET state = 'queued'[\\s\\S]*?reason = '${code}'`).exec(store);
      expect(requeue, `${fn} does not requeue a stopped ${code} entry`).not.toBeNull();
    }
  });

  it('the claim detector sees the sentence that was wrong', () => {
    expect(CLAIMS_AUTOMATIC_RECHECK.test('Rename that file and push; the merge is checked again on the new commit.')).toBe(true);
    expect(CLAIMS_AUTOMATIC_RECHECK.test('Push a new commit, then press Check the merge to run the check again.')).toBe(false);
  });

  /** The words each former gap now shows, the fact kind the workflow writes it as, and the steps its sentence names (each asserted as offered below). */
  const FORMER_GAPS: ReadonlyArray<{ code: string; kind: 'stopped' | 'escalated'; steps: readonly string[] }> = [
    { code: 'ordered_resource_path_too_long', kind: 'stopped', steps: ['Check the merge'] },
    { code: 'writeback_changed_by_other', kind: 'stopped', steps: [] },
    { code: 'refused_spend', kind: 'stopped', steps: ['Check the merge'] },
    { code: 'renumber_out_of_scope', kind: 'stopped', steps: ['Check the merge'] },
    { code: 'ordered_resource_unreadable', kind: 'stopped', steps: ['Check the merge'] },
    { code: 'merge_queue_no_answer', kind: 'escalated', steps: ['Queue again'] },
    { code: 'removed_from_merge_queue', kind: 'stopped', steps: ['Queue again'] },
    { code: 'merge_call_refused', kind: 'stopped', steps: ['Check the merge'] },
    { code: 'ci_not_green', kind: 'stopped', steps: [] },
  ];
  const stalled = (code: string, kind: string): StallFacts => ({ stage: 'review_passed', halted: false, liveRun: false, pendingRequest: false, waitingAsk: false, last: { kind, code, reasons: [], at: new Date(0) }, lastActivity: new Date(0), now: new Date(60 * 60_000) });

  it.each(FORMER_GAPS)('$code reads as its own sentence, not the generic fallback', ({ code, kind }) => {
    const s = classifyStall(stalled(code, kind))!;
    expect(s.why).toBe(STOP_WORDS[code]);
    expect(s.why).not.toContain('The pipeline stopped (');
    expect(s.why).not.toContain('handed this to a person (');
    expect(s.why).not.toContain(code.replace(/_/g, ' '));
  });

  it('every step a sentence names is one the item offers in the state it stalls in', () => {
    const actions = readFileSync(new URL('../../../apps/workspace/apps/pipeline/pipeline-actions.js', import.meta.url), 'utf8');
    const base: OperatorFacts = { stage: 'review_passed', discussion_id: 'd', kind: 'feature', has_spec: true, provenance: 'internal', repo_id: 'r', gh_number: '12', live_run: false, role: 'admin', spec_file_list_known: true };
    for (const { code, steps } of FORMER_GAPS) {
      for (const step of steps) {
        expect(STOP_WORDS[code], code).toContain(step);
        if (step === 'Check the merge') {
          // The card's top button at Review passed, from the stage driver's own table.
          expect(STALL_ACTION_LABELS.review_passed).toBe(step);
          expect(stallActionLabel('review_passed', { discussionId: 'd', kind: 'feature', hasSpec: true, noVerdictHold: false }), code).toBe(step);
        } else {
          expect(actions, code).toContain(`queue_again: "${step}"`);
          // Queue again: offered at Review passed after a person's removal, and at Needs a person after the host's silence.
          const ok = code === 'merge_queue_no_answer' ? { ...base, stage: 'needs_human', merge_queue: 'no_answer' as const, queue_hold: true } : { ...base, merge_queue: 'removed' as const };
          expect(operatorVerdict('queue_again', ok), code).toEqual({ ok: true });
        }
      }
    }
  });
});
