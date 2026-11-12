import { describe, expect, it } from 'vitest';
import { raiseLimitFromLabel, raiseLimitLabel } from '../src/decisions/envelopeRaise.js';

describe('the raise figure on the ask option', () => {
  it('round-trips: the figure the label shows is the figure read back', () => {
    for (const usd of [0.01, 0.3, 0.7, 1, 12.34, 999.99, 100000.3]) expect(raiseLimitFromLabel(raiseLimitLabel(usd))).toBe(Math.ceil(usd * 100 - 1e-9) / 100);
  });
  it('rounds up to the cent in the label', () => {
    expect(raiseLimitLabel(0.701)).toBe('Raise the limit to $0.71');
  });
  it('reads nothing from a label that is not exactly the one we write', () => {
    for (const bad of ['', 'Raise the limit to $0.70 and more', 'xx Raise the limit to $0.70', 'Raise the limit to $0.7', 'Raise the limit to $0.00', 'Raise the limit to $-1.00', 'Stop this item', 'Raise the limit to $1.00\nRaise the limit to $9.00'])
      expect(raiseLimitFromLabel(bad), bad).toBeNull();
  });
});
