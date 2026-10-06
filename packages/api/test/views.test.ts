import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openCursor } from '../src/sse/cursor.js';
import type { AccountEventRow } from '../src/sse/poller.js';
import { HEARTBEAT_FRAME, accountEventCursor, frame, safeEventName, toAccountEventDTO, toRunEventDTO } from '../src/sse/views.js';

const ENV = { FX_CURSOR_KEY_V1: randomBytes(32).toString('base64') };
const FAKE_FXAT = 'fxat_' + 'A1b2C3d4E5'.repeat(4) + 'Zz9Yy8Xx7';
const FAKE_WHSEC = 'whsec_' + 'abcdefghijklmnopqrstuvwxyz0123';

const row = (over: Partial<AccountEventRow> = {}): AccountEventRow => ({
  seq: 987654321987n,
  id: randomUUID(),
  type: 'pr.opened',
  subjectId: null,
  payload: {},
  createdAt: new Date('2026-09-01T12:00:00.000Z'),
  ...over,
});

describe('stream views (D#31 API-5)', () => {
  it('an account event DTO has exactly id, type, created_at, data and never the serial', () => {
    const r = row({ payload: { pr_number: 7 } });
    const dto = toAccountEventDTO(r);
    expect(Object.keys(dto).sort()).toEqual(['created_at', 'data', 'id', 'type']);
    expect(dto).toMatchObject({ id: r.id, type: 'pr.opened', created_at: '2026-09-01T12:00:00.000Z' });
    expect(JSON.stringify(dto)).not.toContain('987654321987');
  });

  it('a non-object payload becomes an empty data object; keys outside the ids-only allowlist and secret-shaped values are dropped', () => {
    for (const payload of [null, 'text', [1, 2], 5]) {
      expect(toAccountEventDTO(row({ payload })).data).toEqual({});
    }
    const dto = toAccountEventDTO(row({ payload: { pr_number: 7, title: `leak ${FAKE_FXAT}`, secret: FAKE_WHSEC, run_id: FAKE_WHSEC } }));
    const text = JSON.stringify(dto);
    expect(text).not.toContain(FAKE_FXAT);
    expect(text).not.toContain(FAKE_WHSEC);
    expect(dto.data).not.toHaveProperty('secret');
    expect(dto.data).not.toHaveProperty('title');
  });

  it('run event DTOs are redacted again on the way out, even when the stored row was not', () => {
    const dto = toRunEventDTO({ seq: 1, kind: 'log', at: '2026-09-01T12:00:00.000Z', payload: { line: `${FAKE_FXAT} ${FAKE_WHSEC}`, nested: [FAKE_FXAT] } });
    const text = JSON.stringify(dto);
    expect(text).not.toContain(FAKE_FXAT);
    expect(text).not.toContain(FAKE_WHSEC);
    expect(dto.seq).toBe(1);
  });

  it('the SSE id for an account event is a sealed cursor at that event, positioned at the event\'s own created_at', () => {
    const account = randomUUID();
    const r = row();
    const id = accountEventCursor(r, account, ENV);
    expect(openCursor(id, account, ENV)).toEqual({ accountId: account, serial: 987654321987n, issuedAtMs: r.createdAt.getTime() });
  });

  it('event names outside the safe charset fall back, so no input can smuggle a newline into an `event:` field', () => {
    expect(safeEventName('run.started')).toBe('run.started');
    expect(safeEventName('pr:opened-2_x')).toBe('pr:opened-2_x');
    for (const bad of ['a\nb', 'a b', '', 'x'.repeat(65), 'a\r\ndata: forged']) {
      expect(safeEventName(bad)).toBe('event');
    }
    expect(safeEventName('bad name', 'fallback')).toBe('fallback');
  });

  it('a frame is one id line, one event line, one single-line data line and a blank line; data with newlines cannot forge fields', () => {
    const out = frame({ id: 'abc', event: 'pr.opened', data: { text: 'line1\nid: forged\n\nevent: forged' } });
    expect(out.endsWith('\n\n')).toBe(true);
    const lines = out.slice(0, -2).split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('id: abc');
    expect(lines[1]).toBe('event: pr.opened');
    expect(lines[2]!.startsWith('data: ')).toBe(true);
    expect(JSON.parse(lines[2]!.slice(6))).toEqual({ text: 'line1\nid: forged\n\nevent: forged' });
    expect(frame({})).toBe('data: {}\n\n');
    expect(HEARTBEAT_FRAME).toBe(': heartbeat\n\n');
  });
});
