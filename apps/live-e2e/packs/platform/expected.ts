/**
 * What the deployment must serve, written out here on purpose rather than imported from apps/web: a live check
 * that shared the app's own constants would pass whatever the app changed to. When the app changes one of these
 * deliberately, this file changes in the same PR.
 */
export const EXPECTED_SHELL_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'; form-action 'self' https://github.com; upgrade-insecure-requests; report-to csp",
  "reporting-endpoints": 'csp="/api/csp-report"',
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

export const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

/**
 * What `/api/health` must say, by target (T5). Staging identifies itself fully; production gives `deploy_env`
 * only (no project id, no commit). Returns the violations; empty means the body is as expected.
 */
export function healthViolations(body: unknown, target: { name: string; project_id: string }): string[] {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return ["body is not an object"];
  const b = body as Record<string, unknown>;
  const out: string[] = [];
  if (b.ok !== true) out.push("ok is not true");
  if (b.config !== "ok") out.push("config is not ok");
  if (b.planData !== "ok" && b.planData !== "missing") out.push("planData is neither ok nor missing");
  if (b.deploy_env !== target.name) out.push(`deploy_env is not ${target.name}`);
  const keys = Object.keys(b).sort().join(",");
  if (target.name === "staging") {
    if (b.project_id !== target.project_id) out.push("project_id is not the staging project's");
    if (b.commit !== null && typeof b.commit !== "string") out.push("commit is neither a string nor null");
    if (keys !== "commit,config,deploy_env,ok,planData,project_id") out.push(`unexpected keys: ${keys}`);
  } else if (keys !== "config,deploy_env,ok,planData") {
    out.push(`unexpected keys: ${keys}`);
  }
  return out;
}

/** Exact bodies of the static contract routes. `/api/health` differs by target and is checked by `healthViolations`. */
export const EXPECTED_BODIES: Record<string, unknown> = {
  "/api/mode": {
    mode: "cloud",
    profile: "cloud",
    features: { presence: false, liveEntitlements: false, crdt: false, messages: false, updates: false },
  },
  "/api/system/mode": { cloud: true },
  "/api/branding": {
    page_title: "fulcrumaxe",
    product_name: "fulcrumaxe cloud",
    os_name: "fulcrumaxe cloud",
    system_tag: "fulcrumaxe cloud",
    copyright: "© fulcrumaxe",
    welcome_message: "Welcome to fulcrumaxe cloud.",
  },
};

/** The same-origin `/s/...` asset URLs an index page references (src and href), resolved against its base. */
export function shellAssetPaths(html: string, pageUrl: string): string[] {
  const page = new URL(pageUrl);
  const base = /<base[^>]*\shref="([^"]+)"/i.exec(html)?.[1];
  const baseUrl = new URL(base ?? "/", page);
  const found = new Set<string>();
  for (const m of html.matchAll(/<(?:script|link|img)\b[^>]*?\s(?:src|href)="([^"]+)"/gi)) {
    const u = new URL(m[1] as string, baseUrl);
    if (u.origin === page.origin && u.pathname.startsWith("/s/")) found.add(u.pathname + u.search);
  }
  return [...found].sort();
}
