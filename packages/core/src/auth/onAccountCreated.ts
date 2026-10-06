import type { PoolClient } from 'pg';

export interface AccountCreatedContext {
  accountId: string;
  ownerUserId: string;
  client: PoolClient;
}

export type AccountCreatedHook = (ctx: AccountCreatedContext) => Promise<void> | void;

/**
 * D#2607 X3.2 registration point: "H06 exposes an onAccountCreated hook
 * array in packages/core/src/auth/. P02 (partner assignment) and P06
 * (referral attribution) add one line each." Empty here -- H06 has no
 * hooks of its own to register. identity.ts's createAccountForNewOwner
 * runs every hook in order, inside the SAME transaction as the account
 * and account_members INSERTs, by passing its own `client` through.
 */
export const onAccountCreated: AccountCreatedHook[] = [];
