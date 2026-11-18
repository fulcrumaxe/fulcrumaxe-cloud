import https from "node:https";
import type { AddressInfo } from "node:net";
import { generateSelfSignedCert } from "../../../webhooks/test/helpers/selfSignedCert.js";

/**
 * A Hetzner Cloud API that refuses what the real one refuses, over real TLS (the certificate names api.hetzner.cloud and is the client's explicit `ca`).
 * UNRECORDED: written from Hetzner's published reference, not captured from the live API (no token, no test spend). Sources:
 *   https://docs.hetzner.cloud/reference/cloud  and the OpenAPI spec  https://docs.hetzner.cloud/cloud.spec.json
 *
 * Enforced: `/v1` prefix; `Authorization: Bearer <known token>` (else 401 unauthorized); JSON bodies on writes (else 400 json_error); `{error:{code,message,details}}` error bodies;
 * `page` / `per_page` (default 25, max 50, invalid -> default) with `meta.pagination`; `RateLimit-Limit/-Remaining/-Reset` (a UNIX time) on every response, a gradual refill of
 * limit/3600 a second on a shared clock, and 429 rate_limit_exceeded at zero; label keys and values by the published pattern; `id` required on GET /actions; the create
 * response carries `root_password` (so a client that kept it is caught); a taken server name or SSH-key fingerprint is 409 uniqueness_error; the account server limit is 403
 * resource_limit_exceeded; a type not offered in the location is 412 resource_unavailable; user_data over 32 KiB is 422 invalid_input.
 * Failures can be injected (`world.failNext`: a status and code, a hang, or a dropped connection).
 *
 * Images (MC-3c): `POST /servers/{id}/actions/create_image` takes only `type` (snapshot), `description` and `labels` and refuses any other field, any other type, bad labels and a
 * missing server; the image starts `creating` with `image_size` null and becomes `available` (with a size) only when its action is polled to `success` (`imageSteps` polls;
 * `imageStuck` keeps it creating, `imageActionError` fails the action); `GET /images` filters by `type` and a `label_selector` of `=`, `!=`, `key` and `!key`;
 * `DELETE /images/{id}` is 404 when missing, 423 `locked` while creating (or when `locked`), 403 `protected` when protected; a server create takes an image by numeric id and
 * refuses an unknown one or one that is not `available`. Create-server and create_image refuse unknown body fields. A failure can land AFTER the write committed
 * (`failNext: {after: "hang" | "drop" | "500"}`).
 *
 * Not faked faithfully: server boot timing (actions finish on demand), the real prices and type catalogue, rate-limit thresholds per endpoint, image and network
 * validation, the Link header (deprecated by Hetzner), firewall application, and the wording of every message.
 */
export interface FakeWorld {
  tokens: Set<string>;
  /** Tokens that read but cannot write: any method but GET answers 403 `forbidden` (Hetzner's read-only project token). */
  readOnlyTokens?: Set<string>;
  clock: { t: number };
  limit: number;
  /** Requests left now (refills by limit/3600 a second on `clock`). */
  remaining: number;
  serverLimit: number;
  failNext: Array<{ status?: number; code?: string; message?: string; hang?: boolean; drop?: boolean; /** Only fail a request with this method (the rest pass through to a later request). */ method?: string; /** Commit the write, then answer this way. */ after?: "hang" | "drop" | "500" }>;
  servers: Array<Record<string, unknown>>;
  firewalls: Array<Record<string, unknown>>;
  sshKeys: Array<Record<string, unknown>>;
  actionStatus: "running" | "success" | "error";
  /** The published reply to a delete marks `action` optional: when true, a delete answers 200 with `{}`. */
  deleteOmitsAction?: boolean;
  /** When true, a server `action` reply (delete, reboot, power on and off) carries a malformed `action` object, to prove a bad reply is `unavailable`. */
  malformedAction?: boolean;
  images: Array<Record<string, unknown>>;
  /** Action polls before a new image is `available` (default 2). */
  imageSteps: number;
  /** A new image never leaves `creating`. */
  imageStuck?: boolean;
  /** The image action ends `error`. */
  imageActionError?: boolean;
  /** Image actions by id: the polls seen and the image they build. */
  imageActions: Map<number, { imageId: number; polls: number }>;
  /** Every request seen, accepted or not. */
  requests: Array<{ method: string; path: string; headers: Record<string, string>; body: string }>;
}
export const newWorld = (tokens: string[]): FakeWorld => ({ tokens: new Set(tokens), clock: { t: 1_800_000_000_000 }, limit: 3600, remaining: 3600, serverLimit: 10, failNext: [], servers: [], firewalls: [], sshKeys: [], actionStatus: "success", images: [], imageSteps: 2, imageActions: new Map(), requests: [] });

const money = (n: string) => ({ net: n, gross: (Number(n) * 1.19).toFixed(4) });
const price = (location: string, h: string, m: string) => ({ location, price_hourly: money(h), price_monthly: money(m), included_traffic: 21990232555520, price_per_tb_traffic: money("1.0000") });
const LOCATIONS = [1, 2].map((id) => ({ id, name: ["fsn1", "nbg1"][id - 1]!, description: `loc ${id}`, country: "DE", city: "Test", latitude: 1.5, longitude: 2.5, network_zone: "eu-central" }));
const TYPES = [
  { id: 22, name: "cx22", description: "CX22", cores: 2, memory: 4, disk: 40, storage_type: "local", cpu_type: "shared", architecture: "x86", category: "Cost-Optimized", deprecation: null, prices: LOCATIONS.map((l) => price(l.name, "0.0059", "3.7900")), locations: LOCATIONS.map((l) => ({ id: l.id, name: l.name, deprecation: null, recommended: true, available: true })) },
  { id: 23, name: "cx32", description: "CX32", cores: 4, memory: 8, disk: 80, storage_type: "local", cpu_type: "shared", architecture: "x86", category: "Cost-Optimized", deprecation: null, prices: LOCATIONS.map((l) => price(l.name, "0.0113", "6.8000")), locations: LOCATIONS.map((l) => ({ id: l.id, name: l.name, deprecation: null, recommended: false, available: l.name === "fsn1" })) },
];
const LABEL_KEY = /^([a-z0-9]([-a-z0-9.]*[a-z0-9])?\/)?[A-Za-z0-9]([-_.A-Za-z0-9]{0,61}[A-Za-z0-9])?$/;
const LABEL_VALUE = /^([A-Za-z0-9]([-_.A-Za-z0-9]{0,61}[A-Za-z0-9])?)?$/;
type Body = { name?: string; server_type?: string; location?: string; labels?: Record<string, string>; firewalls?: Array<{ firewall: number }>; [k: string]: unknown };
type Reply = { status: number; body?: unknown; headers?: Record<string, string> };
const err = (status: number, code: string, message: string, details?: unknown): Reply => ({ status, body: { error: { code, message, ...(details ? { details } : {}) } } });

export interface StrictHetzner { port: number; ca: string; lookup: () => Promise<Array<{ address: string; family: number }>>; world: FakeWorld; close(): Promise<void> }

export async function startStrictHetzner(world: FakeWorld): Promise<StrictHetzner> {
  const { certPem, keyPem } = generateSelfSignedCert("api.hetzner.cloud", 1, { dnsNames: ["api.hetzner.cloud"] });
  let nextId = 1000;
  let lastRefill = world.clock.t;
  const act = (cmd: string, id: number) => ({ id: ++nextId, command: cmd, status: world.actionStatus, progress: world.actionStatus === "success" ? 100 : 0, started: "2026-01-01T00:00:00+00:00", finished: world.actionStatus === "running" ? null : "2026-01-01T00:00:05+00:00", resources: [{ id, type: "server" }], error: world.actionStatus === "error" ? { code: "action_failed", message: "Action failed" } : null });
  const server = (b: Body) => {
    const t = TYPES.find((x) => x.name === b.server_type)!;
    const l = LOCATIONS.find((x) => x.name === b.location)!;
    const id = ++nextId;
    return { id, name: b.name, status: "initializing", created: "2026-01-01T00:00:00+00:00", public_net: { ipv4: { id: id + 1, ip: "203.0.113.7", blocked: false, dns_ptr: "x.example" }, ipv6: { id: id + 2, ip: "2001:db8::/64", blocked: false, dns_ptr: [] }, floating_ips: [], firewalls: (b.firewalls ?? []).map((f: { firewall: number }) => ({ id: f.firewall, status: "pending" })) }, private_net: [], server_type: t, location: l, image: null, rescue_enabled: false, locked: false, protection: { delete: false, rebuild: false }, labels: b.labels ?? {}, volumes: [], load_balancers: [], primary_disk_size: t.disk };
  };
  const page = (url: URL, key: string, all: Array<Record<string, unknown>>): Reply => {
    const per = Number(url.searchParams.get("per_page"));
    const perPage = Number.isInteger(per) && per >= 1 && per <= 50 ? per : 25;
    const p = Number(url.searchParams.get("page"));
    const pageNo = Number.isInteger(p) && p >= 1 ? p : 1;
    const last = Math.max(Math.ceil(all.length / perPage), 1);
    return { status: 200, body: { [key]: all.slice((pageNo - 1) * perPage, pageNo * perPage), meta: { pagination: { page: pageNo, per_page: perPage, previous_page: pageNo > 1 ? pageNo - 1 : null, next_page: pageNo < last ? pageNo + 1 : null, last_page: last, total_entries: all.length } } } };
  };
  const hasLabels = (labels: Record<string, string>, sel: string): boolean =>
    sel.split(",").every((c) => {
      const ne = c.indexOf("!="), eq = c.indexOf("=");
      if (ne > 0) return labels[c.slice(0, ne)] !== c.slice(ne + 2);
      if (eq > 0) return labels[c.slice(0, eq)] === c.slice(eq + 1);
      return c.startsWith("!") ? !(c.slice(1) in labels) : c in labels;
    });
  const bySelector = (url: URL, all: Array<Record<string, unknown>>) => {
    const sel = url.searchParams.get("label_selector");
    const name = url.searchParams.get("name");
    return all.filter((x) => (!name || x.name === name) && (!sel || hasLabels(x.labels as Record<string, string>, sel)));
  };
  const SERVER_FIELDS = new Set(["name", "server_type", "location", "datacenter", "image", "start_after_create", "labels", "ssh_keys", "firewalls", "user_data", "public_net", "automount", "networks", "volumes", "placement_group"]);
  const unknownField = (b: Body, allowed: Set<string>): Reply | null => {
    const bad = Object.keys(b).find((k) => !allowed.has(k));
    return bad === undefined ? null : err(422, "invalid_input", `invalid input in field '${bad}': unknown field`, { fields: [{ name: bad, messages: ["unknown field"] }] });
  };
  const imgAction = (a: { imageId: number; polls: number }, id: number, serverId: number) => {
    const image = world.images.find((x) => x.id === a.imageId)!;
    const done = !world.imageStuck && !world.imageActionError && a.polls >= world.imageSteps;
    if (done && image.status === "creating") { image.status = "available"; image.image_size = 1.5; }
    const status = world.imageActionError ? "error" : done ? "success" : "running";
    return { id, command: "create_image", status, progress: done ? 100 : 40, started: "2026-01-01T00:00:00+00:00", finished: status === "running" ? null : "2026-01-01T00:00:05+00:00", resources: [{ id: serverId, type: "server" }], error: status === "error" ? { code: "action_failed", message: "Action failed" } : null };
  };
  const badLabels = (l: unknown): Reply | null => {
    if (l === undefined) return null;
    if (typeof l !== "object" || l === null) return err(422, "invalid_input", "invalid input in field 'labels'", { fields: [{ name: "labels", messages: ["is not an object"] }] });
    for (const [k, v] of Object.entries(l)) if (!LABEL_KEY.test(k) || typeof v !== "string" || !LABEL_VALUE.test(v)) return err(422, "invalid_input", `invalid input in field 'labels': ${JSON.stringify(k)}`, { fields: [{ name: "labels", messages: ["invalid label"] }] });
    return null;
  };

  function route(method: string, url: URL, body: Body): Reply {
    const parts = url.pathname.slice(3).split("/").filter(Boolean); // after /v1
    const [res, id, sub, sub2] = parts;
    const lookup = (arr: Array<Record<string, unknown>>) => arr.find((x) => String(x.id) === id);
    const notFound = err(404, "not_found", "not found");
    const only = (...m: string[]) => (m.includes(method) ? null : err(405, "method_not_allowed", "The request method is not allowed"));
    switch (res) {
      case "locations": return only("GET") ?? page(url, "locations", LOCATIONS);
      case "server_types": return only("GET") ?? page(url, "server_types", TYPES);
      case "pricing": return only("GET") ?? { status: 200, body: { pricing: { currency: "EUR", vat_rate: "19.00", primary_ips: [{ type: "ipv4", prices: LOCATIONS.map((l) => ({ location: l.name, price_hourly: money("0.0008"), price_monthly: money("0.5000") })) }, { type: "ipv6", prices: [] }], server_types: TYPES.map((t) => ({ id: t.id, name: t.name, prices: t.prices })), image: { price_per_gb_month: money("0.0119") }, volume: { price_per_gb_month: money("0.0440") } } } };
      case "actions": {
        const e = only("GET");
        if (e) return e;
        const tracked = id === undefined ? undefined : world.imageActions.get(Number(id));
        if (tracked) { tracked.polls++; return { status: 200, body: { action: imgAction(tracked, Number(id), Number(((world.images.find((x) => x.id === tracked.imageId)!).created_from as { id: number }).id)) } }; }
        if (id) return { status: 200, body: { action: act("x", 1) } };
        const ids = url.searchParams.getAll("id");
        if (ids.length === 0) return err(422, "invalid_input", "invalid input in field 'id': is required", { fields: [{ name: "id", messages: ["is required"] }] });
        return { status: 200, body: { actions: ids.map((i) => ({ ...act("x", 1), id: Number(i) })) } };
      }
      case "servers": {
        if (!id) {
          if (method === "GET") return page(url, "servers", bySelector(url, world.servers));
          if (method !== "POST") return only("GET", "POST")!;
          const uf = unknownField(body, SERVER_FIELDS);
          if (uf) return uf;
          if (typeof body.image === "number") {
            const im = world.images.find((x) => x.id === body.image);
            if (!im) return err(422, "invalid_input", "invalid input in field 'image': image not found", { fields: [{ name: "image", messages: ["not found"] }] });
            if (im.status !== "available") return err(422, "invalid_input", "invalid input in field 'image': image is not available", { fields: [{ name: "image", messages: ["not available"] }] });
          }
          for (const f of ["name", "server_type", ...(typeof body.image === "number" ? [] : ["image"])]) if (typeof body[f] !== "string" || body[f] === "") return err(422, "invalid_input", `invalid input in field '${f}': is required`, { fields: [{ name: f, messages: ["is required"] }] });
          const bl = badLabels(body.labels);
          if (bl) return bl;
          if (typeof body.user_data === "string" && Buffer.byteLength(body.user_data) > 32 * 1024) return err(422, "invalid_input", "invalid input in field 'user_data': is too long", { fields: [{ name: "user_data", messages: ["is too long"] }] });
          if (!TYPES.some((x) => x.name === body.server_type)) return err(422, "invalid_input", "invalid input in field 'server_type': not found", { fields: [{ name: "server_type", messages: ["not found"] }] });
          if (!LOCATIONS.some((x) => x.name === body.location)) return err(422, "invalid_input", "invalid input in field 'location': not found", { fields: [{ name: "location", messages: ["not found"] }] });
          if (world.servers.length >= world.serverLimit) return err(403, "resource_limit_exceeded", "server limit exceeded", { limits: [{ name: "server_limit" }] });
          if (world.servers.some((s) => s.name === body.name)) return err(409, "uniqueness_error", "server name is already used", { fields: [{ name: "name" }] });
          if (!TYPES.find((x) => x.name === body.server_type)!.locations.some((l) => l.name === body.location && l.available)) return err(412, "resource_unavailable", "requested resource is unavailable");
          const s = server(body);
          world.servers.push(s);
          return { status: 201, body: { server: s, action: act("create_server", s.id), next_actions: [act("start_server", s.id)], root_password: "fake-root-password-SECRET" } };
        }
        const s = lookup(world.servers);
        if (!s) return notFound;
        if (!sub) {
          if (method === "GET") return { status: 200, body: { server: s } };
          if (method === "PUT") {
            if (typeof body.name !== "string" || body.name === "") return err(422, "invalid_input", "invalid input in field 'name'", { fields: [{ name: "name", messages: ["is required"] }] });
            if (world.servers.some((o) => o !== s && o.name === body.name)) return err(409, "uniqueness_error", "server name is already used", { fields: [{ name: "name" }] });
            s.name = body.name;
            return { status: 200, body: { server: s } };
          }
          if (method === "DELETE") { world.servers.splice(world.servers.indexOf(s), 1); return { status: 200, body: world.malformedAction ? { action: { id: "not-a-number" } } : world.deleteOmitsAction ? {} : { action: act("delete_server", s.id as number) } }; }
          return only("GET", "PUT", "DELETE")!;
        }
        if (sub === "actions" && sub2 === "create_image") {
          if (method !== "POST") return only("POST")!;
          const uf = unknownField(body, new Set(["type", "description", "labels"]));
          if (uf) return uf;
          if (body.type !== "snapshot") return err(422, "invalid_input", "invalid input in field 'type': must be snapshot", { fields: [{ name: "type", messages: ["must be snapshot"] }] });
          if (body.description !== undefined && typeof body.description !== "string") return err(422, "invalid_input", "invalid input in field 'description'", { fields: [{ name: "description", messages: ["is not a string"] }] });
          const bl = badLabels(body.labels);
          if (bl) return bl;
          const image = { id: ++nextId, status: "creating", type: "snapshot", name: null, description: body.description ?? null, image_size: null, disk_size: 40, created: "2026-01-01T00:00:00+00:00", created_from: { id: s.id, name: s.name }, bound_to: null, os_flavor: "ubuntu", os_version: null, rapid_deploy: false, protection: { delete: false }, deprecated: null, deleted: null, architecture: "x86", labels: body.labels ?? {} };
          world.images.push(image);
          const a = { imageId: image.id, polls: 0 };
          const aid = ++nextId;
          world.imageActions.set(aid, a);
          return { status: 201, body: { image, action: imgAction(a, aid, s.id as number) } };
        }
        if (sub === "actions" && ["reboot", "poweron", "poweroff"].includes(sub2 ?? "")) return only("POST") ?? { status: 201, body: { action: world.malformedAction ? { id: "not-a-number" } : act(`${sub2}_server`, s.id as number) } };
        return notFound;
      }
      case "firewalls": {
        if (!id) {
          if (method === "GET") return page(url, "firewalls", bySelector(url, world.firewalls));
          if (method !== "POST") return only("GET", "POST")!;
          if (typeof body.name !== "string" || !Array.isArray(body.rules)) return err(422, "invalid_input", "invalid input in field 'name'", { fields: [{ name: "name", messages: ["is required"] }] });
          if (world.firewalls.some((f) => f.name === body.name)) return err(409, "uniqueness_error", "firewall name is already used", { fields: [{ name: "name" }] });
          const f = { id: ++nextId, name: body.name, labels: body.labels ?? {}, created: "2026-01-01T00:00:00+00:00", rules: body.rules, applied_to: [] };
          world.firewalls.push(f);
          return { status: 201, body: { firewall: f, actions: [] } };
        }
        const f = lookup(world.firewalls);
        if (!f) return notFound;
        if (method === "GET") return { status: 200, body: { firewall: f } };
        if (method === "DELETE") {
          // delete_firewall in https://docs.hetzner.cloud/cloud.spec.json (DELETE /firewalls/{id}): "Operation specific errors" lists 422 `resource_in_use`, "Firewall still applied to a resource". Not 409.
          const inUse = world.servers.some((x) => ((x.public_net as { firewalls?: Array<{ id: number }> } | undefined)?.firewalls ?? []).some((a) => a.id === f.id));
          if (inUse) return err(422, "resource_in_use", "firewall is still applied to a resource", { fields: [{ name: "id" }] });
          world.firewalls.splice(world.firewalls.indexOf(f), 1);
          return { status: 204 };
        }
        return only("GET", "DELETE")!;
      }
      case "images": {
        if (!id) {
          if (method !== "GET") return only("GET")!;
          const type = url.searchParams.get("type");
          if (type !== null && !["system", "app", "snapshot", "backup"].includes(type)) return err(422, "invalid_input", "invalid input in field 'type'", { fields: [{ name: "type", messages: ["invalid"] }] });
          return page(url, "images", bySelector(url, world.images).filter((x) => !type || x.type === type));
        }
        const im = lookup(world.images);
        if (!im) return notFound;
        if (method === "GET") return { status: 200, body: { image: im } };
        if (method === "DELETE") {
          if ((im.protection as { delete: boolean }).delete) return err(403, "protected", "image is protected");
          if (im.status === "creating" || im.locked === true) return err(423, "locked", "item is locked");
          world.images.splice(world.images.indexOf(im), 1);
          return { status: 204 };
        }
        return only("GET", "DELETE")!;
      }
      case "ssh_keys": {
        if (!id) {
          if (method === "GET") return page(url, "ssh_keys", bySelector(url, world.sshKeys).filter((k) => !url.searchParams.get("fingerprint") || k.fingerprint === url.searchParams.get("fingerprint")));
          if (method !== "POST") return only("GET", "POST")!;
          if (typeof body.name !== "string" || typeof body.public_key !== "string") return err(422, "invalid_input", "invalid input in field 'public_key'", { fields: [{ name: "public_key", messages: ["is required"] }] });
          const fingerprint = `fp:${body.public_key.slice(-16)}`;
          if (world.sshKeys.some((k) => k.fingerprint === fingerprint)) return err(409, "uniqueness_error", "SSH key with the same fingerprint already exists", { fields: [{ name: "public_key" }] });
          const k = { id: ++nextId, name: body.name, fingerprint, public_key: body.public_key, labels: body.labels ?? {}, created: "2026-01-01T00:00:00+00:00" };
          world.sshKeys.push(k);
          return { status: 201, body: { ssh_key: k } };
        }
        const k = lookup(world.sshKeys);
        if (!k) return notFound;
        if (method === "DELETE") { world.sshKeys.splice(world.sshKeys.indexOf(k), 1); return { status: 204 }; }
        return only("DELETE")!;
      }
      default: return notFound;
    }
  }

  const server_ = https.createServer({ cert: certPem, key: keyPem }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(", ") : v;
      const raw = Buffer.concat(chunks).toString("utf8");
      const method = req.method ?? "GET";
      world.requests.push({ method, path: req.url ?? "/", headers, body: raw });
      const at = world.failNext.findIndex((f) => f.method === undefined || f.method === method);
      const injected = at < 0 ? undefined : world.failNext.splice(at, 1)[0];
      if (injected?.hang) return;
      if (injected?.drop) return void req.socket.destroy();
      const elapsed = (world.clock.t - lastRefill) / 1000;
      lastRefill = world.clock.t;
      world.remaining = Math.min(world.limit, world.remaining + elapsed * (world.limit / 3600));
      const send = (r: Reply): void => {
        const reset = Math.ceil(world.clock.t / 1000 + (world.limit - world.remaining) * (3600 / world.limit));
        res.writeHead(r.status, { ...(r.body === undefined ? {} : { "content-type": "application/json" }), "RateLimit-Limit": String(world.limit), "RateLimit-Remaining": String(Math.floor(world.remaining)), "RateLimit-Reset": String(reset), ...r.headers });
        res.end(r.body === undefined ? undefined : JSON.stringify(r.body));
      };
      if (Math.floor(world.remaining) <= 0) return send(err(429, "rate_limit_exceeded", "limit of 3600 requests per hour reached"));
      world.remaining -= 1;
      if (!req.url?.startsWith("/v1/")) return send(err(404, "not_found", "not found"));
      const auth = headers["authorization"] ?? "";
      if (!auth.startsWith("Bearer ") || !world.tokens.has(auth.slice(7))) return send(err(401, "unauthorized", "unable to authenticate"));
      if (method !== "GET" && world.readOnlyTokens?.has(auth.slice(7))) return send(err(403, "forbidden", "insufficient permissions"));
      let body: Body = {};
      if (method === "POST" || method === "PUT") {
        if (!injected?.after && !/^application\/json/i.test(headers["content-type"] ?? "")) return send(err(400, "json_error", "invalid JSON input"));
        if (!injected?.after || /^application\/json/i.test(headers["content-type"] ?? "")) { try { body = JSON.parse(raw || "{}") as Body; } catch { return send(err(400, "json_error", "invalid JSON input")); } }
      }
      if (injected?.after) {
        route(method, new URL(req.url, "https://api.hetzner.cloud"), body); // the write commits
        if (injected.after === "hang") return;
        if (injected.after === "drop") return void req.socket.destroy();
        return send(err(500, "server_error", "injected failure after the write"));
      }
      if (injected) return send(err(injected.status ?? 500, injected.code ?? "server_error", injected.message ?? "injected failure"));
      send(route(method, new URL(req.url, "https://api.hetzner.cloud"), body));
    });
  });
  await new Promise<void>((resolve, reject) => { server_.once("error", reject); server_.listen(0, "127.0.0.1", () => resolve()); });
  return {
    port: (server_.address() as AddressInfo).port, ca: certPem, world,
    lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    close: () => new Promise<void>((resolve, reject) => { server_.close((e) => (e ? reject(e) : resolve())); server_.closeAllConnections?.(); }),
  };
}
