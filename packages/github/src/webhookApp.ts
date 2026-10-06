import { INSTALLATION_APP_KINDS } from "@fx/core/src/repos/appKinds.js";
import type { AppCredentialsSource, AppKind } from "./appCredentials.js";

/**
 * D#2 H13e-2: which configured GitHub App sent a webhook delivery.
 *
 * GitHub stamps every delivery with `X-GitHub-Hook-Installation-Target-ID`,
 * the id of the App the hook belongs to
 * (https://docs.github.com/en/webhooks/webhook-events-and-payloads#delivery-headers).
 * The header is read BEFORE the body and before any HMAC: it only picks
 * which one secret the signature is later checked against. It is not
 * trusted for anything else, and the secrets are never tried in turn.
 *
 * Returns null (the caller answers 401) for a missing header, a header that
 * matches no configured kind, or when the configuration itself is refused
 * (a kind that is not configured has no id to match; two kinds sharing one
 * id make the source throw for every kind, so nothing matches).
 */
export interface SelectedWebhookApp {
  kind: AppKind;
  webhookSecret: string;
}

export function selectWebhookApp(credentials: AppCredentialsSource, targetIdHeader: string | null): SelectedWebhookApp | null {
  if (targetIdHeader === null || !/^[1-9][0-9]*$/.test(targetIdHeader)) return null;
  for (const kind of INSTALLATION_APP_KINDS) {
    let creds;
    try {
      creds = credentials(kind);
    } catch {
      // fx-swallow-ok: an app kind whose credentials are not configured cannot match this delivery; the next kind is tried
      continue;
    }
    if (creds.appId === targetIdHeader) return { kind, webhookSecret: creds.webhookSecret };
  }
  return null;
}
