/**
 * Pure rules for the shell pack (rows W1 and W2), written out here on purpose and not imported from apps/workspace.
 * Nothing here reads a page; the spec feeds it what the page showed.
 */

/** The apps an account without a subscription may still open while onboarding (the shell's onboarding mode). */
export const ONBOARDING_APPS: readonly string[] = ["onboarding", "model-key", "repos", "themes"];

export type PageEventKind = "console-error" | "page-error" | "bad-status" | "failed-request" | "csp-violation";

export interface PageEvent {
  kind: PageEventKind;
  detail: string;
}

/** A URL with its query and fragment removed: enough to tell requests apart, never a token or a code. */
export function labelUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "(unparsable url)";
  }
}

/** Replaces every URL in a message with its label (origin and path), so a query string or fragment never reaches a report. */
export function maskUrls(text: string): string {
  return text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]+/gi, (u) => labelUrl(u));
}

/** Masks URLs, then keeps a browser message short and on one line, so a long console line cannot flood or leak into the report. */
export function clip(text: string, max = 160): string {
  const one = maskUrls(text).replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}...` : one;
}

/** A response is a problem when it is on the target origin and is a 4xx or 5xx. */
export function badStatusEvent(status: number, method: string, url: string, origin: string): PageEvent | null {
  if (status < 400) return null;
  try {
    if (new URL(url).origin !== new URL(origin).origin) return null;
  } catch {
    return null;
  }
  return { kind: "bad-status", detail: `${status} ${method} ${labelUrl(url)}` };
}

/** Lines for a failure message: one per event, in the order seen. Empty when the page was clean. */
export function problemLines(events: readonly PageEvent[]): string[] {
  return events.map((e) => `${e.kind}: ${e.detail}`);
}

export interface ScreenFacts {
  /** `#subscription-gate-screen` is showing. */
  gate: boolean;
  /** `window.currentStep` reached DESKTOP. */
  desktop: boolean;
  /** The `data-app-id` of every dock icon. */
  dockApps: readonly string[];
}

/**
 * W2. What an account must see for each workspace access value. A subscribed (`open`) account gets the desktop and
 * never the gate. An account with no subscription gets the gate, or the desktop narrowed to the onboarding apps (the
 * shell's onboarding mode); never the full desktop. An ended subscription gets the gate only.
 */
export function accessViolations(access: string, facts: ScreenFacts): string[] {
  const out: string[] = [];
  if (access === "open") {
    if (facts.gate) out.push("the subscription gate showed on an open workspace");
    if (!facts.desktop) out.push("the desktop did not come up on an open workspace");
    return out;
  }
  if (access === "no_subscription") {
    if (facts.gate === facts.desktop) out.push(facts.gate ? "both the gate and the desktop showed" : "neither the gate nor the desktop showed");
    if (facts.desktop) {
      if (facts.dockApps.length === 0) out.push("the onboarding desktop has no dock icon");
      const extra = facts.dockApps.filter((a) => !ONBOARDING_APPS.includes(a));
      if (extra.length > 0) out.push(`the dock holds apps outside onboarding: ${extra.join(", ")}`);
    }
    return out;
  }
  if (access === "subscription_ended") {
    if (!facts.gate) out.push("the gate did not show after the subscription ended");
    if (facts.desktop) out.push("the desktop came up after the subscription ended");
    return out;
  }
  return [`workspace_access ${access} is not a documented value`];
}
