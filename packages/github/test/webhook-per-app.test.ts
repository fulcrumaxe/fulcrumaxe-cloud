import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadAppCredentials, type AppCredentialsSource } from '../src/appCredentials.js';
import { selectWebhookApp } from '../src/webhookApp.js';

/**
 * D#2 H13e-2 (H2-1): the sending App is chosen by the delivery's
 * target-id header alone -- by exact decimal comparison against the
 * configured kinds' App ids. Signature checking against the chosen secret
 * is the handler's (apps/web handler.test.ts); this file is the selection.
 */
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const secret = (kind: string) => `${kind}-webhook-secret`.padEnd(40, 'x');

function env(ids: { team?: string; team_readonly?: string; sitekit?: string }): Record<string, string> {
  const out: Record<string, string> = {};
  const set = (idName: string, keyName: string, secretName: string, kind: string, id?: string) => {
    if (!id) return;
    out[idName] = id;
    out[keyName] = PEM;
    out[secretName] = secret(kind);
  };
  set('GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY_PEM', 'GITHUB_WEBHOOK_SECRET', 'team', ids.team);
  set(
    'GITHUB_APP_TEAM_READONLY_ID',
    'GITHUB_APP_TEAM_READONLY_PRIVATE_KEY_PEM',
    'GITHUB_APP_TEAM_READONLY_WEBHOOK_SECRET',
    'team_readonly',
    ids.team_readonly,
  );
  set('GITHUB_APP_SITEKIT_ID', 'GITHUB_APP_SITEKIT_PRIVATE_KEY_PEM', 'GITHUB_APP_SITEKIT_WEBHOOK_SECRET', 'sitekit', ids.sitekit);
  return out;
}

describe('selectWebhookApp', () => {
  const three: AppCredentialsSource = loadAppCredentials(env({ team: '111', team_readonly: '222', sitekit: '333' }));

  it('maps each configured App id to its own kind and its own secret', () => {
    for (const [id, kind] of [['111', 'team'], ['222', 'team_readonly'], ['333', 'sitekit']] as const) {
      expect(selectWebhookApp(three, id)).toEqual({ kind, webhookSecret: secret(kind) });
    }
  });

  it('returns null for a missing header, an unknown id, or a non-canonical decimal', () => {
    for (const id of [null, '', '999', '0111', '+111', '111.0', '1e2', ' 111', '111 ', 'abc']) {
      expect(selectWebhookApp(three, id), String(id)).toBeNull();
    }
  });

  it('a kind that is not configured has no id to match', () => {
    const teamOnly = loadAppCredentials(env({ team: '111' }));
    expect(selectWebhookApp(teamOnly, '111')?.kind).toBe('team');
    expect(selectWebhookApp(teamOnly, '222')).toBeNull();
    expect(selectWebhookApp(loadAppCredentials({}), '111')).toBeNull();
  });

  it('two kinds sharing one App id are refused for every kind', () => {
    const dup = loadAppCredentials(env({ team: '111', team_readonly: '111' }));
    expect(selectWebhookApp(dup, '111')).toBeNull();
    expect(selectWebhookApp(dup, '222')).toBeNull();
  });

  it('stops at the matching kind: it never fans out to try the remaining Apps', () => {
    const seen: string[] = [];
    const spy: AppCredentialsSource = (kind) => {
      seen.push(String(kind));
      return three(kind);
    };
    selectWebhookApp(spy, '222');
    expect(seen).toEqual(['team', 'team_readonly']);
  });
});
