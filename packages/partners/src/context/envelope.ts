import { PartnerOverride } from "@fx/design";
import { z } from "zod";
import { STATIC_BRAND } from "./staticBrand.js";

/**
 * The one data shape the partner branding path serves. A fixed envelope, `.strict()` so no other key can ride along, and
 * `colors` must pass `PartnerOverride` (packages/design), the single sanctioned way a partner's colours reach the page. The
 * schema test (test/envelope.test.ts) pins the exact key set.
 *
 * `logo_url` is always null for now. `resolve_host` returns the logo's storage key, and what a URL for that key is (storage and
 * serving) belongs to the row that builds logo upload; no URL is invented here. The shell applies a null logo as "none".
 */
export const PartnerBrandingEnvelope = z
  .object({
    page_title: z.string(),
    product_name: z.string(),
    os_name: z.string(),
    system_tag: z.string(),
    copyright: z.string(),
    welcome_message: z.string(),
    logo_url: z.string().nullable(),
    support_email: z.string().nullable(),
    terms_url: z.string().nullable(),
    privacy_url: z.string().nullable(),
    state: z.enum(["active", "suspended"]),
    colors: PartnerOverride,
  })
  .strict();
export type PartnerBrandingEnvelope = z.infer<typeof PartnerBrandingEnvelope>;

/** The envelope's keys, in the order they are written. */
export const ENVELOPE_KEYS = [
  "page_title",
  "product_name",
  "os_name",
  "system_tag",
  "copyright",
  "welcome_message",
  "logo_url",
  "support_email",
  "terms_url",
  "privacy_url",
  "state",
  "colors",
] as const;

/** Hex colours only (#rgb, #rgba, #rrggbb, #rrggbbaa). Anything else is dropped rather than passed on to a stylesheet. */
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;

/** An absolute https URL without credentials, or null. A link the footer will show must not be `javascript:` or `data:`. */
export function httpsUrlOrNull(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || !url.hostname) return null;
    return url.toString();
  } catch {
    // fx-swallow-ok: a value that does not parse as a URL is simply not a usable link
    return null;
  }
}

export function emailOrNull(value: string | null): string | null {
  return value && value.length <= 254 && EMAIL.test(value) ? value : null;
}

/**
 * Maps the stored brand colours onto `PartnerOverride`: `color_primary` is `accent` and `color_accent` is `accentFaint`.
 * (The shell applier of the next row may revise this mapping.) A value that is not a hex colour is left out.
 */
export function colorsFor(primary: string | null, accent: string | null): z.infer<typeof PartnerOverride> {
  const colors: Record<string, string> = {};
  if (primary && HEX_COLOR.test(primary)) colors.accent = primary;
  if (accent && HEX_COLOR.test(accent)) colors.accentFaint = accent;
  return PartnerOverride.parse(colors);
}

/** What a suspended partner's host is told: our own brand strings and `state: suspended`, none of the partner's text or colours. */
export function suspendedEnvelope(): PartnerBrandingEnvelope {
  return PartnerBrandingEnvelope.parse({
    ...STATIC_BRAND,
    logo_url: null,
    support_email: null,
    terms_url: null,
    privacy_url: null,
    state: "suspended",
    colors: {},
  });
}
