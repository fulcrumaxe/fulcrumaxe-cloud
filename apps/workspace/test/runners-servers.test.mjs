// apps/workspace/test/runners-servers.test.mjs
//
// D#845 MC-10b1: the Servers tab's logic against a fake call(). The Hetzner credential (connect, read only, refused, down, remove), the create dialog (live catalog,
// the live quote, the disabled button, the second click after a price change, one key for an unknown outcome), every refusal as a fixed sentence, and nothing null,
// undefined or NaN on screen. The bodies are the contract fixtures packages/api/test/contract.test.ts checks against the routes' schemas. The DOM is in e2e/runners.spec.ts.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLEAN_REFUSALS, SERVER_BEING_CREATED, SIGN_IN_AGAIN, TIER_NOTICE, TOO_MANY_TRIES, UNKNOWN_OUTCOME, availableIn, catalogUrl, connectSentence, connectedText, createCreator, createSentence, createServers, moneyText, offeredIn, priceLine, quoteUrl, readCatalog,
  readCredential, readQuote, readServers, removeSentence, specsText, totalText, unlabelledText, SERVER_WORDS, HETZNER_STEPS,
} from "../apps/runners/runners-fleet.js";

const fixture = (op, name) => JSON.parse(readFileSync(new URL(`../../../packages/api/fixtures/v1/${op}/${name}`, import.meta.url), "utf8"));
const CATALOG_ALL = fixture("getHetznerCatalog", "200-all-locations.json");
const CATALOG_FSN1 = fixture("getHetznerCatalog", "200-fsn1.json");
const CATALOG_NBG1 = fixture("getHetznerCatalog", "200-nbg1.json");
const QUOTE = fixture("quoteHetznerServer", "200-cx32-fsn1.json");
const CREATED = fixture("createHetznerServer", "201-creating.json");
const TOKEN = ["hz", "T0kenT0kenT0kenT0kenT0kenT0kenT0kenT0ken1234a1b2"].join("_"); // gitleaks:allow
const fail = (status, code, extra = {}) => Object.assign(new Error("server text that must never be shown"), { status, code, retryAfter: 0, ...extra });
const catalogFor = (url) => (url.includes("location=nbg1") ? CATALOG_NBG1 : url.includes("location=fsn1") ? CATALOG_FSN1 : CATALOG_ALL);
const clean = (v) => expect(JSON.stringify(v)).not.toMatch(/null|undefined|NaN/);

describe("the Hetzner credential", () => {
  it("reads connected, invalid and none from the contract fixtures, and only the last four characters of a hint", () => {
    expect(readCredential(fixture("getHetznerCredential", "200-connected.json"))).toEqual({ status: "connected", hint: "a1b2" });
    expect(readCredential(fixture("getHetznerCredential", "200-invalid.json"))).toEqual({ status: "invalid", hint: "a1b2" });
    expect(readCredential(fixture("getHetznerCredential", "200-none.json"))).toEqual({ status: "none", hint: "" });
    expect(readCredential({ status: "connected", token_hint: TOKEN }).hint).toBe("a1b2"); // even a misbehaving answer never puts more of a token on screen
    expect(readCredential({ status: "ok" })).toBeNull();
    expect(readCredential(null)).toBeNull();
    expect(connectedText({ status: "connected", hint: "a1b2" })).toBe("Connected (token …a1b2)");
    expect(connectedText({ status: "connected", hint: "" })).toBe("Connected");
    expect(unlabelledText(1)).toBe("This Hetzner project has 1 server we didn't create. We never change them.");
    expect(unlabelledText(2)).toBe("This Hetzner project has 2 servers we didn't create. We never change them.");
  });

  it("words every refusal of a connect by its closed code, never the server's words", () => {
    expect(connectSentence(fail(422, "token_read_only"))).toBe("This token is Read only. Nothing was saved. Make a Read & Write token and try again");
    expect(connectSentence(fail(422, "token_invalid"))).toBe("Hetzner refused this token. It may have been revoked");
    expect(connectSentence(fail(422, "invalid_token_format"))).toBe("That doesn't look like a Hetzner token. Check that you copied all of it");
    expect(connectSentence(fail(409, "already_connected"))).toBe("A token is already connected. Remove it first");
    expect(connectSentence(fail(503, "provider_unreachable"))).toBe("Hetzner didn't answer. Try again in a minute");
    expect(connectSentence(fail(503, "not_configured"))).toBe("Hetzner Cloud servers aren't available right now");
    expect(connectSentence(fail(503, "machine_kek_unset"))).toBe("Hetzner Cloud servers aren't available right now");
    expect(connectSentence(fail(403, "forbidden"))).toBe("Only owners and admins can connect Hetzner.");
    expect(connectSentence(fail(429, "rate_limited"))).toBe("That was too fast.");
    expect(connectSentence(fail(500, "server_error"))).toBe("That token couldn't be saved. Try again.");
    expect(connectSentence(undefined)).toBe("That token couldn't be saved. Try again.");
    expect(connectSentence(fail(422, "constructor"))).toBe("That token couldn't be saved. Try again."); // a code that is an Object property is not a sentence
    expect(removeSentence(fail(403, "forbidden"))).toBe("Only owners and admins can connect Hetzner.");
    expect(removeSentence(fail(500, "server_error"))).toBe("That token couldn't be removed. Try again.");
    expect(HETZNER_STEPS).toHaveLength(4);
  });

  it("loads, keeps the last good read when a later one fails, and reads a member's 403 as read-only", async () => {
    let answer = fixture("getHetznerCredential", "200-connected.json");
    const s = createServers({ call: async () => { if (answer instanceof Error) throw answer; return answer; } });
    expect(s.cred.status).toBe("loading");
    await s.loadCredential();
    expect(s.cred).toMatchObject({ status: "ready", value: { status: "connected", hint: "a1b2" } });
    answer = fail(503, "unavailable");
    await s.loadCredential();
    expect(s.cred.status).toBe("ready");
    answer = { status: "bogus" };
    await s.loadCredential();
    expect(s.cred.value.status).toBe("connected");
    const first = createServers({ call: async () => { throw fail(503, "unavailable"); } });
    await first.loadCredential();
    expect(first.cred.status).toBe("error");
    const member = createServers({ call: async () => { throw fail(403, "forbidden"); } });
    await member.loadCredential();
    expect(member.cred).toEqual({ status: "forbidden", value: null, unlabelled: null });
  });

  it("connects: the token goes in the body once, nothing of it is kept, and the unlabelled count shows", async () => {
    const calls = [];
    const s = createServers({ call: async (method, url, body) => { calls.push({ method, url, body }); return fixture("connectHetznerCredential", "201-connected.json"); } });
    expect(await s.connect(TOKEN)).toBe("");
    expect(calls).toEqual([{ method: "POST", url: "/api/v1/machine-credentials/hetzner", body: { token: TOKEN } }]);
    expect(s.cred).toEqual({ status: "ready", value: { status: "connected", hint: "a1b2" }, unlabelled: 2 });
    expect(JSON.stringify([s.cred, s.list, s.wait])).not.toContain(TOKEN.slice(0, 12));
  });

  it("a refused connect leaves the earlier state and says why: read only, refused, down, and a token already there", async () => {
    for (const [status, code, words] of [[422, "token_read_only", "Read only"], [422, "token_invalid", "refused"], [503, "provider_unreachable", "didn't answer"], [409, "already_connected", "already connected"]]) {
      let n = 0;
      const s = createServers({ call: async (method) => (method === "POST" ? (n++, Promise.reject(fail(status, code))) : fixture("getHetznerCredential", "200-none.json")) });
      const said = await s.connect(TOKEN);
      expect(said, code).toContain(words);
      expect(n).toBe(1);
      expect(s.cred.status, code).toBe("ready"); // the stored state is read again, so the screen shows what is true
      clean(said);
    }
  });

  it("a 429 holds a second connect for the wait", async () => {
    let posts = 0;
    const s = createServers({ call: async (method) => (method === "POST" ? (posts++, Promise.reject(fail(429, "rate_limited", { retryAfter: 7 }))) : fixture("getHetznerCredential", "200-none.json")) });
    expect(await s.connect(TOKEN)).toBe("That was too fast.");
    expect(s.wait).toBe(7);
    expect(await s.connect(TOKEN)).toBe("");
    expect(posts).toBe(1);
    s.stop();
  });

  it("removes: the token is gone and the servers stay; a token already gone counts as removed; a refusal says so", async () => {
    const calls = [];
    const s = createServers({ call: async (method, url) => { calls.push(method + " " + url); return method === "GET" ? fixture("listHetznerServers", "200-list.json") : null; } });
    expect(await s.remove()).toBe("");
    expect(calls).toEqual(["DELETE /api/v1/machine-credentials/hetzner", "GET /api/v1/machine-servers"]);
    expect(s.cred.value).toEqual({ status: "none", hint: "" });
    expect(s.list.items).toHaveLength(2);
    const gone = createServers({ call: async (m) => { if (m === "DELETE") throw fail(404, "not_connected"); return { servers: [] }; } });
    expect(await gone.remove()).toBe("");
    const refused = createServers({ call: async (m) => { if (m === "DELETE") throw fail(500, "server_error"); return { servers: [] }; } });
    expect(await refused.remove()).toBe("That token couldn't be removed. Try again.");
    expect(refused.cred.status).toBe("loading"); // nothing was claimed removed
  });
});

describe("the server list", () => {
  it("words every status and never shows a stored word, a null or an id", () => {
    const list = readServers(fixture("listHetznerServers", "200-list.json"));
    expect(list.map((x) => x.status)).toEqual([SERVER_WORDS.installing, SERVER_WORDS.ready]);
    expect(list[0]).toMatchObject({ name: "fx-5d1e7a32", size: "cx32", location: "fsn1" });
    clean(list);
    const odd = readServers({ servers: [{ id: "x", name: "  ", status: "mystery", server_type: null }, { name: "no id" }, null] });
    expect(odd).toMatchObject([{ id: "x", name: "Unnamed server", status: "Status not reported", size: "", location: "", created: "", state: "", runnerId: "", placed: [], placedKnown: false, cost: "" }]);
    clean(odd);
    for (const st of ["creating", "booting", "installing", "registering", "needs_claude_login", "ready", "offline", "deleting", "failed", "orphaned"]) expect(SERVER_WORDS[st], st).toMatch(/\S/);
    expect(readServers({})).toBeNull();
    expect(readServers({ servers: [] })).toEqual([]);
  });

  it("loads and keeps the last good list", async () => {
    let answer = fixture("listHetznerServers", "200-list.json");
    const s = createServers({ call: async () => { if (answer instanceof Error) throw answer; return answer; } });
    await s.loadList();
    expect(s.list.status).toBe("ready");
    answer = fail(503, "unavailable");
    await s.loadList();
    expect(s.list.items).toHaveLength(2);
    const member = createServers({ call: async () => { throw fail(403, "forbidden"); } });
    await member.loadList();
    expect(member.list).toEqual({ status: "forbidden", items: [] }); // the list is an owner and admin read
    const first = createServers({ call: async () => { throw fail(503, "unavailable"); } });
    await first.loadList();
    expect(first.list).toEqual({ status: "error", items: [] });
  });
});

describe("money and the quote", () => {
  it("adds in whole millionths and draws exactly, with two to six decimals", () => {
    expect(moneyText("EUR", "4.5101", "0.5950")).toBe("€5.1051");
    expect(moneyText("EUR", "4.5", "0.5")).toBe("€5.00");
    expect(moneyText("EUR", "0.1", "0.2")).toBe("€0.30"); // a float would say 0.30000000000000004
    expect(moneyText("EUR", "999999.999999", "0.000001")).toBe("€1000000.00");
    expect(moneyText("USD", "3")).toBe("USD 3.00");
    expect(totalText({ currency: "EUR", hourly_gross: "0.0070", monthly_gross: "4.5101", ipv4_monthly_gross: "0.5950" })).toBe("€5.1051 a month");
    expect(priceLine({ currency: "EUR", hourly_gross: "0.007", monthly_gross: "4.5101", ipv4_monthly_gross: "0.595" })).toBe("€4.5101 a month for the server and €0.595 a month for its IPv4");
  });

  it("takes the contract quote for exactly this size and place, and nothing else", () => {
    expect(readQuote(QUOTE, "cx32", "fsn1")).toEqual({ available: true, price: { currency: "EUR", hourly_gross: "0.0070", monthly_gross: "4.5101", ipv4_monthly_gross: "0.5950" } });
    expect(readQuote(QUOTE, "cx42", "fsn1")).toBeNull(); // a price for another size is not this one's
    expect(readQuote(QUOTE, "cx32", "nbg1")).toBeNull();
    expect(readQuote({ ...QUOTE, available: false }, "cx32", "fsn1").available).toBe(false);
    for (const bad of [{ monthly_gross: "NaN" }, { monthly_gross: "-1" }, { monthly_gross: 4.5 }, { ipv4_monthly_gross: undefined }, { currency: "eur" }, { hourly_gross: "1e3" }]) expect(readQuote({ ...QUOTE, ...bad }, "cx32", "fsn1"), JSON.stringify(bad)).toBeNull();
    expect(readQuote(null, "a", "b")).toBeNull();
  });

  it("says the standard tier in the cloud's own words (the quote's tier_notice), before any price", () => {
    expect(TIER_NOTICE).toBe(QUOTE.tier_notice);
    expect(TIER_NOTICE).toContain("Standard isolation");
  });
});

describe("the catalog", () => {
  it("reads the locations as names, the types with where each is offered, and the cloud's own Small and Medium picks", () => {
    const c = readCatalog(CATALOG_FSN1);
    expect(c.locations.map((l) => l.label)).toEqual(["Falkenstein, DE (fsn1)", "Nuremberg, DE (nbg1)", "Helsinki, FI (hel1)"]);
    expect(c.presets).toEqual({ small: "cx32", medium: "cx42" });
    expect(c.types.map((t) => t.name)).toEqual(["cx22", "ccx13", "cax21", "cx32", "cx42"]); // smallest first
    const cx42 = c.types.find((t) => t.name === "cx42");
    expect(availableIn(cx42, "fsn1")).toBe(true);
    expect(availableIn(cx42, "nbg1")).toBe(false);
    expect(offeredIn(cx42, "nbg1")).toBe(true);
    expect(offeredIn(c.types.find((t) => t.name === "cax21"), "hel1")).toBe(false);
    expect(specsText(cx42)).toBe("8 vCPU, 16 GB memory, 160 GB disk, x86");
    expect(specsText(c.types.find((t) => t.name === "cax21"))).toBe("4 vCPU, 8 GB memory, 80 GB disk, Arm");
    expect(readCatalog(CATALOG_ALL).presets).toEqual({ small: null, medium: null });
    expect(readCatalog(CATALOG_NBG1).presets).toEqual({ small: "cx32", medium: null });
    clean(c);
    expect(readCatalog({})).toBeNull();
    expect(readCatalog({ locations: [{ name: "x" }], server_types: [{ name: "t", cores: "4", memory_gb: 8, disk_gb: 80, locations: [] }] }).types).toEqual([]);
  });
});

/** A fake cloud: the catalog, the quote and the create, each answer replaceable, every call logged. */
function cloud(over = {}) {
  const log = [];
  const state = { quote: () => QUOTE, create: () => CREATED, catalog: catalogFor, ...over };
  const call = async (method, url, body, signal, opts) => {
    log.push({ method, url, body, key: opts && opts.idempotencyKey });
    const isQuote = url.startsWith("/api/v1/machine-servers/quote");
    const r = method === "POST" ? state.create(body, opts) : isQuote ? state.quote(url) : state.catalog(url);
    if (r instanceof Error) throw r;
    const asked = new URL(url, "https://cloud.test").searchParams; // the cloud prices the size and place that were asked for
    return isQuote ? { ...r, server_type: asked.get("server_type"), location: asked.get("location") } : r;
  };
  return { call, log, state };
}
const posts = (log) => log.filter((x) => x.method === "POST");
let uuids = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++uuids).padStart(12, "0")}`;

describe("the create dialog", () => {
  afterEach(() => vi.useRealTimers());

  it("opens on the first location, picks Small there, and has the live quote before the button is live", async () => {
    const { call, log } = cloud();
    const c = createCreator({ call, uuid });
    expect(c.state).toBeNull();
    await c.open();
    expect(log.map((x) => x.url)).toEqual([catalogUrl(), catalogUrl("fsn1"), quoteUrl("cx32", "fsn1")]);
    expect(c.state).toMatchObject({ location: "fsn1", type: "cx32", sending: false, error: "", quote: { status: "ready", available: true } });
    expect(c.state.catalog.presets).toEqual({ small: "cx32", medium: "cx42" });
    expect(totalText(c.state.quote.price)).toBe("€5.1051 a month");
    c.close();
    expect(c.state).toBeNull();
  });

  it("is disabled while the price loads and when it failed, never shows a guess, and retries", async () => {
    let n = 0;
    const { call } = cloud({ quote: () => (n++ === 0 ? fail(503, "price_unavailable") : QUOTE) });
    const c = createCreator({ call, uuid });
    await c.open();
    expect(c.state.quote).toEqual({ status: "error" });
    expect((await c.submit()).ok).toBe(false); // no quote, no create
    expect(c.state.error).toBe("");
    await c.requote();
    expect(c.state.quote.status).toBe("ready");
    const slow = createCreator({ call: (m, u) => (u.startsWith("/api/v1/machine-servers/quote") ? new Promise(() => {}) : cloud().call(m, u)), uuid });
    slow.open();
    await new Promise((r) => setTimeout(r, 10));
    expect(slow.state.quote.status).toBe("loading");
    expect((await slow.submit()).ok).toBe(false);
    const bad = createCreator({ call: cloud({ quote: () => ({ ...QUOTE, monthly_gross: "NaN" }) }).call, uuid });
    await bad.open();
    expect(bad.state.quote.status).toBe("error");
  });

  it("a size that is full in the place is shown as full, and a different place picks again", async () => {
    const { call, log } = cloud({ quote: (u) => ({ ...QUOTE, available: !u.includes("hel1") }) });
    const c = createCreator({ call, uuid });
    await c.open();
    await c.choose("cx42"); // available in fsn1
    expect(c.state.type).toBe("cx42");
    await c.pick("nbg1"); // cx42 is full in nbg1: the cloud's Small is picked instead
    expect(c.state.location).toBe("nbg1");
    expect(c.state.type).toBe("cx32");
    expect(c.state.catalog.presets).toEqual({ small: "cx32", medium: null });
    await c.pick("hel1");
    expect(c.state.quote).toMatchObject({ status: "ready", available: false });
    expect((await c.submit()).ok).toBe(false);
    expect(posts(log)).toHaveLength(0);
    expect(c.pick("hel1")).toBeUndefined(); // the same place again asks nothing
  });

  it("creates with the quoted price and one idempotency key, and a double press is one request", async () => {
    const { call, log } = cloud();
    const c = createCreator({ call, uuid });
    await c.open();
    const [a, b] = await Promise.all([c.submit(), c.submit()]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(posts(log)).toHaveLength(1);
    expect(posts(log)[0]).toMatchObject({ url: "/api/v1/machine-servers", body: { server_type: "cx32", location: "fsn1", quoted: { currency: "EUR", hourly_gross: "0.0070", monthly_gross: "4.5101", ipv4_monthly_gross: "0.5950" } } });
    expect(posts(log)[0].key).toMatch(/^00000000-0000-4000-8000-\d{12}$/);
    expect(Object.keys(posts(log)[0].body).sort()).toEqual(["location", "quoted", "server_type"]); // no SSH key and no name are sent
  });

  it("after a price change nothing is created, the new live price shows, and the next press is the second click", async () => {
    let live = QUOTE;
    const { call, log, state } = cloud({ quote: () => live, create: () => fail(409, "price_changed", { data: { live: {} } }) });
    const c = createCreator({ call, uuid });
    await c.open();
    live = { ...QUOTE, monthly_gross: "5.0000" };
    const first = await c.submit();
    expect(first).toEqual({ ok: false, code: "price_changed", unknown: false, stale: false });
    expect(c.state.error).toBe("The price changed. Check the new price and confirm again");
    expect(c.state.quote.price.monthly_gross).toBe("5.0000");
    expect(totalText(c.state.quote.price)).toBe("€5.595 a month");
    expect(posts(log)).toHaveLength(1); // nothing went out by itself
    state.create = () => CREATED;
    const second = await c.submit();
    expect(second.ok).toBe(true);
    expect(posts(log)).toHaveLength(2);
    expect(posts(log)[1].body.quoted.monthly_gross).toBe("5.0000");
    expect(posts(log)[1].key).not.toBe(posts(log)[0].key); // the first answer was an answer: a new key
  });

  it("words every create refusal, and the ones the cloud answers with a closed code keep the dialog open with nothing guessed", async () => {
    const where = "Falkenstein, DE (fsn1)";
    expect(createSentence(fail(409, "hetzner_resource_limit_exceeded"), where)).toBe("Hetzner's server limit for your Hetzner account was reached. Ask Hetzner to raise it, or delete a server");
    expect(createSentence(fail(409, "hetzner_resource_unavailable"), where)).toBe("That size isn't available in Falkenstein, DE (fsn1) right now. Choose another size or location");
    expect(createSentence(fail(409, "hetzner_placement_error"), where)).toBe(createSentence(fail(409, "hetzner_resource_unavailable"), where));
    expect(createSentence(fail(503, "price_unavailable"), where)).toBe("Prices couldn't be loaded");
    expect(createSentence(fail(409, "hetzner_unauthorized"), where)).toBe("Hetzner refused this token. It may have been revoked. Remove it and add a new one");
    expect(createSentence(fail(409, "credential_invalid"), where)).toContain("Hetzner refused this token");
    expect(createSentence(fail(409, "hetzner_forbidden"), where)).toBe("The Hetzner token can't do that. It needs Read & Write access");
    expect(createSentence(fail(503, "hetzner_unavailable"), where)).toBe("Hetzner didn't answer. Try again in a minute");
    expect(createSentence(fail(404, "not_connected"), where)).toBe("Hetzner isn't connected. Connect it first");
    expect(createSentence(fail(403, "forbidden"), where)).toBe("Only owners and admins can create a server.");
    expect(createSentence(fail(503, "not_configured"), where)).toBe("Hetzner Cloud servers aren't available right now");
    expect(createSentence(fail(429, "rate_limited"), where)).toBe("");
    expect(createSentence(fail(500, "server_error"), where)).toBe("That server couldn't be created. Try again.");
    expect(createSentence(undefined, where)).toBe("That server couldn't be created. Try again.");
    for (const code of ["hetzner_resource_limit_exceeded", "hetzner_unauthorized", "hetzner_unavailable", "hetzner_forbidden"]) {
      const { call, log } = cloud({ create: () => fail(409, code) });
      const c = createCreator({ call, uuid });
      await c.open();
      expect((await c.submit()).code).toBe(code);
      expect(c.state.error, code).toMatch(/\S/);
      expect(c.state.sending).toBe(false);
      expect(posts(log)).toHaveLength(1);
      clean(c.state.error);
    }
  });

  it("a full location refreshes the quote so the dialog says so", async () => {
    let available = true;
    const { call } = cloud({ quote: () => ({ ...QUOTE, available }), create: () => fail(409, "hetzner_resource_unavailable") });
    const c = createCreator({ call, uuid });
    await c.open();
    available = false;
    await c.submit();
    expect(c.state.error).toContain("That size isn't available in Falkenstein, DE (fsn1)");
    expect(c.state.quote.available).toBe(false);
  });

  it("a 429 keeps the button off for the wait, keeps the key, and says nothing the server wrote", async () => {
    const { call, log, state } = cloud({ create: () => fail(429, "rate_limited", { retryAfter: 9 }) });
    const c = createCreator({ call, uuid });
    await c.open();
    await c.submit();
    expect(c.state).toMatchObject({ error: TOO_MANY_TRIES, wait: 9, sending: false, locked: true });
    state.create = () => CREATED;
    expect((await c.submit()).ok).toBe(false);
    expect(posts(log)).toHaveLength(1);
    c.close();
  });

  it("an unknown outcome (offline, timeout, a 5xx) keeps the key, so a second press cannot make a second server; an answer ends it", async () => {
    for (const failure of [fail(0, "offline"), fail(0, "timeout"), fail(502, "server_error")]) {
      const { call, log, state } = cloud({ create: () => failure });
      const c = createCreator({ call, uuid });
      await c.open();
      const first = await c.submit();
      expect(first).toMatchObject({ ok: false, unknown: true, stale: false });
      expect(c.state.error).toBe(UNKNOWN_OUTCOME); // never "couldn't be created": the server may exist
      state.create = () => CREATED;
      await c.submit();
      expect(new Set(posts(log).map((x) => x.key)).size, String(failure.status)).toBe(1);
      expect(c.state.error).toBe("");
      expect(c.state.locked).toBe(false); // made: the attempt is over
    }
    const { call, log } = cloud({ create: () => fail(409, "hetzner_resource_limit_exceeded") });
    const c = createCreator({ call, uuid });
    await c.open();
    await c.submit();
    await c.submit();
    expect(new Set(posts(log).map((x) => x.key)).size).toBe(2);
  });

  it("the write deadline (an abort the page did not ask for) is an unknown outcome, never a quiet cancel", async () => {
    const ac = new AbortController();
    const timeout = Object.assign(new Error("aborted"), { name: "AbortError" });
    const { call, log, state } = cloud({ create: () => timeout });
    const c = createCreator({ call, signal: ac.signal, uuid });
    await c.open();
    expect(await c.submit()).toMatchObject({ ok: false, unknown: true });
    expect(c.state).toMatchObject({ sending: false, locked: true, error: UNKNOWN_OUTCOME });
    state.create = () => CREATED;
    expect((await c.submit()).ok).toBe(true);
    expect(new Set(posts(log).map((x) => x.key)).size).toBe(1);
  });

  it("timeout, then 409 in progress, then another press: still one key and one body", async () => {
    const answers = [fail(0, "timeout"), fail(409, "idempotency_in_progress"), fail(409, "idempotency_in_progress"), CREATED];
    const { call, log } = cloud({ create: () => answers.shift() });
    const c = createCreator({ call, uuid });
    await c.open();
    for (let i = 0; i < 3; i++) expect(await c.submit(), "press " + i).toMatchObject({ ok: false, unknown: true });
    expect(c.state.error).toBe(UNKNOWN_OUTCOME);
    expect((await c.submit()).ok).toBe(true);
    expect(posts(log)).toHaveLength(4);
    expect(new Set(posts(log).map((x) => x.key)).size).toBe(1);
    expect(new Set(posts(log).map((x) => JSON.stringify(x.body))).size).toBe(1);
  });

  it("after an unknown outcome the size and place are locked, and the retry sends the same body whatever is chosen", async () => {
    const { call, log, state } = cloud({ create: () => fail(0, "timeout") });
    const c = createCreator({ call, uuid });
    await c.open();
    await c.submit();
    const before = log.length;
    expect(c.state.locked).toBe(true);
    expect(c.choose("cx42")).toBeUndefined();
    expect(c.pick("nbg1")).toBeUndefined();
    expect(c.requote()).toBeUndefined();
    expect(c.state).toMatchObject({ type: "cx32", location: "fsn1" });
    expect(log.length).toBe(before); // nothing was read for a choice that was refused
    state.create = () => CREATED;
    await c.submit();
    expect(posts(log).map((x) => JSON.stringify(x.body))[1]).toBe(JSON.stringify(posts(log)[0].body));
  });

  it("closing and reopening after an unknown outcome keeps the key and the locked choice; a definite answer ends it", async () => {
    const { call, log, state } = cloud({ create: () => fail(0, "offline") });
    const c = createCreator({ call, uuid });
    await c.open();
    await c.choose("cx42");
    await c.submit();
    c.close();
    await c.open();
    expect(c.state).toMatchObject({ locked: true, type: "cx42", location: "fsn1", error: UNKNOWN_OUTCOME, sending: false, quote: { status: "ready", available: true } });
    expect(c.pick("nbg1")).toBeUndefined();
    state.create = () => CREATED;
    expect((await c.submit()).ok).toBe(true);
    expect(posts(log).map((x) => x.key)[1]).toBe(posts(log)[0].key);
    expect(posts(log)[1].body.server_type).toBe("cx42");
    c.close();
    await c.open(); // made: a fresh dialog, a free choice, a new key
    expect(c.state.locked).toBe(false);
    await c.submit();
    expect(posts(log)[2].key).not.toBe(posts(log)[0].key);
  });

  it("Cancel while the create is in the air keeps the key; a reopened dialog shows it sending, and the press cannot double it", async () => {
    let release;
    const { call, log } = cloud({ create: () => new Promise((r) => { release = r; }) });
    const c = createCreator({ call: async (m, u, b, s, o) => { const r = await call(m, u, b, s, o); return r; }, uuid });
    await c.open();
    const sent = c.submit();
    await Promise.resolve();
    c.close();
    await c.open();
    expect(c.state).toMatchObject({ sending: true, locked: true });
    expect(await c.submit()).toEqual({ ok: false, code: "", unknown: false, stale: false });
    expect(posts(log)).toHaveLength(1);
    release(CREATED);
    expect(await sent).toMatchObject({ ok: true, stale: true });
    expect(c.state).toBeNull(); // the reopened dialog was locked to this attempt, which is made: it closes and offers no Create
    await c.open();
    expect(c.state).toMatchObject({ sending: false, locked: false }); // a later dialog is a fresh one
  });

  it("a late 201 with no dialog open leaves it closed", async () => {
    let release;
    const { call } = cloud({ create: () => new Promise((r) => { release = r; }) });
    const c = createCreator({ call, uuid });
    await c.open();
    const sent = c.submit();
    await Promise.resolve();
    c.close();
    release(CREATED);
    expect(await sent).toMatchObject({ ok: true, stale: true });
    expect(c.state).toBeNull();
  });

  it("once an attempt has been unknown, a 429, 401 or 403 from in front of the create keeps the key and the lock, with the right words", async () => {
    const cases = [
      [fail(429, "rate_limited", { retryAfter: 5 }), TOO_MANY_TRIES],
      [fail(401, "unauthenticated"), SIGN_IN_AGAIN],
      [fail(403, "csrf_failed"), "Only owners and admins can create a server."],
      [fail(404, "not_found"), UNKNOWN_OUTCOME],
      [fail(409, "server_creating"), SERVER_BEING_CREATED],
    ];
    for (const [refusal, words] of cases) {
      const answers = [fail(0, "timeout"), refusal];
      const { call, log, state } = cloud({ create: () => answers.shift() || CREATED });
      const c = createCreator({ call, uuid });
      await c.open();
      await c.submit();
      expect(await c.submit(), String(refusal.status)).toMatchObject({ ok: false, unknown: true });
      expect(c.state, String(refusal.status)).toMatchObject({ locked: true, sending: false, error: words, type: "cx32", location: "fsn1" });
      clean(c.state.error);
      c.close(); // the wait of a 429 ends with the dialog
      await c.open();
      expect(c.state.locked, String(refusal.status)).toBe(true);
      state.create = () => CREATED;
      expect((await c.submit()).ok).toBe(true);
      expect(posts(log), String(refusal.status)).toHaveLength(3);
      expect(new Set(posts(log).map((x) => x.key)).size, String(refusal.status)).toBe(1); // the same key every time
      expect(c.state).toMatchObject({ locked: false });
    }
  });

  it("a 429 after an unknown outcome holds the button for the wait and the next press sends the same key", async () => {
    const answers = [fail(0, "timeout"), fail(429, "rate_limited", { retryAfter: 1 })];
    const { call, log } = cloud({ create: () => answers.shift() || CREATED });
    vi.useFakeTimers();
    const c = createCreator({ call, uuid });
    await c.open();
    await c.submit();
    await c.submit();
    expect(c.state).toMatchObject({ wait: 1, locked: true });
    expect(await c.submit()).toMatchObject({ ok: false, code: "" }); // held
    expect(posts(log)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1300); // fake clock: the hold is a Date.now() deadline, so no wall-clock wait
    expect(c.state.wait).toBe(0);
    expect((await c.submit()).ok).toBe(true);
    expect(new Set(posts(log).map((x) => x.key)).size).toBe(1);
  });

  it("a clean refusal still ends an unknown attempt: the next press is a new key", async () => {
    for (const code of CLEAN_REFUSALS) {
      const answers = [fail(0, "timeout"), fail(409, code)];
      const { call, log } = cloud({ create: () => answers.shift() || CREATED });
      const c = createCreator({ call, uuid });
      await c.open();
      await c.submit();
      await c.submit();
      expect(c.state.locked, code).toBe(false);
      await c.submit();
      expect(new Set(posts(log).map((x) => x.key)).size, code).toBe(2);
    }
  });

  it("a clean refusal on the first press ends the attempt at once", async () => {
    for (const code of CLEAN_REFUSALS) {
      const { call, log } = cloud({ create: () => fail(409, code) });
      const c = createCreator({ call, uuid });
      await c.open();
      await c.submit();
      expect(c.state.locked, code).toBe(false);
      await c.submit();
      expect(new Set(posts(log).map((x) => x.key)).size, code).toBe(2);
    }
  });

  it("anything that is not a clean refusal keeps the key and the lock, on a first press and after an unknown one", async () => {
    const codes = [
      [409, "hetzner_locked"], [429, "hetzner_rate_limit_exceeded"], [503, "hetzner_unavailable"], [502, "hetzner_server_error"], [409, "hetzner_something_new"],
      [409, "server_outcome_unknown"], [500, "server_outcome_unknown"], [409, "a_code_nobody_listed"], [429, "rate_limited"],
    ];
    for (const [status, code] of codes) {
      for (const priorUnknown of [false, true]) {
        const label = `${code} ${priorUnknown ? "after unknown" : "first"}`;
        const answers = priorUnknown ? [fail(0, "timeout"), fail(status, code, { retryAfter: 1 })] : [fail(status, code, { retryAfter: 1 })];
        const { call, log, state } = cloud({ create: () => answers.shift() || CREATED });
        const c = createCreator({ call, uuid });
        await c.open();
        await c.submit();
        if (priorUnknown) await c.submit();
        expect(c.state, label).toMatchObject({ locked: true, sending: false, type: "cx32", location: "fsn1" });
        expect(c.state.error, label).not.toBe("");
        expect(c.state.error, label).not.toMatch(/hetzner_|server_outcome/);
        c.close(); // a 429's wait ends with the dialog
        await c.open();
        state.create = () => CREATED;
        expect((await c.submit()).ok, label).toBe(true);
        expect(new Set(posts(log).map((x) => x.key)).size, label).toBe(1); // the same key every time
        expect(c.state, label).toMatchObject({ locked: false });
      }
    }
  });

  it("server_outcome_unknown says the outcome is unknown, and a refresh of the list is asked for", async () => {
    const { call } = cloud({ create: () => fail(409, "server_outcome_unknown") });
    const c = createCreator({ call, uuid });
    await c.open();
    expect(await c.submit()).toMatchObject({ ok: false, code: "server_outcome_unknown", unknown: true });
    expect(c.state.error).toBe(UNKNOWN_OUTCOME);
  });

  it("hetzner_locked then a press sends the SAME key and body", async () => {
    const answers = [fail(409, "hetzner_locked")];
    const { call, log } = cloud({ create: () => answers.shift() || CREATED });
    const c = createCreator({ call, uuid });
    await c.open();
    await c.submit();
    await c.submit();
    const sent = posts(log);
    expect(sent).toHaveLength(2);
    expect(sent[1].key).toBe(sent[0].key);
    expect(sent[1].body).toEqual(sent[0].body);
  });

  it("a 429 on the first press keeps the key, and the next press sends it again", async () => {
    const answers = [fail(429, "hetzner_rate_limit_exceeded", { retryAfter: 1 })];
    const { call, log } = cloud({ create: () => answers.shift() || CREATED });
    vi.useFakeTimers();
    const c = createCreator({ call, uuid });
    await c.open();
    await c.submit();
    expect(c.state).toMatchObject({ locked: true, wait: 1 });
    await vi.advanceTimersByTimeAsync(1300); // fake clock: the hold is a Date.now() deadline, so no wall-clock wait
    expect((await c.submit()).ok).toBe(true);
    expect(new Set(posts(log).map((x) => x.key)).size).toBe(1);
  });

  it("the clean list is the server's REFUSED set (as hetzner_ codes) plus the six handler refusals", () => {
    const src = readFileSync(new URL("../../../packages/api/src/machines/servers.ts", import.meta.url), "utf8");
    const m = /const REFUSED = new Set<HetznerCode>\(\[([^\]]*)\]\)/.exec(src);
    expect(m, "REFUSED not found in servers.ts").not.toBeNull();
    const refused = [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => `hetzner_${x[1]}`);
    expect(refused.length).toBeGreaterThan(0);
    const six = ["price_changed", "price_unavailable", "credential_invalid", "not_connected", "not_configured", "machine_kek_unset"];
    expect([...CLEAN_REFUSALS].sort()).toEqual([...refused, ...six].sort());
  });

  it("a key reused is never answered with a new key: the person is told, and chooses Create a new one", async () => {
    const answers = [fail(0, "timeout"), fail(422, "idempotency_key_reused")];
    const { call, log, state } = cloud({ create: () => answers.shift() || CREATED });
    const c = createCreator({ call, uuid });
    await c.open();
    await c.submit();
    expect(await c.submit()).toMatchObject({ ok: false, code: "idempotency_key_reused", unknown: true });
    expect(c.state).toMatchObject({ reused: true, locked: true, error: UNKNOWN_OUTCOME });
    expect(await c.submit()).toMatchObject({ ok: false, code: "" }); // no press goes out
    expect(posts(log)).toHaveLength(2);
    await c.startOver();
    expect(c.state).toMatchObject({ locked: false, reused: false, error: "" });
    expect(c.state.quote.status).toBe("ready");
    state.create = () => CREATED;
    expect((await c.submit()).ok).toBe(true);
    expect(posts(log)[2].key).not.toBe(posts(log)[0].key);
  });

  it("an answer for a dialog that is gone does not touch the one open now", async () => {
    let refuse;
    const { call } = cloud({ create: () => new Promise((_, no) => { refuse = no; }) });
    const c = createCreator({ call, uuid });
    await c.open();
    const sent = c.submit();
    await Promise.resolve();
    c.close();
    refuse(fail(409, "hetzner_resource_limit_exceeded"));
    const late = await sent;
    expect(late).toMatchObject({ ok: false, stale: true });
    expect(c.state).toBeNull(); // closed stays closed
    await c.open();
    expect(c.state).toMatchObject({ error: "", locked: false });
  });

  it("a failed catalog says so and retries, and an empty catalog is the same", async () => {
    let down = true;
    const { call } = cloud({ catalog: (u) => (down ? fail(503, "hetzner_unavailable") : catalogFor(u)) });
    const c = createCreator({ call, uuid });
    await c.open();
    expect(c.state.catalog.status).toBe("error");
    down = false;
    await c.retry();
    expect(c.state.catalog.status).toBe("ready");
    expect(c.state.type).toBe("cx32");
    const none = createCreator({ call: cloud({ catalog: () => ({ ...CATALOG_ALL, locations: [] }) }).call, uuid });
    await none.open();
    expect(none.state.catalog.status).toBe("error");
  });

  it("drops a slow answer for an earlier choice, and a dialog closed mid-read stays closed", async () => {
    const waiting = [];
    const { call } = cloud();
    const slow = (m, u, ...rest) => (u.startsWith("/api/v1/machine-servers/quote") && u.includes("cx22") ? new Promise((r) => waiting.push(r)) : call(m, u, ...rest));
    const c = createCreator({ call: slow, uuid });
    await c.open();
    const late = c.choose("cx22"); // a quote that is slow
    await c.choose("cx42"); // the newer choice answers first
    expect(c.state.type).toBe("cx42");
    waiting[0]({ ...QUOTE, server_type: "cx22" });
    await late;
    expect(c.state.quote.status).toBe("ready");
    expect(c.state.type).toBe("cx42");
    const closing = createCreator({ call: (m, u) => (u === catalogUrl() ? new Promise((r) => setTimeout(() => r(CATALOG_ALL), 5)) : call(m, u)), uuid });
    const opened = closing.open();
    closing.close();
    await opened;
    expect(closing.state).toBeNull();
  });

  it("lists every type of the place under Show all types and toggles it", async () => {
    const c = createCreator({ call: cloud().call, uuid });
    await c.open();
    expect(c.state.all).toBe(false);
    c.toggleAll();
    expect(c.state.all).toBe(true);
    const rest = c.state.catalog.types.filter((t) => offeredIn(t, "fsn1") && t.name !== "cx32" && t.name !== "cx42");
    expect(rest.map((t) => t.name)).toEqual(["cx22", "ccx13", "cax21"]);
  });
});
