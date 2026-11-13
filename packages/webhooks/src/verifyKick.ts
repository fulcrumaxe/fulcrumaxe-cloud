import { createHmac, timingSafeEqual } from 'node:crypto';
import { BYPASS_HEADER, bypassSecretFor, reportRefusedKick } from './ownHostBypass.js';
import { KICK_COOLDOWN_MS, KICK_DELAY_MS, KICK_MAX_SKEW_SECONDS } from './kick.js';

/**
 * The proposal-verify sweep kick. The post-merge verify stage rides that sweep's 15-minute cron, and a pending marker only lets the NEXT tick connect, so a
 * "Verify again", a deploy-order report or a finished tester run used to wait for the clock. The process that has just written the row sends this signed
 * request to the sweep route instead, so the stage advances within seconds. Push, not poll: the cron and its backstop stay as the fallback, and the rows
 * stay the durable signal (a lost kick costs only the wait).
 *
 * Same shape as the api-sweep kick (kick.ts): HMAC-SHA256 over `<t>.<body>`, 60 s skew, a fixed body, a key DERIVED from CRON_SECRET (with its own label, so a
 * signature made for one sweep never verifies for the other). CRON_SECRET itself never leaves the process; only signatures made with the derived key do.
 * The signature is the only authentication on the POST; a bad or stale one is a bare 401.
 */
export const VERIFY_SWEEP_KICK_HEADER = 'x-fx-kick';
export const VERIFY_SWEEP_KICK_BODY = '{"kick":"proposal-verify-sweep"}';
export const VERIFY_SWEEP_KICK_PATH = '/api/cron/proposal-verify-sweep';
const KICK_TIMEOUT_MS = 5000;
const HEADER_RE = /^t=(\d{1,12}),sig=([0-9a-f]{64})$/;

/** The signing key, derived from the cron secret. Empty in, empty out (fails closed). */
export function verifySweepKickKey(cronSecret: string): string {
  return cronSecret ? createHmac('sha256', cronSecret).update('fx:proposal-verify-sweep-kick:v1').digest('hex') : '';
}

function sign(secret: string, timestamp: number): string {
  return createHmac('sha256', secret).update(`${timestamp}.${VERIFY_SWEEP_KICK_BODY}`).digest('hex');
}

export function verifySweepKickHeader(secret: string, timestamp: number): string {
  return `t=${timestamp},sig=${sign(secret, timestamp)}`;
}

/** True only for the fixed body with a well-formed, matching, fresh signature. Constant-time compare. */
export function verifyVerifySweepKick(header: string | null, body: string, secret: string, nowSeconds: number): boolean {
  if (!secret || !header || body !== VERIFY_SWEEP_KICK_BODY) return false;
  const m = HEADER_RE.exec(header);
  if (!m) return false;
  const timestamp = Number(m[1]);
  const signatureOk = timingSafeEqual(Buffer.from(sign(secret, timestamp), 'hex'), Buffer.from(m[2]!, 'hex'));
  return signatureOk && Math.abs(nowSeconds - timestamp) <= KICK_MAX_SKEW_SECONDS;
}

export interface VerifySweepKickerOptions {
  /** The sweep route's full URL, https. */
  url: string;
  /** The derived key (`verifySweepKickKey`), not the cron secret. */
  secret: string;
  /**
   * Vercel's automation bypass secret (the platform's own VERCEL_AUTOMATION_BYPASS_SECRET). A protected deployment answers an unsigned-in request with its own 401 at the
   * edge, before the function runs, so without this header the kick never reaches the sweep route. Sent as a header only (never in the URL, never a bypass cookie), and the
   * caller passes it only for this project's own host (ownHostBypass.ts).
   */
  bypassSecret?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Called with a failed send (dropped, refused, slow). Must not throw. */
  reportError?: (err: unknown, stage: string) => void;
}

/** Sends at most one kick per cooldown (the sweep reads every waiting row, so a second kick inside the window adds nothing). Never rejects, never throws. */
export function createVerifySweepKicker(options: VerifySweepKickerOptions): { kick(): Promise<void> } {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  let lastSentAt = -Infinity;
  return {
    async kick(): Promise<void> {
      if (now() - lastSentAt < KICK_COOLDOWN_MS) return;
      lastSentAt = now();
      try {
        // Wait before sending, so the writing transaction has committed by the time the sweep reads.
        await sleep(KICK_DELAY_MS);
        const response = await fetchImpl(options.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [VERIFY_SWEEP_KICK_HEADER]: verifySweepKickHeader(options.secret, Math.floor(now() / 1000)),
            ...(options.bypassSecret ? { [BYPASS_HEADER]: options.bypassSecret } : {}),
          },
          body: VERIFY_SWEEP_KICK_BODY,
          redirect: 'error',
          signal: AbortSignal.timeout(KICK_TIMEOUT_MS),
        });
        await response.body?.cancel();
        reportRefusedKick(response, 'verify_sweep_kick.refused', options.reportError);
      } catch (err) {
        // Dropped, refused or slow: the next tick picks the row up.
        options.reportError?.(err, 'verify_sweep_kick.send');
      }
    },
  };
}

/** The kicker from the environment, or null unless the run-action kick URL (https) and the cron secret are both set. The route is on the same origin. */
export function verifySweepKickerFromEnv(
  env: Record<string, string | undefined> = process.env,
  reportError?: VerifySweepKickerOptions['reportError'],
): { kick(): Promise<void> } | null {
  const base = env.RUN_ACTION_KICK_URL;
  const cronSecret = env.CRON_SECRET;
  if (!base || !cronSecret) return null;
  try {
    const url = new URL(VERIFY_SWEEP_KICK_PATH, base);
    if (url.protocol !== 'https:') return null;
    const bypassSecret = bypassSecretFor(url, env);
    return createVerifySweepKicker({
      url: url.toString(),
      secret: verifySweepKickKey(cronSecret),
      ...(bypassSecret ? { bypassSecret } : {}),
      ...(reportError ? { reportError } : {}),
    });
  } catch (err) {
    reportError?.(err, 'verify_sweep_kick.config');
    return null;
  }
}
