/**
 * Deny-by-default allowlist for floored roles (D#221 S4). A floored role
 * (see floors.ts) may run only on an entry listed here, matched on the exact
 * (backend, provider, model id) triple. Entries are added by the owner alone,
 * in this file, after the eval harness shows envelope compliance and
 * prompt-injection resistance for that model. Never derive an entry from price
 * or gateway metadata, and never add an alias (`openrouter/auto`, a bare
 * family name) or a routing-variant suffix (`:floor`, `:nitro`): the list
 * matches ids byte for byte, and `isAliasLike` refuses those shapes even if an
 * entry is added by mistake.
 */
export interface BackendRef {
  backend: string;
  provider: string;
}

export interface ModelTarget extends BackendRef {
  model: string;
}

/** At Launch, floored roles run on claude-code with Claude, whatever backend
 * the account defaults to. */
export const FLOORED_PIN: Readonly<BackendRef> = Object.freeze({ backend: 'claude-code', provider: 'anthropic' });

export const FLOORED_ALLOWLIST: readonly Readonly<ModelTarget>[] = Object.freeze([
  Object.freeze({ ...FLOORED_PIN, model: 'sonnet-5' }),
  Object.freeze({ ...FLOORED_PIN, model: 'opus-5' }),
]);

/** Router-side aliases and variant suffixes are never a concrete model. */
export function isAliasLike(model: string): boolean {
  return model.includes(':') || model.toLowerCase().split('/').includes('auto') || model !== model.trim();
}

export function isAllowlisted(target: ModelTarget): boolean {
  if (isAliasLike(target.model)) return false;
  return FLOORED_ALLOWLIST.some(
    (e) => e.backend === target.backend && e.provider === target.provider && e.model === target.model,
  );
}

/** The backend a role runs on: a floored role is always the pin, whatever the
 * account default is. Other roles keep the account default (the pin when
 * there is none). */
export function backendForRole(floored: boolean, accountDefault?: BackendRef): BackendRef {
  return floored || accountDefault === undefined ? FLOORED_PIN : accountDefault;
}
