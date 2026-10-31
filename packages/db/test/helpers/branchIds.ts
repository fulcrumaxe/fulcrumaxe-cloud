import { randomUUID } from 'node:crypto';

/**
 * A random uuid whose first group always contains a letter (its first character is `a` to `f`).
 *
 * A plain v4 uuid whose first group is all decimal digits with a non-zero lead (about 2 in 100) also fits the item branch shape
 * `fx/<n>-<slug>`, so `fx/<uuid>-g1` is then a legitimate item branch and a test that expects it to be refused (or to map to
 * nothing) flakes. Use this for every run id that is spliced into an `fx/…` branch a test must see refused.
 */
export function nonChildUuid(): string {
  const id = randomUUID();
  return `${'abcdef'[Math.floor(Math.random() * 6)]}${id.slice(1)}`;
}
