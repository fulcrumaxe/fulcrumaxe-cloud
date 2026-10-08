import { mintAppJwt } from "./installationToken.js";

/**
 * D#6 R2b-3f: the login GitHub shows as the author of a pull request our App opens: the App's slug plus `[bot]`. The `done` route reuses an
 * open pull request on a run's branch only if this is its author (anything else is left alone), and the slug is not in our configuration, so
 * it is asked of GitHub: `GET /app` with the App's own JWT answers the App's `id` and `slug`. The answer is refused unless its `id` is the
 * App we asked as, and unless the slug has the shape GitHub gives slugs, so a bad answer cannot widen who counts as "us".
 *
 * The JWT lives in this function only. Every error is a fixed message with no cause: nothing here echoes a key, a token or a response.
 * A login is remembered for `LOGIN_TTL_MS` per App (an App is renamed almost never, and a rename only makes reuse fail closed).
 */
export const LOGIN_TTL_MS = 10 * 60_000;
const SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export class AppBotLoginError extends Error {
  constructor() {
    super("appBotLogin: the app's login could not be read");
    this.name = "AppBotLoginError";
  }
}

export interface AppBotLoginInput {
  appId: string;
  privateKeyPem: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const remembered = new Map<string, { login: string; until: number }>();

/** Forgets every remembered login (tests). */
export function clearAppBotLoginCache(): void {
  remembered.clear();
}

export async function readAppBotLogin(input: AppBotLoginInput): Promise<string> {
  const now = (input.now ?? Date.now)();
  const hit = remembered.get(input.appId);
  if (hit && hit.until > now) return hit.login;
  try {
    const jwt = await mintAppJwt(input.appId, input.privateKeyPem, input.now);
    const res = await (input.fetchImpl ?? fetch)("https://api.github.com/app", {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${jwt}`, "x-github-api-version": "2022-11-28", "user-agent": "fulcrumaxe-cloud" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status !== 200) throw new AppBotLoginError();
    const body = (await res.json()) as { id?: unknown; slug?: unknown } | null;
    if (!body || String(body.id) !== input.appId || typeof body.slug !== "string" || !SLUG.test(body.slug)) throw new AppBotLoginError();
    const login = `${body.slug}[bot]`;
    remembered.set(input.appId, { login, until: now + LOGIN_TTL_MS });
    return login;
  } catch {
    // fx-swallow-ok: the cause can carry a key, a token or a response; only the fixed error survives
    throw new AppBotLoginError();
  }
}
