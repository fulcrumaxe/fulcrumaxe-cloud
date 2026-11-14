/**
 * D#749 V2c-2a: what the page actually showed the model, kept as the server returned it (cleaned and cut, before the fence), one log per journey. The answer is
 * checked against the journey's own log, so a fact the model quotes has to be page text the server really handed over while that journey was being checked.
 */
/**
 * The browser-call budget grows with the journeys the job holds: 30 calls for each, never under 90 and never over 600. The 30-minute `MAX_JOB_MS` stays the hard bound. The server
 * learns each journey when its `begin_journey` call arrives, so the budget is worked out from the distinct journeys begun so far.
 */
export const CALLS_PER_JOURNEY = 30;
export const MIN_CALLS = 150; // a 3-journey check ran out of calls at 90
export const MAX_CALLS = 600;
export function callBudget(journeys: number): number {
  return Math.min(MAX_CALLS, Math.max(MIN_CALLS, journeys * CALLS_PER_JOURNEY));
}
export const MAX_JOB_MS = 30 * 60 * 1000;
export const MAX_CONSOLE_KEPT = 5;

const NUMBER_TOKEN = /-?\d[\d,]*(?:\.\d+)?/g;

/** Case-folded text with one space between words: how a quoted fact is compared with the log. */
export function norm(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Every number written in a text, as a number (`1,204.5` is 1204.5). */
export function numbersIn(text: string): number[] {
  return [...text.matchAll(NUMBER_TOKEN)].map((m) => Number(m[0].replace(/,/g, ""))).filter((n) => Number.isFinite(n));
}

interface Scope {
  seen: string[];
  nums: Set<number>;
}

export class Trace {
  private readonly scopes = new Map<string, Scope>();
  private current: Scope | undefined;
  private calls = 0;
  readonly consoleLines: string[] = [];
  consoleErrors = 0;

  constructor(private readonly startedAt: number) {}

  /** Starts a journey's log, or switches back to one already started. Facts are checked against that journey's log only. */
  begin(id: string): void {
    let scope = this.scopes.get(id);
    if (scope === undefined) {
      scope = { seen: [], nums: new Set() };
      this.scopes.set(id, scope);
    }
    this.current = scope;
  }
  started(): boolean {
    return this.current !== undefined;
  }
  /**
   * Records page content the model was shown, in the current journey's log. Only what the page held goes here: never a tool's input (a path, a wait text), never our
   * own status words or labels, or the model could write its own evidence by asking for it.
   */
  observe(text: string): void {
    if (this.current === undefined) return;
    this.current.seen.push(norm(text));
    for (const n of numbersIn(text)) this.current.nums.add(n);
  }
  sawFact(journey: string, fact: string): boolean {
    const f = norm(fact);
    return f !== "" && (this.scopes.get(journey)?.seen.some((s) => s.includes(f)) ?? false);
  }
  sawNumber(journey: string, n: number): boolean {
    return this.scopes.get(journey)?.nums.has(n) ?? false;
  }
  /** Counts a browser call; false once the budget of calls (which grows with the journeys begun) is used. */
  takeCall(): boolean {
    this.calls += 1;
    return this.calls <= callBudget(this.scopes.size);
  }
  expired(now: number): boolean {
    return now - this.startedAt > MAX_JOB_MS;
  }
  console(type: string, text: string): void {
    if (type === "error") this.consoleErrors += 1;
    if (this.consoleLines.length < MAX_CONSOLE_KEPT) this.consoleLines.push(`${type}: ${text.slice(0, 200)}`);
  }
}
