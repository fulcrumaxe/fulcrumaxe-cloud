import { resolveChecked, NetGuardError, type HostLookup } from "@fx/net-guard";
import { assertGithubForwardConfig, toGithubForwardConnection, type GithubForwardConfig } from "./githubForwardConfig.js";
import { modelAuthValue, networkPolicy, type NetworkPolicyPhase, type NetworkPolicyRule } from "./networkPolicy.js";
import type { ConnectionKind, ModelProvider, Product, Role } from "./types.js";

/**
 * D#2 H09 pass/fail 3: "The tenant key is decrypted only inside the step
 * that builds the firewall policy, and is not returned from that step. It
 * is not in the workflow step's serialized input or output (Workflow
 * persists those), and a test inspects the recorded step payloads."
 *
 * `buildFirewallPolicy` is the one place in this package that touches the
 * tenant's decrypted model key. Its INPUT carries only ciphertext
 * (`EncryptedTenantKey` -- never a plaintext field to begin with, so
 * there is no way for a caller to accidentally pass the plaintext in, and
 * nothing for a Workflow step-input recorder to capture); its OUTPUT is
 * `NetworkPolicyRule[]`, which carries a host and a header NAME per rule and,
 * on the model rule only, the header VALUE as a NON-ENUMERABLE `authValue`
 * (H14c-3-1): the one place the key leaves this function, read by the sandbox
 * port to build the SDK header transform, invisible to serialisation. It is
 * not stored on `this` or in a module variable.
 *
 * `decryptTenantKey` is caller-injected on purpose: H09's file scope
 * (`packages/runner/**`) doesn't own the KMS/KEK unwrap logic (that's
 * H02/H10's), and injecting it here is what lets
 * `test/firewallPolicy.test.ts` prove the "not returned, not in the
 * output" property with a test double that returns a known, recognizable
 * fake secret and asserts it never appears in this function's return
 * value.
 *
 * There is no real firewall broker to register with yet (H13 -- "the
 * GitHub proxy both mints a per-role scoped token and enforces path and
 * ref policy" -- is H09's sibling, not built). In production this
 * function's caller would hand the decrypted key to that broker, keyed by
 * sandbox name, so the broker injects it when it forwards a request that
 * matches one of the returned `NetworkPolicyRule`s -- the sandbox process
 * itself is never handed the key (Consensus Summary point 2). H09a's job
 * ends at "decrypt happens exactly once, in this function, and never
 * leaves it" -- wiring an actual broker is H09b/H13's.
 */
export interface EncryptedTenantKey {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  wrappedDek: Uint8Array;
  kekVersion: number;
}

/**
 * NON-SECRET identifiers of the sealed key: the account that owns the model
 * connection and the connection row. A production decryptor builds the
 * envelope's AAD from them (H14c-3-2b), so a ciphertext copied onto another
 * account or row does not open. Never carries the key.
 */
export interface TenantKeyContext {
  accountId: string;
  connectionId: string;
}

/** Caller-injected decrypt function. Returns the plaintext key -- the ONLY
 * function in this package's public surface that ever sees it. */
export type DecryptTenantKey = (encrypted: EncryptedTenantKey, context: TenantKeyContext) => Promise<string>;

/**
 * Thrown by `buildFirewallPolicy` whenever `decryptTenantKey` fails or
 * returns something unusable. Fixed message, no `cause`, and never
 * includes the caught error's own `message` -- `decryptTenantKey` is
 * caller-injected and not known here, so a decryptor that puts the
 * plaintext (or a shape resembling it) in its own thrown error's message
 * or `cause` must never have that reach this function's caller (H09
 * security review, "should fix" 3).
 */
export class DecryptTenantKeyError extends Error {
  constructor() {
    super("buildFirewallPolicy: failed to decrypt the tenant's model key");
    this.name = "DecryptTenantKeyError";
  }
}

/** D#66: the three classes `GithubForwardHostRefusedError` can carry --
 * a config-shape/allowlist failure, a DNS failure, or a resolved address
 * that `@fx/net-guard`'s `isBlockedAddress` rejects. */
export type GithubForwardHostRefusedClass = "config" | "dns_failed" | "blocked_address";

/**
 * D#66, decision (c): thrown by `buildFirewallPolicy` when the injected
 * GitHub forward config fails its own checks, or its resolved address(es)
 * fail `@fx/net-guard`'s classifier. Like `DecryptTenantKeyError`: a
 * fixed message, no `cause`, never the resolved address -- only the
 * `class` distinguishes why.
 */
export class GithubForwardHostRefusedError extends Error {
  readonly class: GithubForwardHostRefusedClass;
  constructor(refusalClass: GithubForwardHostRefusedClass) {
    super("buildFirewallPolicy: refused to build a policy for the configured GitHub forward host");
    this.name = "GithubForwardHostRefusedError";
    this.class = refusalClass;
  }
}

export interface FirewallPolicyInput {
  role: Role;
  product: Product;
  provider: ModelProvider;
  encryptedKey: EncryptedTenantKey;
  /** Non-secret; handed to the decryptor next to the ciphertext. */
  keyContext: TenantKeyContext;
  phase?: NetworkPolicyPhase;
}

/** D#66: `deps` carries the GitHub forward config and an optional
 * injectable DNS lookup -- kept as a separate argument (like
 * `decryptTenantKey`), never merged into `FirewallPolicyInput`, so it is
 * never part of a serialised Workflow step input. */
export interface FirewallPolicyDeps {
  githubForward: GithubForwardConfig;
  lookup?: HostLookup;
}

/**
 * `"use step"` in H09b's actual Workflow wrapper (not this file -- this is
 * the plain async function the thin wrapper calls, per the Spec's own file
 * layout: "`src/workflows/*.ts` as thin `"use workflow"` / `"use step"`
 * wrappers over plain async functions"). Decrypts `input.encryptedKey`
 * exactly once, uses the plaintext for nothing this function returns, and
 * returns only network policy rules.
 *
 * D#66, decision (c): before decrypting anything, re-validates
 * `deps.githubForward` (defence in depth against a forged value) and
 * resolves its host through `@fx/net-guard`'s `resolveChecked` on EVERY
 * call -- never once at boot, and never cached -- refusing to build a
 * policy at all if that fails. `decryptTenantKey` is never called when
 * either check fails (criterion 6's "0 calls" assertion).
 */
export async function buildFirewallPolicy(
  decryptTenantKey: DecryptTenantKey,
  input: FirewallPolicyInput,
  deps: FirewallPolicyDeps,
): Promise<NetworkPolicyRule[]> {
  const host = await checkedForwardHost(deps);

  let plaintextKey: string;
  try {
    plaintextKey = await decryptTenantKey(input.encryptedKey, input.keyContext);
  } catch {
    // No `(err)` binding -- the caught error (and anything it carries in
    // `message`/`cause`) is deliberately never touched, only discarded.
    throw new DecryptTenantKeyError();
  }
  if (typeof plaintextKey !== "string" || plaintextKey.length === 0) {
    throw new DecryptTenantKeyError();
  }
  return rulesCarryingKey(plaintextKey, input.provider, host, input);
}

/** The operator's inputs: no ciphertext and no tenant context, because the credential is our own and is never stored. */
export interface OperatorFirewallPolicyInput {
  role: Role;
  product: Product;
  phase?: NetworkPolicyPhase;
}

/**
 * The operator-subscription counterpart of `buildFirewallPolicy`: the same GitHub forward
 * checks, then the model rule for api.anthropic.com carries `Authorization: Bearer <token>`
 * as the same non-enumerable `authValue`. `operatorToken` is handed in by the caller that
 * read it from the worker's environment (and only for an account the operator decision
 * admitted); nothing here reads an environment or stores the value. A token that is not
 * subscription-token-shaped is refused with the same fixed error as an unusable tenant key.
 */
export async function buildOperatorFirewallPolicy(
  operatorToken: string,
  input: OperatorFirewallPolicyInput,
  deps: FirewallPolicyDeps,
): Promise<NetworkPolicyRule[]> {
  const host = await checkedForwardHost(deps);
  return rulesCarryingKey(operatorToken, "operator_subscription", host, input);
}

/** The shared front half: the forward config re-validated and its host resolved, before any key is touched. */
async function checkedForwardHost(deps: FirewallPolicyDeps): Promise<string> {
  // D#66 security review round 2, must-fix 1 (CWE-367 -> CWE-918): read
  // `deps.githubForward` into a local exactly once, right here, before the
  // assert -- everything below reads this local, and `deps.githubForward`
  // is never touched again. A `deps` whose `githubForward` is a getter
  // could otherwise hand back a real, issued config on the assert's read
  // and a forged object on a later read, bypassing the assert entirely no
  // matter how well the object itself is frozen.
  const githubForward = deps.githubForward;
  try {
    assertGithubForwardConfig(githubForward);
  } catch {
    throw new GithubForwardHostRefusedError("config");
  }

  // The host is also read into its own local exactly once, right here,
  // and reused for both the resolve check and the Connection builder
  // below. Reading `.host` again after the `await` would let a host that
  // changed during the lookup (a mutated shared config object) reach the
  // `github_proxy` rule unresolved and unchecked. `loadGithubForwardConfig`
  // freezes what it returns, so a write to `.host` on a real config throws
  // rather than silently succeeding; this local read is an independent
  // second layer on top of that freeze, not a substitute for it.
  const host = githubForward.host;

  try {
    await resolveChecked(host, deps.lookup);
  } catch (err) {
    throw new GithubForwardHostRefusedError(err instanceof NetGuardError ? err.code : "dns_failed");
  }

  return host;
}

/** The shared back half: the model rule with the key as its non-enumerable header value. */
function rulesCarryingKey(
  plaintextKey: string,
  provider: ConnectionKind,
  host: string,
  input: { role: Role; product: Product; phase?: NetworkPolicyPhase },
): NetworkPolicyRule[] {
  // H14c-3-1 (CARRY-12): the key leaves this function in exactly one place,
  // the model rule's NON-ENUMERABLE `authValue`, which the sandbox port turns
  // into the SDK header transform for that host. The rules are never
  // serialised, logged or handed to the sandbox env; no other field, module
  // variable or return value carries it.
  const authValue = modelAuthValue(provider, plaintextKey);
  if (authValue === undefined) {
    throw new DecryptTenantKeyError();
  }
  const connection = toGithubForwardConnection(host, provider);
  const rules = networkPolicy(input.role, input.product, connection, input.phase ?? "run");
  for (const rule of rules) {
    if (rule.purpose === "model") Object.defineProperty(rule, "authValue", { value: authValue, enumerable: false });
  }
  return rules;
}
