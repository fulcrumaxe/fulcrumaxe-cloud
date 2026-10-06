import { reportError, safeTagPart } from "@fx/telemetry";

/**
 * Diagnostics for the swallowed repo-sync failure. The warning must never carry
 * a token, a repo or owner name or an id, so it reports only: the stage that
 * failed (set by `atStage`), the error's class name, a short code and an HTTP
 * status. Each part is kept only when it matches a narrow charset.
 */

// The charset rule and the secret-shape refusal live in @fx/telemetry (safeTagPart), shared with the error reporter.
const safe = safeTagPart;

/**
 * The upstream API's own error messages can name a repository or an owner, so a
 * message is never echoed. It is reported only when it starts with one of these
 * known fixed phrases, and then only the phrase itself is emitted.
 */
const KNOWN_UPSTREAM_MESSAGES: readonly string[] = [
  "bad credentials",
  "not found",
  "request forbidden by administrative rules",
  "a json web token could not be decoded",
  "the permissions requested are not granted to this installation",
  "resource not accessible by integration",
  "this installation has been suspended",
  "there is at least one repository that does not exist or is not accessible to the parent installation",
];

function knownUpstreamMessage(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const text = raw.toLowerCase().replace(/[^a-z ]/g, "").trim();
  return KNOWN_UPSTREAM_MESSAGES.find((m) => text === m || text.startsWith(`${m} `));
}

type Tagged = { fxStage?: unknown; name?: unknown; code?: unknown; status?: unknown; reason?: unknown; cause?: unknown };

function parts(err: unknown): string[] {
  const e = (err && typeof err === "object" ? err : {}) as Tagged;
  const status = typeof e.status === "number" && Number.isInteger(e.status) && e.status >= 100 && e.status <= 599 ? String(e.status) : undefined;
  return [safe(e.name), safe(e.reason), safe(e.code), status].filter((p): p is string => Boolean(p));
}

export function syncFailureTag(err: unknown): string {
  const e = (err && typeof err === "object" ? err : {}) as Tagged;
  const out = [safe(e.fxStage) ?? "unknown_stage", ...parts(err)];
  // One level of cause (e.g. the requester failure behind a mint_failed), same narrow charset.
  if (e.cause !== undefined) {
    out.push("cause:", ...parts(e.cause));
    const known = knownUpstreamMessage((e.cause as { ghMessage?: unknown } | null)?.ghMessage);
    if (known) out.push(`github: "${known}"`);
  }
  return out.join(" ");
}

/** Marks a rejection with the stage it came from (first stage wins), then rethrows it unchanged. */
export async function atStage<T>(stage: string, work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (err) {
    if (err && typeof err === "object" && !("fxStage" in err)) {
      try {
        Object.defineProperty(err, "fxStage", { value: stage, enumerable: false });
      } catch {
        // fx-swallow-ok: a frozen error keeps no stage; the tag then says unknown_stage
      }
    }
    throw err;
  }
}

/**
 * The same failure through the shared reporter: one coded line (stage, route template, error class, code) and
 * one stored error class, with nothing from the message. The stage is the one `atStage` marked; the code is the
 * error's own `code`, else its `reason` (InstallationTokenError carries `mint_failed` there). Both pass the
 * reporter's allowlist, so an upstream word becomes `other`.
 */
export function reportSyncFailure(err: unknown, route: string): void {
  const e = (err && typeof err === "object" ? err : {}) as Tagged;
  reportError(err, { stage: typeof e.fxStage === "string" ? e.fxStage : "unknown", route, code: (e.code ?? e.reason) as string | undefined });
}
