import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * D#454 H3c: the api-sweep kick. With the sweep cron at five minutes, a freshly enqueued event would wait for the
 * next tick; the process that enqueued it sends this signed request to the sweep route instead, so the first delivery
 * still goes out within seconds. The kick only speeds a delivery up: the `domain_events` / `webhook_deliveries` rows
 * are the durable signal, and a lost kick leaves them to the next tick.
 *
 * Same shape as the run-action kick (HMAC-SHA256 over `<t>.<body>`, 60 s skew), with two differences. The body is
 * fixed, so a signature made for a run-action kick (whose body names an action id) never verifies here. And the key
 * is DERIVED from CRON_SECRET (`apiSweepKickKey`), not the run-action kick secret, which stays readable by exactly
 * two source files (packages/pipeline/test/runActions.test.ts pins that); CRON_SECRET itself never leaves the
 * process, only signatures made with the derived key do. The signature is the only authentication on a POST; a bad or
 * stale one is a bare 401.
 */
export const API_SWEEP_KICK_HEADER = 'x-fx-kick';
export const API_SWEEP_KICK_BODY = '{"kick":"api-sweep"}';
export const API_SWEEP_KICK_PATH = '/api/cron/api-sweep';
export const KICK_MAX_SKEW_SECONDS = 60;
/** Wait before sending, so the enqueuing transaction has committed by the time the sweep reads. */
export const KICK_DELAY_MS = 1500;
/** At most one kick per process in this window. */
export const KICK_COOLDOWN_MS = 5000;
const KICK_TIMEOUT_MS = 5000;
const HEADER_RE = /^t=(\d{1,12}),sig=([0-9a-f]{64})$/;

/** The signing key for the kick, derived from the cron secret so the two uses of that secret cannot be swapped. Empty in, empty out (fails closed). */
export function apiSweepKickKey(cronSecret: string): string {
  return cronSecret ? createHmac('sha256', cronSecret).update('fx:api-sweep-kick:v1').digest('hex') : '';
}

function sign(secret: string, timestamp: number): string {
  return createHmac('sha256', secret).update(`${timestamp}.${API_SWEEP_KICK_BODY}`).digest('hex');
}

export function apiSweepKickHeader(secret: string, timestamp: number): string {
  return `t=${timestamp},sig=${sign(secret, timestamp)}`;
}

/** True only for the fixed body with a well-formed, matching, fresh signature. Constant-time compare. */
export function verifyApiSweepKick(header: string | null, body: string, secret: string, nowSeconds: number): boolean {
  if (!secret || !header || body !== API_SWEEP_KICK_BODY) return false;
  const m = HEADER_RE.exec(header);
  if (!m) return false;
  const timestamp = Number(m[1]);
  const signatureOk = timingSafeEqual(Buffer.from(sign(secret, timestamp), 'hex'), Buffer.from(m[2]!, 'hex'));
  return signatureOk && Math.abs(nowSeconds - timestamp) <= KICK_MAX_SKEW_SECONDS;
}

export interface ApiSweepKickerOptions {
  /** The sweep route's full URL, https. */
  url: string;
  /** The derived key (`apiSweepKickKey`), not the cron secret. */
  secret: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Called with a failed send (dropped, refused, slow). Must not throw. */
  reportError?: (err: unknown, stage: string) => void;
}

/** Sends at most one kick per cooldown. Resolves when the attempt is over; never rejects, never throws. */
export function createApiSweepKicker(options: ApiSweepKickerOptions): { kick(): Promise<void> } {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  let lastSentAt = -Infinity;
  return {
    async kick(): Promise<void> {
      if (now() - lastSentAt < KICK_COOLDOWN_MS) return;
      lastSentAt = now();
      try {
        await sleep(KICK_DELAY_MS);
        const response = await fetchImpl(options.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [API_SWEEP_KICK_HEADER]: apiSweepKickHeader(options.secret, Math.floor(now() / 1000)) },
          body: API_SWEEP_KICK_BODY,
          redirect: 'error',
          signal: AbortSignal.timeout(KICK_TIMEOUT_MS),
        });
        await response.body?.cancel();
      } catch (err) {
        // Dropped, refused or slow: the next tick sends the delivery. Worth seeing, though.
        options.reportError?.(err, "api_sweep_kick.send");
      }
    },
  };
}

/** The kicker from the environment, or null unless the run-action kick URL (https) and the cron secret are both set. The route is on the same origin. */
export function apiSweepKickerFromEnv(
  env: Record<string, string | undefined> = process.env,
  reportError?: ApiSweepKickerOptions["reportError"],
): { kick(): Promise<void> } | null {
  const base = env.RUN_ACTION_KICK_URL;
  const cronSecret = env.CRON_SECRET;
  if (!base || !cronSecret) return null;
  try {
    const url = new URL(API_SWEEP_KICK_PATH, base);
    if (url.protocol !== 'https:') return null;
    return createApiSweepKicker({ url: url.toString(), secret: apiSweepKickKey(cronSecret), ...(reportError ? { reportError } : {}) });
  } catch (err) {
    // A malformed URL is a setting mistake: no kick, and the tick covers it.
    reportError?.(err, "api_sweep_kick.config");
    return null;
  }
}
