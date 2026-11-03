/** D#597 CC-7a-1: the runner's half of the CC-4 device flow. `expired` and 409 store nothing and exit non-zero with the next step. */
import { errorCodeOf } from "../cloud.js";
import { assistantCall } from "./cloudCall.js";
import { AssistantError, writeAssistantToken, type StoredToken } from "./tokenFile.js";

export interface LinkOptions {
  origin: string;
  clientId: string;
  stateDir: string;
  uid: number | undefined;
  fetchFn: typeof fetch;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  out: (line: string) => void;
  bypass?: string | undefined;
}

const LINK_CEILING_MS = 15 * 60_000;
const isText = (v: unknown): v is string => typeof v === "string" && v !== "";

export async function runLink(o: LinkOptions): Promise<void> {
  const base = { fetchFn: o.fetchFn, origin: o.origin, bypass: o.bypass, method: "POST" as const };
  const start = await assistantCall({ ...base, path: "/api/v1/assistant/link", body: { client_id: o.clientId } });
  const s = start.body as { device_code?: unknown; user_code?: unknown; expires_at?: unknown; interval_seconds?: unknown } | undefined;
  if (start.status !== 201 || !isText(s?.device_code) || !isText(s?.user_code) || !isText(s?.expires_at) || typeof s?.interval_seconds !== "number") {
    throw new AssistantError("assistant_link_failed", `the cloud refused to start a link (${start.status}${errorCodeOf(start.body) ? ` ${errorCodeOf(start.body)}` : ""})`);
  }
  // The code's own expiry, but never later than the local ceiling, so a bad `expires_at` cannot make the poll unbounded.
  const deadline = Math.min(Date.parse(s.expires_at), o.now().getTime() + LINK_CEILING_MS);
  const wait = Math.min(30, Math.max(1, s.interval_seconds)) * 1000;
  o.out(`Link code: ${s.user_code}`);
  o.out(`Approve it in your workspace at ${o.origin} while signed in, choosing the repo this assistant may work on. The code lasts until ${s.expires_at}.`);
  for (;;) {
    if (Number.isNaN(deadline) || o.now().getTime() >= deadline) throw new AssistantError("assistant_link_expired");
    await o.sleep(wait);
    const poll = await assistantCall({ ...base, path: "/api/v1/assistant/link/poll", body: { device_code: s.device_code } });
    if (poll.status === 409 && errorCodeOf(poll.body) === "link_already_redeemed") {
      throw new AssistantError("assistant_link_failed", "this code was already redeemed and nothing was stored; run: fx-runner assistant link again");
    }
    if (poll.status === 429) continue;
    if (poll.status !== 200) throw new AssistantError("assistant_link_failed", `the cloud refused the poll (${poll.status}${errorCodeOf(poll.body) ? ` ${errorCodeOf(poll.body)}` : ""})`);
    const p = poll.body as { status?: unknown; token?: Record<string, unknown> } | undefined;
    if (p?.status === "pending") continue;
    if (p?.status === "expired") throw new AssistantError("assistant_link_expired");
    const t = p?.token;
    if (p?.status !== "approved" || t === undefined || !isText(t.token) || !isText(t.token_id) || !isText(t.expires_at) || !isText(t.repo_id) || t.client_id !== o.clientId) {
      throw new AssistantError("assistant_link_failed");
    }
    const stored: StoredToken = { token: t.token, token_id: String(t.token_id), expires_at: t.expires_at, repo_id: t.repo_id, client_id: o.clientId, origin: o.origin };
    writeAssistantToken(o.stateDir, o.uid, stored);
    o.out("Linked. The assistant token is stored on this machine and expires in about an hour; run this command again after that.");
    return;
  }
}
