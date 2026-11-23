/**
 * D#845 MC-13a: the Hetzner Cloud fake that staging serves at /api/_fake/hetzner/v1/*. A pure function over a JSON state, so the route can keep the state in
 * `fake_provider_state` and the contract tests can run it over real TLS with the real client. UNRECORDED: written from Hetzner's published reference
 * (https://docs.hetzner.cloud/reference/cloud), the same contract as the strict test fake. Bounded: at most FAKE_LIMITS of each thing. Same shapes and `{error:{code,message,details}}` bodies for servers,
 * actions, firewalls, labels, prices and images. Not faked: boot timing (actions finish at once; a new server is `initializing` for one poll; an image finishes on its second poll), the real catalogue and
 * prices, rate limits, and the wording of every message. Auth: a bearer token is required and any non-empty test token is accepted, except one that
 * looks like a real Hetzner token (64 letters and digits), which is refused. The token is never stored or echoed.
 */
type R = Record<string, unknown>;
export interface FakeState { n: number; servers: R[]; firewalls: R[]; images: R[]; sshKeys: R[]; polls: Record<string, { imageId: number; serverId: number; polls: number }> }
export interface FakeReply { status: number; body?: unknown }
export const emptyFakeState = (): FakeState => ({ n: 1000, servers: [], firewalls: [], images: [], sshKeys: [], polls: {} });
/** The most of each thing the fake keeps (servers 10, the rest 20), so its one stored document stays bounded; past it the answer is Hetzner's 403 resource_limit_exceeded. */
export const FAKE_LIMITS = { servers: 10, firewalls: 20, images: 20, sshKeys: 20, rules: 50 } as const;
const full = (name: string): FakeReply => err(403, "resource_limit_exceeded", `${name} limit exceeded`, { limits: [{ name: `${name}_limit` }] });
/** True when the header is a bearer token the fake accepts: any non-empty test token that does not look like a real Hetzner token (64 letters and digits). Checked before the store is opened. */
export const fakeAuthOk = (auth: string | null): boolean => { const t = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : ""; return t !== "" && !/^[A-Za-z0-9]{64}$/.test(t); };

const err = (status: number, code: string, message: string, details?: unknown): FakeReply => ({ status, body: { error: { code, message, ...(details ? { details } : {}) } } });
const bad = (field: string, msg: string): FakeReply => err(422, "invalid_input", `invalid input in field '${field}': ${msg}`, { fields: [{ name: field, messages: [msg] }] });
const money = (n: string) => ({ net: n, gross: (Number(n) * 1.19).toFixed(4) });
const LOCS = [{ id: 1, name: "fsn1" }, { id: 2, name: "nbg1" }].map((l) => ({ ...l, description: `loc ${l.id}`, country: "DE", city: "Test", latitude: 1.5, longitude: 2.5, network_zone: "eu-central" }));
const price = (l: string, h: string, m: string) => ({ location: l, price_hourly: money(h), price_monthly: money(m), included_traffic: 21990232555520, price_per_tb_traffic: money("1.0000") });
const TYPES = [["cx22", 22, 2, 4, 40, "0.0059", "3.7900"], ["cx32", 23, 4, 8, 80, "0.0113", "6.8000"]].map(([name, id, cores, memory, disk, h, m]) => ({ id, name, description: String(name).toUpperCase(), cores, memory, disk, storage_type: "local", cpu_type: "shared", architecture: "x86", category: "Cost-Optimized", deprecation: null, prices: LOCS.map((l) => price(l.name, h as string, m as string)), locations: LOCS.map((l) => ({ id: l.id, name: l.name, deprecation: null, recommended: true, available: name === "cx22" || l.name === "fsn1" })) }));
const LABEL_KEY = /^([a-z0-9]([-a-z0-9.]*[a-z0-9])?\/)?[A-Za-z0-9]([-_.A-Za-z0-9]{0,61}[A-Za-z0-9])?$/;
const LABEL_VALUE = /^([A-Za-z0-9]([-_.A-Za-z0-9]{0,61}[A-Za-z0-9])?)?$/;
const SERVER_FIELDS = new Set(["name", "server_type", "location", "datacenter", "image", "start_after_create", "labels", "ssh_keys", "firewalls", "user_data", "public_net", "automount", "networks", "volumes", "placement_group"]);
const NOW = "2026-01-01T00:00:00+00:00";

const badLabels = (l: unknown): FakeReply | null => {
  if (l === undefined) return null;
  if (typeof l !== "object" || l === null || Array.isArray(l)) return bad("labels", "is not an object");
  return Object.entries(l).some(([k, v]) => !LABEL_KEY.test(k) || typeof v !== "string" || !LABEL_VALUE.test(v)) ? bad("labels", "invalid label") : null;
};
const matches = (labels: Record<string, string>, sel: string): boolean => sel.split(",").every((c) => {
  const ne = c.indexOf("!="), eq = c.indexOf("=");
  if (ne > 0) return labels[c.slice(0, ne)] !== c.slice(ne + 2);
  if (eq > 0) return labels[c.slice(0, eq)] === c.slice(eq + 1);
  return c.startsWith("!") ? !(c.slice(1) in labels) : c in labels;
});

export function handleFake(s: FakeState, method: string, url: URL, body: R, auth: string | null): FakeReply {
  if (!fakeAuthOk(auth)) return err(401, "unauthorized", "unable to authenticate");
  s.sshKeys ??= []; // a document stored before ssh keys existed
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "v1") return err(404, "not_found", "not found");
  const [, res, id, sub, cmd] = parts;
  const notFound = err(404, "not_found", "not found");
  const only = (...m: string[]): FakeReply | null => (m.includes(method) ? null : err(405, "method_not_allowed", "The request method is not allowed"));
  const q = url.searchParams;
  const act = (command: string, rid: number, status = "success") => ({ id: ++s.n, command, status, progress: status === "success" ? 100 : 40, started: NOW, finished: status === "running" ? null : NOW, resources: [{ id: rid, type: "server" }], error: null });
  const page = (key: string, all: R[]): FakeReply => {
    const sel = q.get("label_selector"), name = q.get("name"), per = Number(q.get("per_page")), p = Number(q.get("page"));
    const rows = all.filter((x) => (!name || x.name === name) && (!sel || matches(x.labels as Record<string, string>, sel)) && (key !== "images" || !q.get("type") || x.type === q.get("type")));
    const perPage = Number.isInteger(per) && per >= 1 && per <= 50 ? per : 25, no = Number.isInteger(p) && p >= 1 ? p : 1, last = Math.max(Math.ceil(rows.length / perPage), 1);
    return { status: 200, body: { [key]: rows.slice((no - 1) * perPage, no * perPage), meta: { pagination: { page: no, per_page: perPage, previous_page: no > 1 ? no - 1 : null, next_page: no < last ? no + 1 : null, last_page: last, total_entries: rows.length } } } };
  };
  const imageAction = (aid: number): R => {
    const a = s.polls[String(aid)]!;
    a.polls++;
    const image = s.images.find((x) => x.id === a.imageId)!;
    const done = a.polls >= 2;
    if (done) { image.status = "available"; image.image_size = 1.5; }
    return { ...act("create_image", a.serverId, done ? "success" : "running"), id: aid };
  };
  const byId = (rows: R[]) => rows.find((x) => String(x.id) === id);
  switch (res) {
    case "locations": return only("GET") ?? page("locations", LOCS);
    case "server_types": return only("GET") ?? page("server_types", TYPES);
    case "pricing": return only("GET") ?? { status: 200, body: { pricing: { currency: "EUR", vat_rate: "19.00", primary_ips: [{ type: "ipv4", prices: LOCS.map((l) => ({ location: l.name, price_hourly: money("0.0008"), price_monthly: money("0.5000") })) }, { type: "ipv6", prices: [] }], server_types: TYPES.map((t) => ({ id: t.id, name: t.name, prices: t.prices })), image: { price_per_gb_month: money("0.0119") }, volume: { price_per_gb_month: money("0.0440") } } } };
    case "actions": {
      if (only("GET")) return only("GET")!;
      if (id) return s.polls[id] ? { status: 200, body: { action: imageAction(Number(id)) } } : { status: 200, body: { action: act("x", 1) } };
      const ids = q.getAll("id");
      if (ids.length === 0) return bad("id", "is required");
      return { status: 200, body: { actions: ids.map((i) => (s.polls[i] ? imageAction(Number(i)) : { ...act("x", 1), id: Number(i) })) } };
    }
    case "servers": {
      if (!id) {
        if (method === "GET") return page("servers", s.servers);
        if (method !== "POST") return only("GET", "POST")!;
        const unknown = Object.keys(body).find((k) => !SERVER_FIELDS.has(k));
        if (unknown) return bad(unknown, "unknown field");
        const img = typeof body.image === "number" ? s.images.find((x) => x.id === body.image) : undefined;
        if (typeof body.image === "number" && (!img || img.status !== "available")) return bad("image", img ? "image is not available" : "image not found");
        for (const f of ["name", "server_type", ...(typeof body.image === "number" ? [] : ["image"])]) if (typeof body[f] !== "string" || body[f] === "") return bad(f, "is required");
        const bl = badLabels(body.labels);
        if (bl) return bl;
        if (typeof body.user_data === "string" && Buffer.byteLength(body.user_data) > 32 * 1024) return bad("user_data", "is too long");
        const type = TYPES.find((x) => x.name === body.server_type), loc = LOCS.find((x) => x.name === body.location);
        if (!type) return bad("server_type", "not found");
        if (!loc) return bad("location", "not found");
        if (s.servers.length >= FAKE_LIMITS.servers) return full("server");
        if (s.servers.some((x) => x.name === body.name)) return err(409, "uniqueness_error", "server name is already used", { fields: [{ name: "name" }] });
        if (!type.locations.some((l) => l.name === loc.name && l.available)) return err(412, "resource_unavailable", "requested resource is unavailable");
        const sid = ++s.n;
        const fws = ((body.firewalls ?? []) as Array<{ firewall: number }>).map((f) => ({ id: f.firewall, status: "applied" }));
        const server = { id: sid, name: body.name, status: "initializing", created: NOW, public_net: { ipv4: { id: sid + 1, ip: "203.0.113.7", blocked: false, dns_ptr: "x.example" }, ipv6: { id: sid + 2, ip: "2001:db8::/64", blocked: false, dns_ptr: [] }, floating_ips: [], firewalls: fws }, private_net: [], server_type: type, location: loc, image: null, rescue_enabled: false, locked: false, protection: { delete: false, rebuild: false }, labels: body.labels ?? {}, volumes: [], load_balancers: [], primary_disk_size: type.disk };
        s.servers.push(server);
        return { status: 201, body: { server, action: act("create_server", sid), next_actions: [act("start_server", sid)], root_password: "fake-root-password-SECRET" } };
      }
      const srv = byId(s.servers);
      if (!srv) return notFound;
      if (!sub) {
        if (method === "GET") {
          const seen = { ...srv }; // a poll shows `initializing` once, then the server is up
          if (srv.status === "initializing") srv.status = "running";
          return { status: 200, body: { server: seen } };
        }
        if (method === "PUT") {
          if (typeof body.name !== "string" || body.name === "") return bad("name", "is required");
          if (s.servers.some((x) => x !== srv && x.name === body.name)) return err(409, "uniqueness_error", "server name is already used", { fields: [{ name: "name" }] });
          srv.name = body.name;
          return { status: 200, body: { server: srv } };
        }
        if (method !== "DELETE") return only("GET", "PUT", "DELETE")!;
        s.servers.splice(s.servers.indexOf(srv), 1);
        return { status: 200, body: { action: act("delete_server", srv.id as number) } };
      }
      if (sub !== "actions") return notFound;
      if (cmd === "create_image") {
        if (method !== "POST") return only("POST")!;
        const unknown = Object.keys(body).find((k) => !["type", "description", "labels"].includes(k));
        if (unknown) return bad(unknown, "unknown field");
        if (body.type !== "snapshot") return bad("type", "must be snapshot");
        if (body.description !== undefined && typeof body.description !== "string") return bad("description", "is not a string");
        const bl = badLabels(body.labels);
        if (bl) return bl;
        if (s.images.length >= FAKE_LIMITS.images) return full("image");
        const image = { id: ++s.n, status: "creating", type: "snapshot", name: null, description: body.description ?? null, image_size: null, disk_size: 40, created: NOW, created_from: { id: srv.id, name: srv.name }, bound_to: null, os_flavor: "ubuntu", os_version: null, rapid_deploy: false, protection: { delete: false }, deprecated: null, deleted: null, architecture: "x86", labels: body.labels ?? {} };
        s.images.push(image);
        const aid = ++s.n;
        s.polls[String(aid)] = { imageId: image.id, serverId: srv.id as number, polls: 0 };
        return { status: 201, body: { image, action: { ...act("create_image", srv.id as number, "running"), id: aid } } };
      }
      if (!["reboot", "poweron", "poweroff", "shutdown"].includes(cmd ?? "")) return notFound;
      if (method !== "POST") return only("POST")!;
      srv.status = cmd === "poweroff" || cmd === "shutdown" ? "off" : "running";
      return { status: 201, body: { action: act(`${cmd}_server`, srv.id as number) } };
    }
    case "firewalls": {
      if (!id) {
        if (method === "GET") return page("firewalls", s.firewalls);
        if (method !== "POST") return only("GET", "POST")!;
        if (typeof body.name !== "string" || !Array.isArray(body.rules)) return bad("name", "is required");
        if (body.rules.length > FAKE_LIMITS.rules) return bad("rules", "too many rules");
        const bl = badLabels(body.labels);
        if (bl) return bl;
        if (s.firewalls.length >= FAKE_LIMITS.firewalls) return full("firewall");
        if (s.firewalls.some((f) => f.name === body.name)) return err(409, "uniqueness_error", "firewall name is already used", { fields: [{ name: "name" }] });
        const f = { id: ++s.n, name: body.name, labels: body.labels ?? {}, created: NOW, rules: body.rules, applied_to: [] };
        s.firewalls.push(f);
        return { status: 201, body: { firewall: f, actions: [] } };
      }
      const f = byId(s.firewalls);
      if (!f) return notFound;
      if (method === "GET") return { status: 200, body: { firewall: f } };
      if (method !== "DELETE") return only("GET", "DELETE")!;
      if (s.servers.some((x) => ((x.public_net as { firewalls: Array<{ id: number }> }).firewalls).some((a) => a.id === f.id))) return err(422, "resource_in_use", "firewall is still applied to a resource", { fields: [{ name: "id" }] });
      s.firewalls.splice(s.firewalls.indexOf(f), 1);
      return { status: 204 };
    }
    case "images": {
      if (!id) {
        if (method !== "GET") return only("GET")!;
        const t = q.get("type");
        return t !== null && !["system", "app", "snapshot", "backup"].includes(t) ? bad("type", "invalid") : page("images", s.images);
      }
      const im = byId(s.images);
      if (!im) return notFound;
      if (method === "GET") return { status: 200, body: { image: im } };
      if (method !== "DELETE") return only("GET", "DELETE")!;
      if (im.status === "creating") return err(423, "locked", "item is locked");
      s.images.splice(s.images.indexOf(im), 1);
      for (const [k, a] of Object.entries(s.polls)) if (a.imageId === im.id) delete s.polls[k];
      return { status: 204 };
    }
    case "ssh_keys": {
      if (!id) {
        if (method === "GET") return page("ssh_keys", q.get("fingerprint") ? s.sshKeys.filter((k) => k.fingerprint === q.get("fingerprint")) : s.sshKeys);
        if (method !== "POST") return only("GET", "POST")!;
        if (typeof body.name !== "string" || body.name === "") return bad("name", "is required");
        if (typeof body.public_key !== "string" || body.public_key === "") return bad("public_key", "is required");
        const bl = badLabels(body.labels);
        if (bl) return bl;
        const fingerprint = `fp:${body.public_key.slice(-16)}`;
        if (s.sshKeys.some((k) => k.fingerprint === fingerprint)) return err(409, "uniqueness_error", "SSH key with the same fingerprint already exists", { fields: [{ name: "public_key" }] });
        if (s.sshKeys.length >= FAKE_LIMITS.sshKeys) return full("ssh_key");
        const k = { id: ++s.n, name: body.name, fingerprint, public_key: body.public_key, labels: body.labels ?? {}, created: NOW };
        s.sshKeys.push(k);
        return { status: 201, body: { ssh_key: k } };
      }
      const k = byId(s.sshKeys);
      if (!k) return notFound;
      if (method !== "DELETE") return only("DELETE")!;
      s.sshKeys.splice(s.sshKeys.indexOf(k), 1);
      return { status: 204 };
    }
    default: return notFound;
  }
}
