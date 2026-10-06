import type { NetworkPolicyRule } from "../../src/networkPolicy.js";

/** A fixed, non-secret fake header value (never a real key). */
export const FAKE_AUTH_VALUE = "Bearer fake-key-for-tests";

/** What `buildFirewallPolicy` returns for a run: the model rule also carries the key, non-enumerable. */
export function keyedPolicy(rules: NetworkPolicyRule[]): NetworkPolicyRule[] {
  for (const rule of rules) {
    if (rule.purpose === "model") Object.defineProperty(rule, "authValue", { value: FAKE_AUTH_VALUE, enumerable: false });
  }
  return rules;
}
