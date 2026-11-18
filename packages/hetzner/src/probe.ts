import { generateKeyPairSync, randomUUID } from "node:crypto";
import { HetznerError, createHetznerClient, type HetznerOptions } from "./client.js";

/** The label every server the cloud creates carries (`fx-managed=1`); a server without it was not made by us. */
export const MANAGED_LABEL = "fx-managed";
export const MANAGED_LABEL_VALUE = "1";

/** What checking a token found. `invalid`: Hetzner refused it (401). `read_only`: it reads but cannot write (403 on the probe key). `unreachable`: no answer we can rely on. */
export type HetznerProbeResult = { verdict: "ok"; unlabelledServers: number } | { verdict: "invalid" | "read_only" | "unreachable" };
export interface HetznerTokenProbe { check(token: string): Promise<HetznerProbeResult> }

/** A throwaway ed25519 public key in OpenSSH form: Hetzner refuses a key it cannot parse and a second key with the same fingerprint, so each probe makes its own. */
function throwawayPublicKey(): string {
  const x = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x as string;
  const raw = Buffer.from(x, "base64url");
  const field = (b: Buffer): Buffer => Buffer.concat([Buffer.from([0, 0, 0, b.length]), b]);
  return `ssh-ed25519 ${Buffer.concat([field(Buffer.from("ssh-ed25519")), field(raw)]).toString("base64")} fx-probe`;
}

/**
 * Asks Hetzner what a token can do, before anything is saved: a read (`GET /servers?per_page=1`), a write (one SSH key `fx-probe-<uuid>` made and deleted again), and a list
 * of the project's servers to count those we did not make. The token stays in the client closure; no result carries it. A key that was made but could not be deleted
 * is `unreachable`: a delete is a write too, so the token is not proven, and the person tries again.
 *
 * Orphan case: when the delete fails, the throwaway key stays in the person's Hetzner project. It is inert (a public key whose private half was never kept, used by
 * no server) and it is labelled `fx-probe=1` and named `fx-probe-<uuid>`, so a later sweep can list it by that label and remove it. Each retry makes its own key.
 */
export function createHetznerCredentialProbe(options: Omit<HetznerOptions, "token"> = {}): HetznerTokenProbe {
  return {
    async check(token) {
      let client: ReturnType<typeof createHetznerClient>;
      try { client = createHetznerClient({ ...options, token }); } catch {
        // fx-swallow-ok: a token the client refuses to hold is not one Hetzner issues; the error text is fixed and names no value
        return { verdict: "invalid" };
      }
      try {
        try { await client.verifyToken(); } catch (e) {
          if (e instanceof HetznerError && (e.code === "unauthorized" || e.code === "forbidden")) return { verdict: "invalid" };
          throw e;
        }
        const probe = { name: `fx-probe-${randomUUID()}`, publicKey: throwawayPublicKey(), labels: { "fx-probe": "1" } };
        let key: { id: number };
        try { key = await client.createSshKey(probe); } catch (e) {
          if (e instanceof HetznerError && e.code === "forbidden") return { verdict: "read_only" };
          throw e;
        }
        for (let attempt = 0; ; attempt++) {
          try { await client.deleteSshKey(key.id); break; } catch (e) {
            if (attempt >= 1) throw e;
          }
        }
        const servers = await client.listServers();
        return { verdict: "ok", unlabelledServers: servers.filter((s) => s.labels[MANAGED_LABEL] !== MANAGED_LABEL_VALUE).length };
      } catch {
        // fx-swallow-ok: every other failure (a network error, a rate limit, a shape we do not know) is "could not check"; nothing of the error is kept
        return { verdict: "unreachable" };
      }
    },
  };
}
