// Sending a refusal probe through the API client: a fresh state, never followed, declared only.
import { randomBytes } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BYPASS_HEADER, ClientError, createClient, type ApiClient } from "../src/client.js";

const SECRET = `t1c${randomBytes(12).toString("hex")}`;

interface Probe {
  method: string;
  path: string;
  expect: number | number[];
}

/** The answer judged the way the pack runner judges it: refused only when the status is one of the expected 4xx. */
async function judge(client: ApiClient, probe: Probe): Promise<{ probe: Probe; status: number; refused: boolean }> {
  const res = await client.probe(probe);
  return { probe, status: res.status, refused: ([] as number[]).concat(probe.expect).includes(res.status) };
}

describe("sending a probe", () => {
  const seen: { method: string; path: string; headers: IncomingHttpHeaders }[] = [];
  let status = 401;
  let location: string | undefined;
  let server: Server;
  let other: Server;
  const seenOther: string[] = [];
  const originOf = (s: Server): string => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;

  beforeAll(async () => {
    other = createServer((req, res) => {
      seenOther.push(`${req.method} ${req.url}`);
      res.writeHead(200).end();
    });
    await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
    server = createServer((req, res) => {
      seen.push({ method: req.method ?? "", path: req.url ?? "", headers: req.headers });
      req.resume();
      res.writeHead(status, location === undefined ? {} : { location }).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  });
  afterAll(() => {
    server.close();
    other.close();
  });

  const probe: Probe = { method: "POST", path: "/api/internal/kick", expect: [401, 403] };
  const production = () => ({ target: "production" as const, targetOrigin: originOf(server) });
  const client = (extra: Partial<Parameters<typeof createClient>[0]> = {}) =>
    createClient({ origin: originOf(server), bypassSecret: SECRET, fence: production(), probes: [probe], ...extra });

  it("goes through the production fence, from a fresh state: no cookie, no Authorization, only the bypass header", async () => {
    seen.length = 0;
    status = 401;
    const signedIn = client({ ambientHeaders: { cookie: "__Host-fx_session=signed-in-value", authorization: "Bearer signed-in-token" } });
    const result = await judge(signedIn, probe);
    expect(result).toEqual({ probe, status: 401, refused: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.headers.cookie).toBeUndefined();
    expect(seen[0]?.headers.authorization).toBeUndefined();
    expect(seen[0]?.headers[BYPASS_HEADER]).toBe(SECRET);
  });

  it("an ordinary request on the same client does carry the ambient credentials (so the check above can fail)", async () => {
    seen.length = 0;
    status = 200;
    await client({ ambientHeaders: { cookie: "__Host-fx_session=signed-in-value" } }).get("/api/v1/thing");
    expect(seen[0]?.headers.cookie).toBe("__Host-fx_session=signed-in-value");
  });

  it("is refused unless the answer is one of the expected 4xx statuses: 200 is red, 401/403 are green, a 3xx throws", async () => {
    for (const [answer, refused] of [[200, false], [204, false], [500, false], [404, false], [401, true], [403, true]] as const) {
      status = answer;
      expect((await judge(client(), probe)).refused, String(answer)).toBe(refused);
    }
    status = 302;
    location = `${originOf(other)}/landed`;
    await expect(judge(client(), probe)).rejects.toThrow("never followed");
    location = undefined;
  });

  it("passes for each of 401, 403, 404, 405, 413 and 415 when the pack expects it", async () => {
    for (const answer of [401, 403, 404, 405, 413, 415]) {
      status = answer;
      const p: Probe = { method: "POST", path: "/api/internal/kick", expect: answer };
      expect((await judge(client({ probes: [p] }), p)).refused, String(answer)).toBe(true);
    }
  });

  it("never follows a redirect: a 3xx answer is an error and the other origin sees nothing", async () => {
    for (const answer of [301, 302, 303, 307, 308]) {
      status = answer;
      location = `${originOf(other)}/landed`;
      seenOther.length = 0;
      await expect(client().probe(probe), String(answer)).rejects.toThrow("never followed");
      expect(seenOther, String(answer)).toEqual([]);
    }
    location = undefined;
  });

  it("sends only a declared probe: another method or path throws before a socket opens", async () => {
    seen.length = 0;
    for (const p of [{ method: "DELETE", path: "/api/internal/kick" }, { method: "POST", path: "/api/other" }]) {
      await expect(client().probe(p), `${p.method} ${p.path}`).rejects.toThrow(ClientError);
    }
    await expect(createClient({ origin: originOf(server), fence: production() }).probe(probe)).rejects.toThrow("not a declared refusal probe");
    expect(seen).toEqual([]);
  });

  it("an ordinary request is still fenced even for a declared probe's method and path", async () => {
    seen.length = 0;
    await expect(client().request(probe.path, { method: "POST" })).rejects.toThrow("production-write-fence");
    expect(seen).toEqual([]);
  });
});
