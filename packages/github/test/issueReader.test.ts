import { generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { InstallationTokenCache, type AccessTokenRequester } from "../src/installationToken.js";
import { createIssueReader, MAX_LABEL_ACTORS } from "../src/issueReader.js";
import { strictGithubFetch } from "./helpers/strictGithub.js";

/** D#483 P1: the issue reader against a strict GitHub fetch fake and the real token minter (throwaway App key). */
const REQUEST = { repoId: "11111111-1111-4111-8111-111111111111", owner: "acme", name: "widgets", number: 7 };
let privateKeyPem: string;
beforeAll(() => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  privateKeyPem = privateKey as unknown as string;
});

const json = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Route = (url: string) => Response | Error | undefined;

function setup(route: Route, opts: { noInstallation?: boolean; mintFails?: boolean } = {}) {
  const urls: string[] = [];
  const requested: Array<Parameters<AccessTokenRequester>[0]> = [];
  const requester: AccessTokenRequester = async (params) => {
    requested.push(params);
    if (opts.mintFails) throw new Error("mint exploded");
    return { token: "ghs_faketoken", expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
  };
  const fetchImpl = strictGithubFetch((async (url: string) => {
    urls.push(url);
    const r = route(url);
    if (r instanceof Error) throw r;
    if (!r) throw new Error(`unexpected fetch ${url}`);
    return r;
  }) as unknown as typeof fetch);
  const read = createIssueReader({
    resolveInstallation: async () => (opts.noInstallation ? null : { installationId: 777, appKind: "team" }),
    appCredentials: () => ({ appId: "app-1", privateKeyPem, webhookSecret: "unused" }),
    requester,
    cache: new InstallationTokenCache(),
    fetchImpl,
  });
  return { read, urls, requested };
}

const ISSUE = { title: "T", body: "B", state: "open", user: { login: "owner-1" }, labels: [{ name: "bug" }, { name: "enhancement" }, "plain"] };
const base = "https://api.github.com/repos/acme/widgets";

describe("createIssueReader", () => {
  it("reads title, body, author, state and labels with a read-only issues token for one repo", async () => {
    const t = setup((u) => (u === `${base}/issues/7` ? json(200, ISSUE) : u.startsWith(`${base}/issues/7/events`) ? json(200, []) : undefined));
    const r = await t.read(REQUEST);
    expect(r).toEqual({
      status: "found",
      title: "T",
      body: "B",
      login: "owner-1",
      state: "open",
      labels: [
        { name: "bug", actorLogin: null, actorPermission: null },
        { name: "enhancement", actorLogin: null, actorPermission: null },
        { name: "plain", actorLogin: null, actorPermission: null },
      ],
    });
    expect(t.requested[0]).toMatchObject({ installationId: 777, repositories: ["widgets"], permissions: { metadata: "read", issues: "read" } });
    expect(Object.keys(t.requested[0]!.permissions).sort()).toEqual(["issues", "metadata"]);
  });

  it("reports who applied each current label (the newest labeled event, none after an unlabel) and that actor's real permission", async () => {
    const t = setup((u) => {
      if (u === `${base}/issues/7`) return json(200, ISSUE);
      if (u.startsWith(`${base}/issues/7/events`))
        return json(200, [
          { event: "labeled", label: { name: "bug" }, actor: { login: "rando" } },
          { event: "labeled", label: { name: "bug" }, actor: { login: "maint" } },
          { event: "labeled", label: { name: "enhancement" }, actor: { login: "rando" } },
          { event: "unlabeled", label: { name: "enhancement" }, actor: { login: "maint" } },
          { event: "labeled", label: { name: "enhancement" }, actor: { login: "rando" } },
          { event: "commented", actor: { login: "x" } },
        ]);
      if (u === `${base}/collaborators/maint/permission`) return json(200, { role_name: "maintain", permission: "write" });
      if (u === `${base}/collaborators/rando/permission`) return json(404, { message: "Not Found" });
      return undefined;
    });
    const r = await t.read(REQUEST);
    expect(r.status === "found" && r.labels).toEqual([
      { name: "bug", actorLogin: "maint", actorPermission: "maintain" },
      { name: "enhancement", actorLogin: "rando", actorPermission: "none" },
      { name: "plain", actorLogin: null, actorPermission: null },
    ]);
  });

  it("reads permissions for at most MAX_LABEL_ACTORS actors; the rest stay unknown", async () => {
    const labels = Array.from({ length: MAX_LABEL_ACTORS + 2 }, (_, i) => ({ name: `l${i}` }));
    const t = setup((u) => {
      if (u === `${base}/issues/7`) return json(200, { ...ISSUE, labels });
      if (u.startsWith(`${base}/issues/7/events`)) return json(200, labels.map((l, i) => ({ event: "labeled", label: { name: l.name }, actor: { login: `a${i}` } })));
      if (u.includes("/collaborators/")) return json(200, { role_name: "admin" });
      return undefined;
    });
    const r = await t.read(REQUEST);
    expect(t.urls.filter((u) => u.includes("/collaborators/"))).toHaveLength(MAX_LABEL_ACTORS);
    expect(r.status === "found" && r.labels.filter((l) => l.actorPermission === null)).toHaveLength(2);
  });

  it("fails closed when the event cap is hit with a full page: no label has an actor, and no permission is read", async () => {
    const filler = (n: number) => Array.from({ length: n }, () => ({ event: "commented", actor: { login: "x" } }));
    const t = setup((u) => {
      if (u === `${base}/issues/7`) return json(200, ISSUE);
      if (u.includes("/issues/7/events?per_page=100&page=1")) return json(200, [{ event: "labeled", label: { name: "bug" }, actor: { login: "maint" } }, ...filler(99)]);
      if (u.includes("/issues/7/events")) return json(200, filler(100));
      return undefined;
    });
    const r = await t.read(REQUEST);
    expect(t.urls.filter((u) => u.includes("/events"))).toHaveLength(3);
    expect(t.urls.some((u) => u.includes("/collaborators/"))).toBe(false);
    expect(r.status === "found" && r.labels.every((l) => l.actorLogin === null && l.actorPermission === null)).toBe(true);
  });

  it("a last page that is not full is not a cap hit: actors are kept", async () => {
    const filler = (n: number) => Array.from({ length: n }, () => ({ event: "commented", actor: { login: "x" } }));
    const t = setup((u) => {
      if (u === `${base}/issues/7`) return json(200, ISSUE);
      if (u.endsWith("&page=1")) return json(200, filler(100));
      if (u.endsWith("&page=2")) return json(200, filler(100));
      if (u.endsWith("&page=3")) return json(200, [{ event: "labeled", label: { name: "bug" }, actor: { login: "maint" } }]);
      if (u.includes("/collaborators/maint/")) return json(200, { role_name: "maintain" });
      return undefined;
    });
    const r = await t.read(REQUEST);
    expect(r.status === "found" && r.labels[0]).toEqual({ name: "bug", actorLogin: "maint", actorPermission: "maintain" });
  });

  it("a 404 or 410 on the issue is missing; an issue with no author login is missing", async () => {
    for (const s of [404, 410]) expect(await setup(() => json(s, { message: "Not Found" })).read(REQUEST)).toEqual({ status: "missing" });
    expect(await setup(() => json(200, { ...ISSUE, user: null })).read(REQUEST)).toEqual({ status: "missing" });
  });

  it("an issue with no labels makes no events call", async () => {
    const t = setup((u) => (u === `${base}/issues/7` ? json(200, { ...ISSUE, labels: [] }) : undefined));
    await t.read(REQUEST);
    expect(t.urls).toEqual([`${base}/issues/7`]);
  });

  it.each([500, 429, 403])("a %s from the issue, the events or a permission read throws a fixed message", async (status) => {
    await expect(setup(() => json(status)).read(REQUEST)).rejects.toThrow(/issueReader: issue_failed/);
    await expect(setup((u) => (u.endsWith("/issues/7") ? json(200, ISSUE) : json(status))).read(REQUEST)).rejects.toThrow(/issueReader: events_failed/);
    await expect(
      setup((u) => (u.endsWith("/issues/7") ? json(200, ISSUE) : u.includes("/events") ? json(200, [{ event: "labeled", label: { name: "bug" }, actor: { login: "secret-login" } }]) : json(status))).read(REQUEST),
    ).rejects.toThrow(/issueReader: permission_failed/);
  });

  it("a network error, a missing installation, a failed mint and bad coordinates all throw without echoing the login", async () => {
    await expect(setup(() => new Error("boom secret-login")).read(REQUEST)).rejects.toThrow("issueReader: request_failed");
    await expect(setup(() => json(200, ISSUE), { noInstallation: true }).read(REQUEST)).rejects.toThrow("issueReader: no_installation");
    await expect(setup(() => json(200, ISSUE), { mintFails: true }).read(REQUEST)).rejects.toThrow();
    await expect(setup(() => json(200, ISSUE)).read({ ...REQUEST, owner: "bad owner!" })).rejects.toThrow("issueReader: invalid_coordinates");
  });
});
