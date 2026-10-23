import { describe, expect, it } from "vitest";
import { opsAlertSinkFromEnv, type OpsAlertFetch } from "../lib/opsAlertSink";

const ENV = { FX_STALL_ALERT_REPO: "acme/ops", FX_STALL_ALERT_ISSUE: "12", FX_STALL_ALERT_TOKEN: "tok_secret", FX_STALL_ALERT_MENTION: "oncall" };

/**
 * A strict stand-in for POST /repos/{repo}/issues/{n}/comments. It refuses what GitHub refuses that this code can get wrong: a request with no
 * User-Agent (403), no or wrong bearer token (401), an unknown repo or issue (404), a body that is not JSON with a non-empty string `body` (422).
 * What it cannot reproduce: real TLS, rate limits and the token's repository scope.
 */
function strictGithub(opts: { token?: string; status?: number } = {}) {
  const posts: { url: string; body: string }[] = [];
  const doFetch: OpsAlertFetch = async (url, init) => {
    if (!init.headers["User-Agent"]) return { ok: false, status: 403 };
    if (init.headers.Authorization !== `Bearer ${opts.token ?? "tok_secret"}`) return { ok: false, status: 401 };
    if (url !== "https://api.github.com/repos/acme/ops/issues/12/comments") return { ok: false, status: 404 };
    if (init.method !== "POST") return { ok: false, status: 404 };
    let parsed: unknown;
    try {
      parsed = JSON.parse(init.body);
    } catch {
      return { ok: false, status: 400 };
    }
    const body = (parsed as { body?: unknown }).body;
    if (typeof body !== "string" || body === "") return { ok: false, status: 422 };
    if (!init.signal) return { ok: false, status: 500 };
    posts.push({ url, body });
    return { ok: opts.status === undefined, status: opts.status ?? 201 };
  };
  return { doFetch, posts };
}

describe("opsAlertSinkFromEnv", () => {
  it("is off unless repo, issue and token are all present and well formed", () => {
    expect(opsAlertSinkFromEnv({}, strictGithub().doFetch)).toBeNull();
    expect(opsAlertSinkFromEnv({ ...ENV, FX_STALL_ALERT_TOKEN: "" }, strictGithub().doFetch)).toBeNull();
    expect(opsAlertSinkFromEnv({ ...ENV, FX_STALL_ALERT_REPO: "not a repo" }, strictGithub().doFetch)).toBeNull();
    expect(opsAlertSinkFromEnv({ ...ENV, FX_STALL_ALERT_REPO: "acme/ops/../../x" }, strictGithub().doFetch)).toBeNull();
    expect(opsAlertSinkFromEnv({ ...ENV, FX_STALL_ALERT_ISSUE: "0" }, strictGithub().doFetch)).toBeNull();
    expect(opsAlertSinkFromEnv({ ...ENV, FX_STALL_ALERT_ISSUE: "12/../3" }, strictGithub().doFetch)).toBeNull();
  });

  it("posts a problem notice with the mention and a recovery notice without it", async () => {
    const gh = strictGithub();
    const sink = opsAlertSinkFromEnv(ENV, gh.doFetch)!;
    await sink.send({ kind: "stalled", text: "Stalled: job" });
    await sink.send({ kind: "recovered", text: "Recovered: job" });
    expect(gh.posts.map((p) => p.body)).toEqual(["@oncall Stalled: job", "Recovered: job"]);
  });

  it("ignores a malformed mention instead of posting it", async () => {
    const gh = strictGithub();
    const sink = opsAlertSinkFromEnv({ ...ENV, FX_STALL_ALERT_MENTION: "x\n@everyone" }, gh.doFetch)!;
    await sink.send({ kind: "stalled", text: "t" });
    expect(gh.posts[0]?.body).toBe("t");
  });

  it("a refused post throws a fixed message that carries neither the token nor a body", async () => {
    const sink = opsAlertSinkFromEnv(ENV, strictGithub({ token: "other" }).doFetch)!;
    const err = await sink.send({ kind: "stalled", text: "t" }).catch((e: Error) => e);
    expect((err as Error).message).toBe("ops alert sink: GitHub answered 401");
    expect((err as Error).message).not.toContain("tok_secret");
  });
});
