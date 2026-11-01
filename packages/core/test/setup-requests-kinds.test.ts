import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AGENT_PROPOSABLE_KINDS,
  SETUP_REQUEST_KINDS,
  isAgentProposableKind,
  isSetupRequestKind,
  isValidReason,
  isValidTarget,
  normalizeProviderUrl,
  setupRequestTitle,
} from '../src/setup-requests/kinds.js';

describe('D#598 P8a: setup request vocabulary', () => {
  it('the kinds are exactly the six the Spec names; an agent may propose all but public/private drift', () => {
    expect([...SETUP_REQUEST_KINDS].sort()).toEqual(['app_not_installed', 'branch_pushed_by_person', 'env_var', 'overlay_path_missing', 'parent_pr_closed', 'parity_drift']);
    expect([...AGENT_PROPOSABLE_KINDS].sort()).toEqual(['app_not_installed', 'branch_pushed_by_person', 'env_var', 'overlay_path_missing', 'parent_pr_closed']);
    for (const bad of ['', 'secret', 'api_key', 'ENV_VAR', 'env_var ', null, undefined, 3, {}]) expect(isSetupRequestKind(bad), String(bad)).toBe(false);
    expect(isAgentProposableKind('parity_drift')).toBe(false);
  });

  it('the migration lists the same kinds as the code', () => {
    const sql = readFileSync(new URL('../../db/migrations/0856_setup_requests.sql', import.meta.url), 'utf8');
    const block = sql.match(/setup_requests_kind_check CHECK \(kind IN \(([^)]*)\)/)![1]!;
    const listed = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(listed.sort()).toEqual([...SETUP_REQUEST_KINDS].sort());
  });

  it('target and reason: length and control characters; markup and addresses are allowed and stay text', () => {
    expect(isValidTarget('cloud-staging')).toBe(true);
    expect(isValidTarget('')).toBe(false);
    expect(isValidTarget('a'.repeat(201))).toBe(false);
    expect(isValidTarget('a\nb')).toBe(false);
    expect(isValidReason('<b>x</b> https://example.com\nsecond line\tindented')).toBe(true);
    expect(isValidReason('')).toBe(false);
    expect(isValidReason('x'.repeat(1001))).toBe(false);
    expect(isValidReason('bell\u0007')).toBe(false);
  });

  it('the provider link: https on github.com or vercel.com only', () => {
    expect(normalizeProviderUrl('https://github.com/apps/acme/installations/new')).toBe('https://github.com/apps/acme/installations/new');
    expect(normalizeProviderUrl('https://vercel.com')).toBe('https://vercel.com/');
    for (const bad of [
      'http://github.com/x', 'https://github.com.evil.com/', 'https://evil.com/github.com', 'https://user@github.com/', 'https://github.com:444/',
      'https://sub.github.com/', 'javascript:alert(1)', 'ftp://github.com/', 'github.com', '', ' https://github.com/', 'https://github.com/a b',
      'https://github.com\\.evil.com/',
    ]) {
      expect(normalizeProviderUrl(bad), bad).toBeNull();
    }
  });

  it('a non-ASCII path is stored percent-encoded, so the stored link is the one the database pattern accepts', () => {
    expect(normalizeProviderUrl('https://github.com/\u00e9')).toBe('https://github.com/%C3%A9');
  });

  it('titles come from fixed templates and never contain a null or undefined', () => {
    for (const kind of SETUP_REQUEST_KINDS) {
      expect(setupRequestTitle(kind, 'target', kind === 'env_var' ? 'NAME' : null)).not.toMatch(/null|undefined/);
    }
    expect(setupRequestTitle('app_not_installed', 'acme/web', null)).toBe('App not installed on acme/web');
    expect(setupRequestTitle('branch_pushed_by_person', 'fx/x', null)).toBe('Someone pushed to fx/x');
    expect(setupRequestTitle('overlay_path_missing', 'plan.json', null)).toBe('Add plan.json to the overlay paths');
    expect(setupRequestTitle('parity_drift', 'me/pub', null)).toBe('Parity check needs attention: me/pub');
  });
});
