/**
 * Our own brand, as `GET /api/branding` serves it on our hosts (apps/web/app/api/branding/route.ts). That route stays
 * `force-static` and byte-identical, so this module cannot import from it; apps/web/test/branding-partner.test.ts compares this
 * object with that route's body, key for key, so the two cannot drift apart.
 *
 * Every host that is not an approved partner host gets exactly this object, with the same status and headers.
 */
export const STATIC_BRAND = Object.freeze({
  page_title: "fulcrumaxe",
  product_name: "fulcrumaxe cloud",
  os_name: "fulcrumaxe cloud",
  system_tag: "fulcrumaxe cloud",
  copyright: "© fulcrumaxe",
  welcome_message: "Welcome to fulcrumaxe cloud.",
});

export type StaticBrand = typeof STATIC_BRAND;
