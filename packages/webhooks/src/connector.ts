import net from 'node:net';
import { request as httpsRequest } from 'node:https';
import type { HostLookup } from '@fx/net-guard';
import { validateWebhookUrlSyntax, resolveDeliveryAddresses, InvalidWebhookUrlError } from './ssrf.js';

/**
 * D#31 API-4b, criteria 1 and 2: a pinned-socket HTTPS client. Structurally
 * identical to `../sweep.js`'s `SendOutcome` (API-4a) -- kept as this
 * module's own type rather than importing that one, so `connector.ts` has
 * no dependency on the sweep at all; `dispatcher.ts` is the only file that
 * bridges the two.
 */
export type ConnectorOutcome =
  | { ok: true; statusCode: number }
  | { ok: false; statusCode?: number; errorClass: string };

export interface DeliverRequest {
  /** The endpoint's stored URL. Re-validated here (defense in depth --
   * criterion 1's checks are cheap and synchronous) even though every
   * caller has already validated it once, at registration. */
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  /**
   * Criterion 11: "a TLS receiver on 127.0.0.1 reached through a
   * test-only resolver override, which is refused when
   * NODE_ENV=production." Providing `lookup` does two things at once,
   * BOTH gated on the same production check below:
   *   1. it answers the DNS query directly, with no real lookup;
   *   2. it also SKIPS `resolveDeliveryAddresses`'s own blocked-range
   *      check on the result -- the only way a real e2e test can ever
   *      reach a loopback receiver, which criterion 2's checks
   *      otherwise correctly refuse.
   * Nothing in production code ever constructs this value; only test
   * code does. `ssrf.test.ts`'s own criterion-2 coverage calls
   * `resolveDeliveryAddresses` directly instead (an injectable DNS
   * answer that IS still checked), so the two test concerns stay
   * separate: "does the blocklist work" vs. "can the plumbing reach a
   * real socket at all."
   */
  lookup?: HostLookup;
}

/** Criterion 2: "10 s" / "at most 64 KB is read". */
export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * Sends one webhook delivery. Never throws -- every failure mode (a
 * blocked/unresolvable host, a timeout, a non-2xx status, a connection
 * error) resolves to `{ok: false, errorClass}` instead, because the only
 * caller that matters (`dispatcher.ts`'s `DeliverySender.send`, called
 * from `../sweep.js`'s `Promise.all`-driven worker loop with no
 * try/catch of its own) would otherwise take down the whole sweep batch
 * on one bad delivery.
 *
 * Pinning (criterion 2's "connects only to the validated IP"):
 * `resolveDeliveryAddresses` is called exactly once, and its first
 * returned address is handed to `https.request`'s own `lookup` option,
 * which the underlying connection uses INSTEAD of a fresh DNS query --
 * closing the TOCTOU window a second resolve immediately before connect
 * would reopen (the address DNS answers with right now might differ from
 * what it just answered).
 */
export async function deliver(req: DeliverRequest): Promise<ConnectorOutcome> {
  // Allowlist, not a denylist (D#31 fix round 2, SHOULD 3): the bypass
  // that skips SSRF pinning works ONLY when NODE_ENV is exactly "test".
  // The prior check refused only the literal string "production", so
  // "staging", unset, or any typo'd value sailed straight through with no
  // blocked-range check at all -- fail-closed means an unrecognized
  // environment is refused, not allowed by default.
  if (req.lookup && process.env.NODE_ENV !== 'test') {
    return { ok: false, errorClass: 'test_override_refused' };
  }

  let url: URL;
  if (req.lookup) {
    // Test-only bypass: a real e2e receiver runs on a dynamic local port
    // it picks itself (127.0.0.1:<ephemeral>), which criterion 1's
    // port === 443 rule would otherwise reject outright. Only the scheme
    // is still enforced -- Standard Webhooks delivery is HTTPS-only
    // regardless of how the test wired its receiver.
    try {
      url = new URL(req.url);
    } catch {
      return { ok: false, errorClass: 'invalid_url' };
    }
    if (url.protocol !== 'https:') {
      return { ok: false, errorClass: 'scheme' };
    }
  } else {
    try {
      url = validateWebhookUrlSyntax(req.url);
    } catch (err) {
      return { ok: false, errorClass: err instanceof InvalidWebhookUrlError ? err.reasonClass : 'invalid_url' };
    }
  }

  let addresses: string[];
  if (req.lookup) {
    // Test-only bypass (see DeliverRequest.lookup's doc comment) --
    // unreachable in production, guarded above.
    try {
      const results = await req.lookup(url.hostname, { all: true, verbatim: true });
      addresses = results.map((r) => r.address);
      if (addresses.length === 0) {
        return { ok: false, errorClass: 'dns_failed' };
      }
    } catch {
      return { ok: false, errorClass: 'dns_failed' };
    }
  } else {
    try {
      addresses = await resolveDeliveryAddresses(url.hostname);
    } catch (err) {
      return { ok: false, errorClass: err instanceof InvalidWebhookUrlError ? err.reasonClass : 'dns_failed' };
    }
  }
  const pinnedAddress = addresses[0];
  if (!pinnedAddress) {
    return { ok: false, errorClass: 'dns_failed' };
  }

  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = req.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  return new Promise<ConnectorOutcome>((resolve) => {
    let settled = false;
    let sizeExceeded = false;
    const settle = (outcome: ConnectorOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(hardDeadline);
      resolve(outcome);
    };

    // Bug fix (D#31 fix round 2, MUST 1): an absolute deadline independent
    // of any per-event handler. `res.destroy()` below (the 64 KB cap) only
    // fires 'aborted'/'close' on the response, never 'end'/'error' -- and a
    // receiver that keeps the connection open without ever going idle
    // never trips the `timeout` socket option's activity-reset timer
    // either. Confirmed live: without this, a hostile receiver that
    // streams past the cap and never closes its side wedges the promise
    // forever, well past `timeoutMs`. This timer fires exactly once
    // regardless of what else happens on the socket, always destroys, and
    // always settles -- the one guarantee "at most timeoutMs" actually
    // needs.
    const hardDeadline = setTimeout(() => {
      request.destroy();
      settle({ ok: false, errorClass: 'timeout' });
    }, timeoutMs);

    const request = httpsRequest(
      {
        // `hostname` (not the pinned IP) drives SNI and TLS certificate
        // hostname verification -- the pin below only overrides which
        // address the TCP socket actually connects to.
        hostname: url.hostname,
        // Real endpoints are always port 443 (criterion 1 rejects any
        // other explicit port at registration) -- the test-only path
        // honours whatever port the receiver actually bound.
        port: url.port ? Number(url.port) : 443,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: { ...req.headers, Host: url.hostname },
        timeout: timeoutMs,
        // Test-only receivers (127.0.0.1, `req.lookup` set) use a
        // self-signed certificate; a real endpoint's certificate is
        // always verified (default `rejectUnauthorized: true`).
        rejectUnauthorized: !req.lookup,
        // `net.connect`'s Happy Eyeballs path (`autoSelectFamily`,
        // default since Node 20) calls this with `{all: true}` and
        // expects `(err, addresses[])` back -- the older bare
        // `(err, address, family)` triple is only used without that
        // option. Both shapes are handled here so pinning works
        // whichever path Node takes (confirmed live: without this,
        // Node throws `ERR_INVALID_IP_ADDRESS: Invalid IP address:
        // undefined` from `lookupAndConnectMultiple`).
        lookup: (
          _hostname: string,
          options: { all?: boolean },
          callback: ((err: Error | null, address: string, family: number) => void) &
            ((err: Error | null, addresses: { address: string; family: number }[]) => void),
        ) => {
          const family = net.isIPv6(pinnedAddress) ? 6 : 4;
          if (options?.all) {
            callback(null, [{ address: pinnedAddress, family }]);
          } else {
            callback(null, pinnedAddress, family);
          }
        },
      },
      (res) => {
        let received = 0;
        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          // Criterion 2: "from a 1 MB body, at most 64 KB is read." No
          // response body is ever stored (0627_webhooks.sql has no
          // response-body column) -- this only guards against buffering
          // an oversized response for nothing.
          if (received > maxResponseBytes) {
            sizeExceeded = true;
            res.destroy();
          }
        });
        res.on('end', () => {
          const statusCode = res.statusCode ?? 0;
          if (statusCode >= 200 && statusCode < 300) {
            settle({ ok: true, statusCode });
          } else {
            // Criterion 2: "a 302 ... fails as http_status, with no
            // second request" -- Node's plain https client never follows
            // a redirect on its own, so a 3xx (or any other non-2xx)
            // simply lands here.
            settle({ ok: false, statusCode, errorClass: 'http_status' });
          }
        });
        res.on('error', () => settle({ ok: false, errorClass: 'connection_error' }));
        // Bug fix (MUST 1): `res.destroy()` (the size-cap branch above)
        // fires 'aborted' and 'close' on the response -- NEITHER of which
        // is 'end' or 'error' -- so without these two handlers a
        // destroyed-for-size response never settles the promise at all.
        // Confirmed live against a real HTTPS receiver that streams past
        // the cap and never ends: the promise hung indefinitely on the
        // pre-fix code, well past `timeoutMs`. `close` always fires after
        // `aborted` for a destroyed response, so `settle`'s own
        // already-settled guard is what keeps this from double-reporting,
        // not ordering.
        res.on('aborted', () => {
          settle({ ok: false, errorClass: sizeExceeded ? 'response_too_large' : 'connection_error' });
        });
        res.on('close', () => {
          settle({ ok: false, errorClass: sizeExceeded ? 'response_too_large' : 'connection_error' });
        });
      },
    );

    request.on('timeout', () => {
      request.destroy();
      settle({ ok: false, errorClass: 'timeout' });
    });
    request.on('error', () => settle({ ok: false, errorClass: 'connection_error' }));
    // Mirrors the response-level 'close' handler above for the case where
    // the request itself is destroyed (e.g. the hard deadline below) before
    // a response ever arrives.
    request.on('close', () => settle({ ok: false, errorClass: 'connection_error' }));

    request.write(req.body);
    request.end();
  });
}
