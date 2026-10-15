import { UNKNOWN_HOST, type HostResolver, type Queryable, type ResolvedHost } from "./resolver.js";

/** The columns `resolve_host` returns (migration 0803), in order. A test pins this list against the live function. */
export const RESOLVE_HOST_COLUMNS = [
  "partner_id",
  "product_name",
  "logo_url",
  "color_primary",
  "color_accent",
  "support_email",
  "terms_url",
  "privacy_url",
  "state",
] as const;

const text = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/**
 * Reads `resolve_host(hostname)` as the web tier's app_user login. The function is SECURITY DEFINER and needs no tenant context.
 * Anything the database returns that is not a recognisable `active` or `suspended` row is treated as unknown (fail closed).
 */
export class PgHostResolver implements HostResolver {
  constructor(private readonly db: Queryable) {}

  async resolve(hostname: string): Promise<ResolvedHost> {
    const { rows } = await this.db.query(`SELECT ${RESOLVE_HOST_COLUMNS.join(", ")} FROM resolve_host($1)`, [hostname]);
    const row = rows[0];
    if (!row) return UNKNOWN_HOST;
    const partnerId = text(row.partner_id);
    if (row.state === "suspended" && partnerId) {
      return { ...UNKNOWN_HOST, partnerId, state: "suspended" };
    }
    if (row.state === "active" && partnerId) {
      return {
        partnerId,
        productName: text(row.product_name),
        logoUrl: text(row.logo_url),
        colorPrimary: text(row.color_primary),
        colorAccent: text(row.color_accent),
        supportEmail: text(row.support_email),
        termsUrl: text(row.terms_url),
        privacyUrl: text(row.privacy_url),
        state: "active",
      };
    }
    return UNKNOWN_HOST;
  }
}
