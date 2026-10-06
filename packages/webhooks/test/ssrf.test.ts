import { describe, expect, it } from 'vitest';
import type { LookupAddress } from '@fx/net-guard';
import { validateWebhookUrlSyntax, resolveDeliveryAddresses, InvalidWebhookUrlError, MAX_WEBHOOK_URL_LENGTH } from '../src/ssrf.js';

/**
 * D#31 API-4b, criteria 1 and 2. Every check here runs the REAL
 * `@fx/net-guard` classifier (`isBlockedAddress`/`resolveChecked`) --
 * nothing about the guard itself is mocked, only the DNS answer for the
 * "a DNS name resolving to a private address" cases, exactly the way
 * `resolveChecked`'s own test seam is meant to be used.
 */
describe('ssrf: criterion 1, registration-time syntax checks', () => {
  it('accepts a normal https URL with no port', () => {
    const url = validateWebhookUrlSyntax('https://example.com/hooks/fulcrumaxe');
    expect(url.hostname).toBe('example.com');
  });

  it('accepts an explicit :443', () => {
    expect(() => validateWebhookUrlSyntax('https://example.com:443/hook')).not.toThrow();
  });

  it('rejects a plain http:// URL (scheme)', () => {
    expect(() => validateWebhookUrlSyntax('http://example.com/hook')).toThrowError(
      expect.objectContaining({ reasonClass: 'scheme' }),
    );
  });

  it('rejects a non-standard port (8443)', () => {
    expect(() => validateWebhookUrlSyntax('https://example.com:8443/hook')).toThrowError(
      expect.objectContaining({ reasonClass: 'port' }),
    );
  });

  it('rejects userinfo in the URL', () => {
    expect(() => validateWebhookUrlSyntax('https://user:pass@example.com/hook')).toThrowError(
      expect.objectContaining({ reasonClass: 'userinfo' }),
    );
  });

  it('rejects a URL over 2,048 characters', () => {
    const longPath = 'a'.repeat(MAX_WEBHOOK_URL_LENGTH);
    expect(() => validateWebhookUrlSyntax(`https://example.com/${longPath}`)).toThrowError(
      expect.objectContaining({ reasonClass: 'url_too_long' }),
    );
  });

  it('rejects a syntactically invalid URL', () => {
    expect(() => validateWebhookUrlSyntax('not a url')).toThrowError(
      expect.objectContaining({ reasonClass: 'invalid_url' }),
    );
  });

  describe('IP-literal forms (WHATWG URL already normalizes these to a canonical address)', () => {
    const blocked = [
      'https://127.0.0.1/hook',
      'https://2130706433/hook', // decimal
      'https://0x7f000001/hook', // hex
      'https://017700000001/hook', // octal
      'https://[::1]/hook',
      'https://[::ffff:127.0.0.1]/hook', // IPv4-mapped IPv6
      'https://169.254.169.254/hook', // cloud metadata
    ];
    for (const url of blocked) {
      it(`rejects ${url}`, () => {
        expect(() => validateWebhookUrlSyntax(url)).toThrowError(
          expect.objectContaining({ reasonClass: 'blocked_address' }),
        );
      });
    }
  });

  describe('blocked hostnames', () => {
    const blocked = [
      'https://localhost/hook',
      'https://a.local/hook',
      'https://a.internal/hook',
      'https://sub.fulcrumaxe.dev/hook',
    ];
    for (const url of blocked) {
      it(`rejects ${url}`, () => {
        expect(() => validateWebhookUrlSyntax(url)).toThrowError(
          expect.objectContaining({ reasonClass: 'blocked_hostname' }),
        );
      });
    }
  });
});

describe('ssrf: criterion 2, delivery-time resolve-and-pin', () => {
  function fakeLookupResolving(addresses: string[]) {
    return async (): Promise<LookupAddress[]> => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  }

  it('a hostname resolving to a public address is returned, unblocked', async () => {
    const addresses = await resolveDeliveryAddresses('api.example.com', fakeLookupResolving(['93.184.216.34']));
    expect(addresses).toEqual(['93.184.216.34']);
  });

  it('a DNS name resolving to a private address (10.0.0.0/8) fails as blocked_address', async () => {
    await expect(resolveDeliveryAddresses('internal.example.com', fakeLookupResolving(['10.0.0.5']))).rejects.toThrowError(
      expect.objectContaining({ reasonClass: 'blocked_address' }),
    );
  });

  it('a DNS name resolving to the cloud metadata address fails as blocked_address', async () => {
    await expect(resolveDeliveryAddresses('metadata.example.com', fakeLookupResolving(['169.254.169.254']))).rejects.toThrowError(
      expect.objectContaining({ reasonClass: 'blocked_address' }),
    );
  });

  it('a DNS name resolving to an IPv6 private address (fc00::/7) fails as blocked_address', async () => {
    await expect(resolveDeliveryAddresses('internal6.example.com', fakeLookupResolving(['fc00::1']))).rejects.toThrowError(
      expect.objectContaining({ reasonClass: 'blocked_address' }),
    );
  });

  it('a DNS name resolving to an IPv4-mapped IPv6 loopback fails as blocked_address', async () => {
    await expect(
      resolveDeliveryAddresses('mapped.example.com', fakeLookupResolving(['::ffff:127.0.0.1'])),
    ).rejects.toThrowError(expect.objectContaining({ reasonClass: 'blocked_address' }));
  });

  it('ANY blocked address among several answers fails the whole resolution (public then private)', async () => {
    await expect(
      resolveDeliveryAddresses('mixed.example.com', fakeLookupResolving(['93.184.216.34', '127.0.0.1'])),
    ).rejects.toThrowError(expect.objectContaining({ reasonClass: 'blocked_address' }));
  });

  it('a DNS failure is reported distinctly from a blocked address', async () => {
    const failingLookup = async (): Promise<LookupAddress[]> => {
      throw new Error('ENOTFOUND');
    };
    await expect(resolveDeliveryAddresses('nowhere.example.com', failingLookup)).rejects.toBeInstanceOf(InvalidWebhookUrlError);
    await expect(resolveDeliveryAddresses('nowhere.example.com', failingLookup)).rejects.toThrowError(
      expect.objectContaining({ reasonClass: 'dns_failed' }),
    );
  });
});
