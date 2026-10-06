import type { NetworkPolicy } from "@vercel/sandbox";
import { startLocalTlsServer, type LocalTlsServer } from "../../../github/test/helpers/localTlsServer.js";

/**
 * A stand-in for the sandbox firewall, over Node's REAL connection path: a local HTTPS server with a
 * certificate for the names it answers to (the client verifies it against an explicit `ca`, with SNI and
 * hostname checks on), which applies an SDK `NetworkPolicy` to each request the way the platform documents it
 * before the request reaches an "origin":
 *   - a Host not listed under `allow` is refused (403) and never reaches the origin (deny by default);
 *   - for a listed host, a rule without `match` applies, and a rule's `transform[].headers` SET headers on the
 *     request, replacing any value the client sent under the same name (header names are case-insensitive).
 * What this cannot be faithful about, said plainly: the real firewall runs on Vercel's side, so the exact edge
 * cases (header casing on the wire, rule ordering with `match`, what it does with duplicate headers) are the
 * documented ones only. It cannot strip a header either: the SDK transform can only set.
 */
export interface PolicyFirewall extends LocalTlsServer {
  /** What the origin received, after the policy's transform: only requests the policy let through. */
  readonly origin: Array<{ host: string; headers: Record<string, string> }>;
}

type SdkRule = { transform?: Array<{ headers?: Record<string, string> }>; forwardURL?: string; response?: { statusCode: number } };

export async function startPolicyFirewall(policy: NetworkPolicy, names: string[]): Promise<PolicyFirewall> {
  const origin: PolicyFirewall["origin"] = [];
  const allow = typeof policy === "object" && policy.allow && !Array.isArray(policy.allow) ? (policy.allow as Record<string, SdkRule[]>) : {};
  const server = await startLocalTlsServer({ dnsNames: names }, (req) => {
    const host = (req.headers.host ?? "").split(":")[0]!;
    if (!Object.hasOwn(allow, host)) return { status: 403, body: "blocked by network policy" };
    const headers = { ...req.headers };
    for (const rule of allow[host]!) {
      for (const transform of rule.transform ?? []) {
        for (const [name, value] of Object.entries(transform.headers ?? {})) {
          for (const existing of Object.keys(headers)) if (existing.toLowerCase() === name.toLowerCase()) delete headers[existing];
          headers[name.toLowerCase()] = value;
        }
      }
    }
    origin.push({ host, headers });
    return { status: 200, body: "ok" };
  });
  return Object.assign(server, { origin });
}
