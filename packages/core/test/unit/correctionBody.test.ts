import { describe, expect, it } from 'vitest';
import { CorrectionInputError } from '../../src/corrections/index.js';
import { checkBody, parseNewItemBody, parsePriorityBody } from '../../src/corrections/body.js';

const KINDS = ['task', 'feature'];

describe('correction bodies refuse a repeated key (JSON.parse keeps the last one, so the text a person reads would not be the text applied)', () => {
  it('refuses a repeated top-level key in a new_item body, on write and on accept', () => {
    const body = '{"title":"Fix typo","kind":"task","body":"Small","body":"HOSTILE"}';
    expect(() => parseNewItemBody(body, KINDS)).toThrow(CorrectionInputError);
    expect(() => checkBody('new_item', body, KINDS)).toThrow(CorrectionInputError);
  });
  it('refuses a key repeated through an escape (\\u0062ody is body) and a repeated priority', () => {
    expect(() => parseNewItemBody('{"title":"t","kind":"task","body":"a","\\u0062ody":"b"}', KINDS)).toThrow(CorrectionInputError);
    expect(() => parsePriorityBody('{"priority":"low","priority":"urgent"}')).toThrow(CorrectionInputError);
  });
  it('does not mistake a repeated key inside a nested value or inside a string for a repeat', () => {
    expect(parseNewItemBody('{"title":"a","kind":"task","body":"{\\"body\\":1,\\"body\\":2} \\"body\\""}', KINDS).body).toContain('body');
    expect(parsePriorityBody(' {"priority" : "high"} ')).toEqual({ priority: 'high' });
  });
  it('still accepts a well-formed body', () => {
    expect(parseNewItemBody('{"title":"Fix typo","kind":"task","body":"Small"}', KINDS)).toEqual({ title: 'Fix typo', kind: 'task', body: 'Small' });
  });
});
