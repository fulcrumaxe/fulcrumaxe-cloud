import { PARTNER_LAYER_ENV, normalizeHostname, partnerLayerOn, type PartnerEnv, type Queryable } from "../host/index.js";

/**
 * The structural shape of `AccountCreatedContext` (packages/core/src/auth/onAccountCreated.ts) that this hook reads. It is
 * declared here, not imported, so this package does not depend on @fx/core, and @fx/core does not depend on this one: the hook is
 * registered from apps/web (apps/web/lib/partners/registerHooks.ts).
 */
export interface PartnerSignupContext {
  accountId: string;
  /** Set by the sign-in handoff (a later row) when the person signed up on a partner's host. Absent: nothing to do. */
  signupHost?: string | undefined;
  /** The transaction that created the account. The assignment runs inside it, so it commits or rolls back with the signup. */
  client: Queryable;
}

/**
 * Binds a just-created account to the reseller whose host the person signed up on, through the definer
 * `assign_partner_on_signup` (migration 0803). A no-op unless `signupHost` is set and `FX_PARTNER_LAYER` is `on`.
 *
 * It does not swallow a refusal. A host that stopped being an active partner host, or an account that already has a partner or a
 * referrer, raises inside the signup transaction and the signup fails: an account created on a partner's host must never end up
 * silently direct.
 */
export async function assignPartnerOnSignup(ctx: PartnerSignupContext, env: PartnerEnv = process.env): Promise<void> {
  if (!ctx.signupHost || !partnerLayerOn(env)) return;
  const host = normalizeHostname(ctx.signupHost);
  if (host === null) {
    throw new Error(`${PARTNER_LAYER_ENV} is on but the signup host is not a hostname`);
  }
  await ctx.client.query("SELECT assign_partner_on_signup($1, $2)", [ctx.accountId, host]);
}

/** The hook as registered on `onAccountCreated`. One shared function, so registering it twice is detectable (`includes`). */
export const partnerSignupHook = (ctx: PartnerSignupContext): Promise<void> => assignPartnerOnSignup(ctx);
