import { afterEach, describe, expect, it, vi } from 'vitest';
import { deliver } from '../src/connector.js';
import { startTlsReceiver, type TlsReceiver } from './helpers/tlsReceiver.js';

/**
 * D#31 fix round 2, MUST 2: real tests for connector.ts against a live
 * local HTTPS receiver -- none of connector.ts's own behaviour was
 * exercised by any test in the original PR (only `ssrf.ts`, `sign.ts` and
 * `payload.ts` had coverage). MUST 1's own regression test (the hostile
 * receiver that streams past the cap and never ends) lives here too.
 */
describe('connector: deliver()', () => {
  let receiver: TlsReceiver | undefined;

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (receiver) {
      await receiver.close();
      receiver = undefined;
    }
  });

  it('delivers successfully to a 2xx endpoint, using the pinned lookup exactly once', async () => {
    receiver = await startTlsReceiver((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    const lookupSpy = vi.fn(receiver.lookup);

    const result = await deliver({
      url: `https://127.0.0.1:${receiver.port}/deliveries`,
      headers: { 'content-type': 'application/json' },
      body: '{}',
      lookup: lookupSpy,
    });

    expect(result).toEqual({ ok: true, statusCode: 200 });
    // Pinned: resolved once, not re-resolved per connection attempt.
    expect(lookupSpy).toHaveBeenCalledTimes(1);
    expect(receiver.requestCount()).toBe(1);
  });

  it('does not follow a redirect -- a 302 fails as http_status with no second request', async () => {
    receiver = await startTlsReceiver((_req, res) => {
      res.writeHead(302, { Location: 'https://example.invalid/elsewhere' });
      res.end();
    });

    const result = await deliver({
      url: `https://127.0.0.1:${receiver.port}/deliveries`,
      headers: {},
      body: '{}',
      lookup: receiver.lookup,
    });

    expect(result).toEqual({ ok: false, statusCode: 302, errorClass: 'http_status' });
    expect(receiver.requestCount()).toBe(1);
  });

  it(
    'MUST 1 regression: a receiver that streams past the 64 KB cap and never ends settles as response_too_large well before timeoutMs',
    async () => {
      let interval: NodeJS.Timeout | undefined;
      receiver = await startTlsReceiver((_req, res) => {
        res.writeHead(200);
        interval = setInterval(() => {
          // A hostile/broken receiver: keeps writing forever, never calls
          // res.end(). Pre-fix, `deliver()`'s only handlers were
          // 'end'/'error' -- `res.destroy()` on the cap fires neither, so
          // this hung the promise past `timeoutMs` every time (confirmed
          // by temporarily reverting the connector.ts fix and re-running
          // this exact test: it timed out against vitest's own 20s test
          // timeout instead of resolving).
          if (!res.destroyed) res.write(Buffer.alloc(8 * 1024, 'x'));
        }, 5);
        res.on('close', () => clearInterval(interval));
      });

      const maxResponseBytes = 4 * 1024;
      const timeoutMs = 5_000;
      const startedAt = Date.now();

      const result = await deliver({
        url: `https://127.0.0.1:${receiver.port}/deliveries`,
        headers: {},
        body: '{}',
        lookup: receiver.lookup,
        maxResponseBytes,
        timeoutMs,
      });

      const elapsedMs = Date.now() - startedAt;

      expect(result).toEqual({ ok: false, errorClass: 'response_too_large' });
      // The fix settles as soon as the destroyed response's 'aborted'/'close'
      // fires -- essentially as fast as the cap is exceeded (a handful of
      // the 5ms ticks above) -- not by waiting out the hard deadline.
      expect(elapsedMs).toBeLessThan(timeoutMs / 2);

      clearInterval(interval);
    },
    10_000,
  );

  it(
    'hard deadline: settles as timeout when the receiver accepts the connection but never sends a response',
    async () => {
      receiver = await startTlsReceiver(() => {
        // Never call res.write/res.end -- the connection just sits open.
      });

      const timeoutMs = 400;
      const startedAt = Date.now();

      const result = await deliver({
        url: `https://127.0.0.1:${receiver.port}/deliveries`,
        headers: {},
        body: '{}',
        lookup: receiver.lookup,
        timeoutMs,
      });

      const elapsedMs = Date.now() - startedAt;

      expect(result).toEqual({ ok: false, errorClass: 'timeout' });
      // Roughly timeoutMs, not instant and not indefinite -- generous
      // bounds for a loaded CI box.
      expect(elapsedMs).toBeGreaterThanOrEqual(timeoutMs * 0.5);
      expect(elapsedMs).toBeLessThan(timeoutMs + 5_000);
    },
    10_000,
  );

  describe('SHOULD 3: the lookup bypass is an allowlist on NODE_ENV === "test"', () => {
    it.each(['production', 'staging', ''])('is refused when NODE_ENV=%j', async (nodeEnv) => {
      if (nodeEnv === '') {
        vi.stubEnv('NODE_ENV', undefined as unknown as string);
        delete process.env.NODE_ENV;
      } else {
        vi.stubEnv('NODE_ENV', nodeEnv);
      }

      const result = await deliver({
        url: 'https://127.0.0.1:1/deliveries',
        headers: {},
        body: '{}',
        lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      });

      expect(result).toEqual({ ok: false, errorClass: 'test_override_refused' });
    });

    it('is allowed when NODE_ENV=test', async () => {
      vi.stubEnv('NODE_ENV', 'test');
      receiver = await startTlsReceiver((_req, res) => {
        res.writeHead(200);
        res.end();
      });

      const result = await deliver({
        url: `https://127.0.0.1:${receiver.port}/deliveries`,
        headers: {},
        body: '{}',
        lookup: receiver.lookup,
      });

      expect(result).toEqual({ ok: true, statusCode: 200 });
    });
  });
});
