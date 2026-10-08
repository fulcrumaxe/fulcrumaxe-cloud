import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fetchValidationHttpClient, requestFor, type ValidationOutcome } from '../src/httpClient.js';
import type { Provider } from '../src/types.js';
import { captureReports } from './helpers/captureReports.js';
import { startStrictProviders, type StrictProviders } from './helpers/strictProviders.js';

// What reportError is handed, before the reporter sanitises it: the telemetry layer would drop an odd stage or message
// itself, so a key leaking into either would otherwise go unseen here. The real reporter still runs.
const rawReports = vi.hoisted(() => [] as unknown[]);
vi.mock('@fx/telemetry', async (importOriginal) => {
  const original = await importOriginal<typeof import('@fx/telemetry')>();
  return {
    ...original,
    reportError: (err: unknown, ctx: Parameters<typeof original.reportError>[1]) => {
      const e = err as { name?: unknown; message?: unknown; code?: unknown } | null;
      // The error fetch itself throws is passed on as it is and carries the header text by design (the reporter keeps
      // only its class), so it is left out; the context, and any error this package makes up, must be clean.
      const fromFetch = typeof e?.message === 'string' && e.message.startsWith('Headers.append');
      rawReports.push(fromFetch ? { ctx } : { name: e?.name, message: e?.message, code: e?.code, ctx });
      return original.reportError(err, ctx);
    },
  };
});

/**
 * D#454 H2e (correction C1), criteria 1, 2, 9, 10 and 11 at the HTTP layer: the request each provider's key is proved
 * with, the status each answer maps to, that nothing here can generate, and that no key text leaves memory. The two
 * providers are local TLS servers reached through Node's real connection path (see helpers/strictProviders.ts).
 */
const GATEWAY_KEY = 'vck_h2e2_known_gateway_key_0001';
const ANTHROPIC_KEY = 'sk-ant-h2e2-known-anthropic-key-0001';

describe('H2e: the request and the status mapping, against strict provider fakes', () => {
  let world: StrictProviders;

  beforeAll(async () => {
    world = await startStrictProviders({ ai_gateway: [GATEWAY_KEY], anthropic: [ANTHROPIC_KEY] });
  });
  afterAll(async () => {
    await world.close();
  });
  afterEach(() => {
    // Criterion 9: whatever a test did, no request broke the read-only rules.
    expect(world.refused()).toEqual([]);
    world.reset();
  });

  const client = (timeoutMs = 5000) => fetchValidationHttpClient(timeoutMs, world.transport);
  const keyFor = (provider: Provider) => (provider === 'ai_gateway' ? GATEWAY_KEY : ANTHROPIC_KEY);

  describe('criterion 1: the gateway request', () => {
    it('is a GET of /v1/credits with an Authorization Bearer header and redirect: error', () => {
      const req = requestFor('ai_gateway', 'vck_unit_key');
      expect(req.url).toBe('https://ai-gateway.vercel.sh/v1/credits');
      expect(req.method).toBe('GET');
      expect(req.redirect).toBe('error');
      expect(Object.keys(req.headers)).toEqual(['Authorization']);
      expect(req.headers.Authorization).toBe('Bearer vck_unit_key');
    });

    it('leaves the Anthropic request as it was: GET /v1/models with x-api-key and the pinned version', () => {
      const req = requestFor('anthropic', 'sk-ant-unit');
      expect(req).toEqual({
        url: 'https://api.anthropic.com/v1/models',
        method: 'GET',
        redirect: 'error',
        headers: { 'x-api-key': 'sk-ant-unit', 'anthropic-version': '2023-06-01' },
      });
    });

    it('reaches the fake as exactly one GET /v1/credits with the Bearer key, over TLS to the real hostname', async () => {
      expect(await client().validate({ provider: 'ai_gateway', plaintextKey: GATEWAY_KEY })).toEqual({ kind: 'ok' });
      expect(world.ai_gateway.seen).toHaveLength(1);
      const seen = world.ai_gateway.seen[0]!;
      expect([seen.method, seen.path, seen.headers['authorization'], seen.servername]).toEqual(['GET', '/v1/credits', `Bearer ${GATEWAY_KEY}`, 'ai-gateway.vercel.sh']);
      expect(world.anthropic.seen).toHaveLength(0);
    });
  });

  describe('criterion 10: a wrong key is rejected, because the verifying call needs authentication', () => {
    it('a made-up gateway key is rejected (the documented /v1/models would have answered 200 for it)', async () => {
      const outcome = await client().validate({ provider: 'ai_gateway', plaintextKey: 'vck_made_up_not_a_real_key' });
      expect(outcome).toMatchObject({ kind: 'rejected', code: '401' });
      // The fake really does answer 200 on the unauthenticated listing, as documented: the old call could not tell.
      const listing = await world.transport('https://ai-gateway.vercel.sh/v1/models', { method: 'GET', headers: { Authorization: 'Bearer nonsense' } });
      expect(listing.status).toBe(200);
      world.ai_gateway.seen.length = 0;
    });

    it('a made-up Anthropic key, or one sent without the version header, is rejected', async () => {
      expect(await client().validate({ provider: 'anthropic', plaintextKey: 'sk-ant-made-up' })).toMatchObject({ kind: 'rejected', code: '401' });
      const noVersion = await world.transport('https://api.anthropic.com/v1/models', { method: 'GET', headers: { 'x-api-key': ANTHROPIC_KEY } });
      expect(noVersion.status).toBe(401);
      world.anthropic.seen.length = 0;
    });

    it('the known keys are accepted', async () => {
      expect(await client().validate({ provider: 'anthropic', plaintextKey: ANTHROPIC_KEY })).toEqual({ kind: 'ok' });
      expect(await client().validate({ provider: 'ai_gateway', plaintextKey: GATEWAY_KEY })).toEqual({ kind: 'ok' });
    });
  });

  describe('criterion 2: status mapping per provider', () => {
    type Expected = ValidationOutcome['kind'];
    const table: Array<[Provider, string, { status: number } | 'hang', Expected, string | null]> = [
      ['ai_gateway', '200', { status: 200 }, 'ok', null],
      ['ai_gateway', '401', { status: 401 }, 'rejected', '401'],
      ['ai_gateway', '403', { status: 403 }, 'network_error', '403'],
      ['ai_gateway', '402', { status: 402 }, 'network_error', '402'],
      ['ai_gateway', '429', { status: 429 }, 'network_error', '429'],
      ['ai_gateway', '500', { status: 500 }, 'network_error', '500'],
      ['ai_gateway', 'timeout', 'hang', 'network_error', 'fetch_failed'],
      ['anthropic', '200', { status: 200 }, 'ok', null],
      ['anthropic', '401', { status: 401 }, 'rejected', '401'],
      ['anthropic', '403', { status: 403 }, 'rejected', '403'],
      ['anthropic', '402', { status: 402 }, 'network_error', '402'],
      ['anthropic', '429', { status: 429 }, 'network_error', '429'],
      ['anthropic', '500', { status: 500 }, 'network_error', '500'],
      ['anthropic', 'timeout', 'hang', 'network_error', 'fetch_failed'],
    ];

    it.each(table)('%s answering %s is %s', async (provider, _label, mode, kind, code) => {
      world[provider].mode = mode;
      const outcome = await client(mode === 'hang' ? 150 : 5000).validate({ provider, plaintextKey: keyFor(provider) });
      expect(outcome.kind).toBe(kind);
      if (outcome.kind !== 'ok') expect(outcome.code).toBe(code);
      expect(world[provider].seen).toHaveLength(1);
    });
  });

  describe('criterion 9: never generates', () => {
    it('every request over every outcome is one GET on the one allowed path', async () => {
      for (const provider of ['ai_gateway', 'anthropic'] as const) {
        for (const mode of [null, { status: 401 }, { status: 403 }, { status: 429 }, { status: 500 }] as const) {
          world[provider].mode = mode;
          await client().validate({ provider, plaintextKey: keyFor(provider) });
          world[provider].mode = null;
        }
      }
      const seen = world.seen();
      expect(seen).toHaveLength(10);
      expect(new Set(seen.map((r) => `${r.method} ${r.path}`))).toEqual(new Set(['GET /v1/credits', 'GET /v1/models']));
      expect(seen.filter((r) => r.path === '/v1/models' && r.servername === 'ai-gateway.vercel.sh')).toEqual([]);
    });

    it('the fake itself refuses a POST and a chat-completions path, so a client that tried would fail the suite', async () => {
      const post = await world.transport('https://ai-gateway.vercel.sh/v1/credits', { method: 'POST', headers: { Authorization: `Bearer ${GATEWAY_KEY}` } });
      const chat = await world.transport('https://ai-gateway.vercel.sh/v1/chat/completions', { method: 'GET', headers: { Authorization: `Bearer ${GATEWAY_KEY}` } });
      const messages = await world.transport('https://api.anthropic.com/v1/messages', { method: 'GET', headers: { 'x-api-key': ANTHROPIC_KEY } });
      expect([post.status, chat.status, messages.status]).toEqual([405, 404, 404]);
      expect(world.refused()).toHaveLength(3);
      // Cleared here on purpose: this test asserts the refusals; the suite-wide check is for every other test.
      world.ai_gateway.refused.length = 0;
      world.anthropic.refused.length = 0;
    });

    it('the transport cannot reach any other host', async () => {
      await expect(world.transport('https://api.openai.com/v1/models', { method: 'GET' })).rejects.toThrow(/not a provider fake/);
    });
  });
});

describe('criterion 11: key values never leave memory', () => {
  const SENTINEL = 'vck_SENTINEL_h2e2_9f3a7c11d2e84b05_never_logged';
  let world: StrictProviders;

  beforeAll(async () => {
    world = await startStrictProviders({ ai_gateway: [SENTINEL], anthropic: [SENTINEL] });
  });
  afterAll(async () => {
    await world.close();
  });
  afterEach(() => {
    world.reset();
    vi.restoreAllMocks();
  });

  it('no outcome, report, console line or stdout write holds the key, for every status, a timeout and a throwing fetch', async () => {
    const reports = captureReports();
    const sink: string[] = [];
    const grab = (...args: unknown[]) => {
      sink.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
    vi.spyOn(console, 'log').mockImplementation(grab);
    vi.spyOn(console, 'error').mockImplementation(grab);
    vi.spyOn(console, 'warn').mockImplementation(grab);
    vi.spyOn(console, 'info').mockImplementation(grab);
    vi.spyOn(console, 'debug').mockImplementation(grab);
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      sink.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      sink.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);

    const outcomes: ValidationOutcome[] = [];
    for (const provider of ['ai_gateway', 'anthropic'] as const) {
      for (const mode of [null, { status: 401 }, { status: 403 }, { status: 402 }, { status: 429 }, { status: 500 }, 'hang'] as const) {
        world[provider].mode = mode;
        outcomes.push(await fetchValidationHttpClient(mode === 'hang' ? 100 : 5000, world.transport).validate({ provider, plaintextKey: SENTINEL }));
        world[provider].mode = null;
      }
      // An unknown key, a fetch that throws with the whole header (and the key) in its error text and code.
      outcomes.push(await fetchValidationHttpClient(5000, world.transport).validate({ provider, plaintextKey: SENTINEL + '_wrong' }));
      const throwing = (async () => {
        const err = new TypeError(`Headers.append: "Bearer ${SENTINEL}\n" is an invalid header value`) as TypeError & { code: string };
        err.code = 'E_' + SENTINEL;
        throw err;
      }) as typeof fetch;
      outcomes.push(await fetchValidationHttpClient(5000, throwing).validate({ provider, plaintextKey: SENTINEL }));
    }

    expect(outcomes.some((o) => o.kind === 'ok')).toBe(true);
    expect(outcomes.some((o) => o.kind === 'rejected')).toBe(true);
    expect(outcomes.some((o) => o.kind === 'network_error')).toBe(true);
    // The fetch that throws and the timeouts did reach reportError, and what it was handed never held the key.
    expect(rawReports.length).toBeGreaterThan(0);
    const everything = [JSON.stringify(outcomes), reports.everything(), sink.join('\n'), JSON.stringify(rawReports)].join('\n');
    expect(everything).not.toContain(SENTINEL);
    expect(everything).not.toContain('SENTINEL_h2e2');
    expect(world.refused()).toEqual([]);
  });
});
