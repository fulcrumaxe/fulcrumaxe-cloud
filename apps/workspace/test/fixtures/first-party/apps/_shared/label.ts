// A shared first-party library (an "_"-prefixed directory): no manifest, and
// it ships only because an app's import graph reaches it.
export function label(n: number): string {
  return `Clicks: ${n}`;
}
