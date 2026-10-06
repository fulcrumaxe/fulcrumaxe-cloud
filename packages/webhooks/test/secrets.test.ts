import { afterEach, describe, expect, it, vi } from 'vitest';
import { DecryptionFailedError } from '@fx/model-connection';
import { envWebhookKekSource, generateWebhookSecret, openWebhookSecret, sealWebhookSecret } from '../src/secrets.js';

/**
 * D#31 fix round 2, MUST 2: real tests for secrets.ts -- the original PR
 * only exercised `generateWebhookSecret` (as a fixture helper in
 * sign.test.ts); `sealWebhookSecret`/`openWebhookSecret`/
 * `envWebhookKekSource` had zero coverage despite being the file that
 * enforces criterion 4's envelope encryption.
 */

// A valid 32-byte AES-256 key, base64-encoded -- same shape
// `envWebhookKekSource` requires for `FX_WEBHOOK_KEK_V{version}`.
const VALID_KEK_BASE64 = Buffer.alloc(32, 7).toString('base64');

describe('secrets: envelope encryption', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('sealWebhookSecret / openWebhookSecret round trip', () => {
    it('opens to exactly the sealed plaintext under FX_WEBHOOK_KEK_V1', () => {
      vi.stubEnv('FX_WEBHOOK_KEK_V1', VALID_KEK_BASE64);
      const kekSource = envWebhookKekSource();
      const plaintext = generateWebhookSecret();
      const accountId = 'acct_11111111-1111-4111-8111-111111111111';
      const endpointId = 'ep_11111111-1111-4111-8111-111111111111';

      const sealed = sealWebhookSecret(kekSource, accountId, endpointId, plaintext);
      expect(sealed.kekVersion).toBe(1);

      const opened = openWebhookSecret(kekSource, accountId, endpointId, sealed);
      expect(opened).toBe(plaintext);
    });

    it('fails closed when opened with a different account_id (AAD mismatch)', () => {
      vi.stubEnv('FX_WEBHOOK_KEK_V1', VALID_KEK_BASE64);
      const kekSource = envWebhookKekSource();
      const endpointId = 'ep_22222222-2222-4222-8222-222222222222';
      const sealed = sealWebhookSecret(kekSource, 'acct_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', endpointId, generateWebhookSecret());

      expect(() => openWebhookSecret(kekSource, 'acct_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', endpointId, sealed)).toThrow(
        DecryptionFailedError,
      );
    });

    it('fails closed when opened with a different endpoint_id (AAD mismatch)', () => {
      vi.stubEnv('FX_WEBHOOK_KEK_V1', VALID_KEK_BASE64);
      const kekSource = envWebhookKekSource();
      const accountId = 'acct_33333333-3333-4333-8333-333333333333';
      const sealed = sealWebhookSecret(kekSource, accountId, 'ep_cccccccc-cccc-4ccc-8ccc-cccccccccccc', generateWebhookSecret());

      expect(() => openWebhookSecret(kekSource, accountId, 'ep_dddddddd-dddd-4ddd-8ddd-dddddddddddd', sealed)).toThrow(
        DecryptionFailedError,
      );
    });
  });

  describe('envWebhookKekSource', () => {
    it('throws when FX_WEBHOOK_KEK_V{version} is not set', () => {
      vi.stubEnv('FX_WEBHOOK_KEK_V1', undefined as unknown as string);
      delete process.env.FX_WEBHOOK_KEK_V1;
      const kekSource = envWebhookKekSource();
      expect(() => kekSource.keyFor(1)).toThrow(/FX_WEBHOOK_KEK_V1 is not set/);
    });

    it('throws when FX_WEBHOOK_KEK_V{version} decodes to fewer than 32 bytes', () => {
      vi.stubEnv('FX_WEBHOOK_KEK_V1', Buffer.alloc(16, 1).toString('base64'));
      const kekSource = envWebhookKekSource();
      expect(() => kekSource.keyFor(1)).toThrow(/must decode \(base64\) to exactly 32 bytes/);
    });

    it('is independent of FX_KEK_V1 -- setting only the model-connection root key still fails closed', () => {
      vi.stubEnv('FX_KEK_V1', VALID_KEK_BASE64);
      vi.stubEnv('FX_WEBHOOK_KEK_V1', undefined as unknown as string);
      delete process.env.FX_WEBHOOK_KEK_V1;
      const kekSource = envWebhookKekSource();
      expect(() => kekSource.keyFor(1)).toThrow(/FX_WEBHOOK_KEK_V1 is not set/);
    });
  });

  describe('the secret is never logged', () => {
    it('seal/open produce no console or stdout/stderr output containing the plaintext secret or the raw KEK', () => {
      vi.stubEnv('FX_WEBHOOK_KEK_V1', VALID_KEK_BASE64);
      const kekSource = envWebhookKekSource();
      const plaintext = generateWebhookSecret();
      const accountId = 'acct_eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      const endpointId = 'ep_ffffffff-ffff-4fff-8fff-ffffffffffff';

      const captured: string[] = [];
      const capture = (chunk: unknown): boolean => {
        captured.push(typeof chunk === 'string' ? chunk : String(chunk));
        return true;
      };

      const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
        vi.spyOn(console, method).mockImplementation(((...args: unknown[]) => {
          captured.push(args.map(String).join(' '));
        }) as never),
      );
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(capture as never);
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(capture as never);

      try {
        const sealed = sealWebhookSecret(kekSource, accountId, endpointId, plaintext);
        openWebhookSecret(kekSource, accountId, endpointId, sealed);
        // Also exercise the fail-closed path -- a thrown error is exactly
        // where an implementation is tempted to dump context for
        // debugging, which is exactly the case where a secret must NOT
        // end up in a log line.
        try {
          openWebhookSecret(kekSource, 'acct_wrong-account-wrong-account-wrong', endpointId, sealed);
        } catch {
          // expected: AAD mismatch
        }
      } finally {
        consoleSpies.forEach((s) => s.mockRestore());
        stdoutSpy.mockRestore();
        stderrSpy.mockRestore();
      }

      const allOutput = captured.join('\n');
      expect(allOutput).not.toContain(plaintext);
      expect(allOutput).not.toContain(VALID_KEK_BASE64);
    });
  });
});
