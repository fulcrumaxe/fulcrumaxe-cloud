import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { planDataSchema } from '../src/schema.js';

const text = (name: string): string => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

describe('scaled fixture', () => {
  it('is a valid, marked fixture with its own figures (not the small fixture and not production data)', () => {
    const scaled = planDataSchema.parse(JSON.parse(text('plan-data.scaled.fixture.json')));
    const small = planDataSchema.parse(JSON.parse(text('plan-data.fixture.json')));
    expect(scaled.fixture).toBe(true);
    expect(scaled).not.toEqual(small);
    expect(scaled.pricing.openai['gpt-5.3-codex'].sourceUrl).toContain('.invalid');
  });
});
