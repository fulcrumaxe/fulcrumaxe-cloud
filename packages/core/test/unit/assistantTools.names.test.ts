import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { ASSISTANT_TOOL_NAMES, assistantToolDefs, newTurnState, runAssistantTool } from '../../src/assistant/tools.js';

const FORBIDDEN = ['accept', 'approve', 'merge', 'cancel', 'halt', 'resume', 'reject', 'respec', 'close'];
const ctx = { pool: {} as Pool, principal: { accountId: 'a', userId: 'u' }, repoId: 'r', itemKinds: ['feature', 'bug'] };
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../src/assistant/tools.ts'), 'utf8');

describe('assistant tool registry (D#597 CC-5d)', () => {
  it('lists a closed set of names, none naming an act a person must take', () => {
    const listed = assistantToolDefs().map((t) => t.name);
    expect(listed).toEqual([...ASSISTANT_TOOL_NAMES]);
    expect(listed).toEqual(['get_item', 'get_spec', 'get_run_activity', 'get_verdicts', 'get_plan', 'list_corrections', 'draft_correction']);
    for (const n of listed) for (const f of FORBIDDEN) expect(n).not.toContain(f);
  });

  it('every schema refuses unknown fields', () => {
    for (const t of assistantToolDefs()) expect(t.input_schema).toMatchObject({ type: 'object', additionalProperties: false });
  });

  it('drops a tool outside the list without running anything', async () => {
    for (const n of ['accept_correction', 'merge_pr', 'halt', 'GET_ITEM', '']) {
      expect(await runAssistantTool(ctx, newTurnState(), n, {})).toBeNull();
    }
  });

  it('refuses malformed input before any database call', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const bad: Array<[string, unknown]> = [
      ['get_item', { item_id: id, extra: 'x' }],
      ['get_item', {}],
      ['get_item', { item_id: 'nope' }],
      ['get_item', null],
      ['get_item', [id]],
      ['get_item', { item_id: 5 }],
      ['get_plan', { status: 'open' }],
      ['draft_correction', { item_id: id, kind: 'accepted', body: 'x' }],
      ['draft_correction', { item_id: id, kind: 'question', body: 'x', status: 'accepted' }],
      ['draft_correction', { item_id: id, kind: 'question', body: 'x', origin: 'agent' }],
      ['draft_correction', { item_id: id, kind: 'question', body: 'x'.repeat(4001) }],
    ];
    for (const [n, input] of bad) {
      const r = await runAssistantTool(ctx, newTurnState(), n, input);
      expect(r?.isError, n).toBe(true);
      expect(r?.text).toMatch(/^invalid input/);
    }
  });

  it('refuses inherited and prototype keys before any read', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    for (const key of ['constructor', 'toString', '__proto__']) {
      const input = JSON.parse(`{"item_id":"${id}","${key}":"x"}`) as unknown;
      expect(await runAssistantTool(ctx, newTurnState(), 'get_item', input), key).toEqual({ text: 'invalid input: unknown field', isError: true });
      const draft = JSON.parse(`{"item_id":"${id}","kind":"question","body":"x","${key}":"x"}`) as unknown;
      expect((await runAssistantTool(ctx, newTurnState(), 'draft_correction', draft))?.text, key).toBe('invalid input: unknown field');
    }
    // Inherited names do not satisfy a required field either.
    expect((await runAssistantTool(ctx, newTurnState(), 'get_item', Object.create({ item_id: id })))?.text).toBe('invalid input: missing field item_id');
  });

  it('imports no accept, reject, stage, halt or merge writer and no fetch', () => {
    const imports = [...src.matchAll(/^import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'([^']+)'/gm)].map((m) => ({ names: m[1]!.split(',').map((s) => s.trim()), from: m[2]! }));
    const modules = imports.map((i) => i.from).join(' ');
    expect(modules).not.toMatch(/accept|driver|stages|advance|operatorActions|operatorMoves|halt|merge|recordStage|reviewHold/i);
    const names = imports.flatMap((i) => i.names).join(' ');
    expect(names).not.toMatch(/decideCorrection|markCorrectionApplied|attachRunNotes|accept|reject|halt|merge|resume|cancel/i);
    expect(src).not.toMatch(/\bfetch\s*\(|node:https?|node:net|undici/);
  });
});
