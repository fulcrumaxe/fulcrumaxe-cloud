import { describe, expect, it } from "vitest";
import { GIT_TICKET_PATH, GitTicketMessage } from "@fulcrumaxe/runner-protocol";
import { createRunnerClient } from "../../src/daemon/client.js";
import { generateRunnerKey } from "../../src/keys.js";

const RUN = "0b1b6c52-7a43-4d5e-8a77-0f0f0f0f0f0f";
const seg = (s: string): string => Buffer.from(s).toString("base64url");
const TICKET = [seg("header-part"), seg("claims-part"), seg("signature-part")].join(".");

function clientAnswering(status: number, body: unknown) {
  const seen: Array<{ url: string; body: string }> = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    seen.push({ url: String(url), body: String(init.body) });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { client: createRunnerClient({ origin: "https://cloud.example.test", key: generateRunnerKey(), now: () => new Date(), fetchFn }), seen };
}

describe("the signed git-ticket call", () => {
  it("sends only the run and the generation to the constant path, and returns the ticket as the reply gave it", async () => {
    const { client, seen } = clientAnswering(200, { ticket: TICKET, expires_at: "2026-10-08T12:05:00.000Z", proxy_origin: "https://relay.example.test" });
    expect(await client.gitTicket(RUN, 2)).toEqual({ kind: "ticket", ticket: TICKET, expiresAt: "2026-10-08T12:05:00.000Z", proxyOrigin: "https://relay.example.test" });
    expect(seen[0]!.url).toBe(`https://cloud.example.test${GIT_TICKET_PATH}`);
    expect(GitTicketMessage.parse(JSON.parse(seen[0]!.body))).toEqual({ run_id: RUN, lease_generation: 2 });
  });

  it("a 409 stop is a stop, other statuses keep their number, and a reply no schema describes is invalid_reply", async () => {
    expect(await clientAnswering(409, { continue: false, reason: "stale_generation" }).client.gitTicket(RUN, 1)).toEqual({ kind: "stop", reason: "stale_generation" });
    expect(await clientAnswering(401, { error: "unauthorized" }).client.gitTicket(RUN, 1)).toMatchObject({ kind: "error", status: 401 });
    expect(await clientAnswering(403, { error: "not_cloud_verified" }).client.gitTicket(RUN, 1)).toMatchObject({ kind: "error", status: 403 });
    expect(await clientAnswering(200, { ticket: TICKET }).client.gitTicket(RUN, 1)).toMatchObject({ kind: "error", status: 200, code: "invalid_reply" });
    expect(await clientAnswering(200, { ticket: "not-a-jws", expires_at: "2026-10-08T12:05:00.000Z", proxy_origin: "https://relay.example.test" }).client.gitTicket(RUN, 1)).toMatchObject({ code: "invalid_reply" });
    expect(await clientAnswering(200, { ticket: TICKET, expires_at: "2026-10-08T12:05:00.000Z", proxy_origin: "http://relay.example.test" }).client.gitTicket(RUN, 1)).toMatchObject({ code: "invalid_reply" });
  });
});
