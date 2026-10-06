// D#37 WS-F15b: the Developer app's API reference tab. It reads the public
// OpenAPI 3.1 document (GET /api/v1/openapi.json, anonymous, same origin) and
// draws it natively: grouped, searchable, one collapsible entry per operation,
// with a copyable curl for every operation an API token can call.
//
// Rules this file keeps (D#37 corrections C39 and C40):
//   * Every node is built with h() (createElement / createTextNode) and every
//     string from the document reaches the page as a text node. Descriptions go
//     through renderMarkdown unchanged. Nothing here uses innerHTML or a URL
//     taken from the document, so a hostile spec cannot become markup.
//   * The document is fetched when the tab is first mounted (the first time it
//     is opened), through api(), never when the app opens, and never again
//     unless the person presses Try again. Live events do not touch it.
//   * An operation's detail is built the first time it is expanded.
//   * curl text only ever names the placeholder $FULCRUMAXE_TOKEN. This file
//     imports nothing from developer-tokens.js, so it cannot see a token.
//   * A curl is offered only for a path made of URL-safe characters, and the
//     JSON body is one single-quoted word ('  becomes  '\'' ).
// This module adds one boot file. It imports the shared DOM, fetch and
// markdown helpers from ../_lib/.
import { h } from "../_lib/dom.js";
import { api } from "../_lib/api.js";
import { renderMarkdown } from "../_lib/markdown.js";

const SPEC_URL = "/api/v1/openapi.json";
const METHODS = ["get", "put", "post", "patch", "delete", "head", "options"];
const MAX_DEPTH = 6;
const CURL_PATH = /^\/api\/v1\/[A-Za-z0-9_./{}-]+$/;
const SAFE_ORIGIN = /^https?:\/\/[A-Za-z0-9.[\]:-]+$/;
const EVENT_PROP = /^event_types?$/;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const text = (v) => (typeof v === "string" ? v : "");

function show(v) {
  if (typeof v === "string") return v;
  try {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s;
  } catch {
    return String(v);
  }
}

// ── the document ────────────────────────────────────────────────────────

function pointer(doc, ref) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) return null;
  let cur = doc;
  for (const raw of ref.slice(2).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (cur === null || typeof cur !== "object" || !hasOwn(cur, key)) return null;
    cur = cur[key];
  }
  return cur;
}

const refName = (ref) => String(ref).split("/").pop().replace(/~1/g, "/").replace(/~0/g, "~");

/** A node with a leading $ref replaced by what it points at (one hop). */
function deref(doc, node) {
  if (isObj(node) && typeof node.$ref === "string") return pointer(doc, node.$ref);
  return node;
}

function collectOps(doc) {
  const ops = [];
  for (const path of Object.keys(doc.paths)) {
    const item = doc.paths[path];
    if (!isObj(item)) continue;
    for (const method of METHODS) {
      const op = item[method];
      if (!isObj(op)) continue;
      const area = (/^\/api\/v1\/([^/]+)/.exec(path) || [])[1] || "other";
      const tag = Array.isArray(op.tags) && typeof op.tags[0] === "string" && op.tags[0] ? op.tags[0] : null;
      const params = [].concat(Array.isArray(item.parameters) ? item.parameters : [], Array.isArray(op.parameters) ? op.parameters : []);
      const label = method.toUpperCase();
      ops.push({
        method: label,
        path,
        op,
        params,
        area,
        group: tag || area,
        hay: [label, path, text(op.summary), text(op.operationId)].join("\n").toLowerCase(),
      });
    }
  }
  return ops;
}

/** How an operation can be called, from its security entries. */
function access(doc, op) {
  // The operation's own list wins, then the document's; an empty list, or an empty requirement, means no authentication.
  const own = Array.isArray(op.security) ? op.security : Array.isArray(doc.security) ? doc.security : null;
  if (own && (!own.length || own.some((e) => isObj(e) && !Object.keys(e).length))) return { kind: "none" };
  const sec = own ? own.filter(isObj) : [];
  const token = sec.find((e) => hasOwn(e, "token"));
  if (!token) return { kind: "session" };
  if (op["x-fx-token-self-only"] === true) return { kind: "self" };
  const scopes = Array.isArray(token.token) ? token.token.filter((s) => typeof s === "string" && s) : [];
  return { kind: "token", both: sec.some((e) => hasOwn(e, "session")), scopes };
}

// ── curl ────────────────────────────────────────────────────────────────

const quote = (s) => "'" + s.replace(/'/g, "'\\''") + "'";

/** A placeholder value by type, filled in for required properties only. */
function placeholder(doc, s, depth, seen) {
  if (depth > MAX_DEPTH || !isObj(s)) return null;
  if (typeof s.$ref === "string") {
    if (seen.has(s.$ref)) return null;
    return placeholder(doc, pointer(doc, s.$ref), depth + 1, new Set(seen).add(s.$ref));
  }
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== "null") : s.type;
  if (type === "string") return "string";
  if (type === "integer" || type === "number") return 0;
  if (type === "boolean") return false;
  if (type === "array") {
    const item = placeholder(doc, s.items, depth + 1, seen);
    return item === null ? [] : [item];
  }
  if (type === "object" || isObj(s.properties)) {
    const out = Object.create(null);
    const props = isObj(s.properties) ? s.properties : {};
    for (const name of Array.isArray(s.required) ? s.required : []) {
      if (typeof name === "string") out[name] = hasOwn(props, name) ? placeholder(doc, props[name], depth + 1, seen) : null;
    }
    return out;
  }
  return null;
}

function bodySchema(doc, op) {
  const rb = deref(doc, op.requestBody);
  const json = isObj(rb) && isObj(rb.content) ? rb.content["application/json"] : null;
  return isObj(json) ? { schema: json.schema } : null;
}

function curlFor(doc, entry, acc) {
  if (acc.kind === "session" || !CURL_PATH.test(entry.path) || !SAFE_ORIGIN.test(location.origin)) return null;
  let cmd = 'curl -X ' + entry.method + ' "' + location.origin + entry.path + '"' + (acc.kind === "none" ? "" : ' -H "Authorization: Bearer $FULCRUMAXE_TOKEN"');
  const body = bodySchema(doc, entry.op);
  if (body) {
    const value = placeholder(doc, body.schema, 0, new Set());
    cmd += ' -H "Content-Type: application/json" -d ' + quote(JSON.stringify(isObj(value) ? value : {}));
  }
  return cmd;
}

// ── schemas ─────────────────────────────────────────────────────────────

function typeLabel(doc, s, depth) {
  if (!isObj(s)) return "any";
  if (typeof s.$ref === "string") return refName(s.$ref);
  let t = Array.isArray(s.type) ? s.type.join(" | ") : typeof s.type === "string" ? s.type : isObj(s.properties) ? "object" : "any";
  if (t === "array") t = "array of " + (depth >= MAX_DEPTH ? "…" : typeLabel(doc, s.items, depth + 1));
  if (typeof s.format === "string") t += " (" + s.format + ")";
  return t;
}

function eventButton(ctx, value) {
  return h(
    "button",
    { type: "button", class: "dev-btn dev-ref-manage", "data-testid": "dev-ref-manage-event", onClick: () => ctx.show("webhooks") },
    "Manage in Webhooks",
    h("span", { class: "dev-ref-sr" }, " for " + show(value))
  );
}

/** The nodes that describe one schema. `seen` guards $ref cycles; MAX_DEPTH stops the rest. */
function describe(ctx, s, depth, seen, isEvent) {
  const doc = ctx.doc;
  if (!isObj(s)) return [h("span", { class: "dev-ref-type" }, "any")];
  if (typeof s.$ref === "string") {
    const name = h("span", { class: "dev-ref-type" }, refName(s.$ref));
    const target = pointer(doc, s.$ref);
    if (!isObj(target) || seen.has(s.$ref) || depth >= MAX_DEPTH) return [name];
    return [name, ...describe(ctx, target, depth + 1, new Set(seen).add(s.$ref), isEvent)];
  }
  const out = [h("span", { class: "dev-ref-type" }, typeLabel(doc, s, depth))];
  if (Array.isArray(s.enum)) {
    const list = h("span", { class: "dev-ref-enum" }, "one of: ");
    for (const v of s.enum) {
      list.appendChild(h("code", { class: "dev-ref-value" }, show(v)));
      if (isEvent) list.appendChild(eventButton(ctx, v));
    }
    out.push(list);
  }
  const examples = s.example !== undefined ? [s.example] : Array.isArray(s.examples) ? s.examples : [];
  if (examples.length) out.push(h("span", { class: "dev-ref-example" }, "example: ", examples.map((e) => h("code", { class: "dev-ref-value" }, show(e)))));
  if (typeof s.description === "string" && s.description) out.push(renderMarkdown(s.description));
  if (depth >= MAX_DEPTH) return out;
  if (isObj(s.properties)) {
    const req = new Set(Array.isArray(s.required) ? s.required : []);
    out.push(
      h(
        "ul",
        { class: "dev-ref-props" },
        Object.keys(s.properties).map((name) =>
          h(
            "li",
            null,
            h("code", { class: "dev-ref-prop" }, name),
            req.has(name) ? h("span", { class: "dev-ref-req" }, " required") : null,
            " ",
            describe(ctx, s.properties[name], depth + 1, seen, EVENT_PROP.test(name))
          )
        )
      )
    );
  }
  if (s.items !== undefined) out.push(h("div", { class: "dev-ref-items" }, "items: ", describe(ctx, s.items, depth + 1, seen, isEvent)));
  for (const key of ["oneOf", "anyOf", "allOf"]) {
    if (Array.isArray(s[key])) {
      out.push(h("ul", { class: "dev-ref-props" }, s[key].map((v) => h("li", null, key + ": ", describe(ctx, v, depth + 1, seen, isEvent)))));
    }
  }
  return out;
}

const collapsible = (label, body) => h("details", { class: "dev-ref-schema", "data-testid": "dev-ref-schema" }, h("summary", null, label), body);

// ── one operation ───────────────────────────────────────────────────────

function callableLines(acc) {
  if (acc.kind === "session") return [h("p", { "data-testid": "dev-ref-access" }, "Browser session only, not with an API token")];
  if (acc.kind === "none") return [h("p", { "data-testid": "dev-ref-access" }, "No authentication needed")];
  if (acc.kind === "self") return [h("p", { "data-testid": "dev-ref-access" }, "API token (only for the token itself)")];
  return [
    h("p", { "data-testid": "dev-ref-access" }, acc.both ? "API token or browser session" : "API token"),
    h("p", { "data-testid": "dev-ref-scope" }, "Token scope: " + (acc.scopes.length ? acc.scopes.join(", ") : "not listed in this reference")),
  ];
}

function buildDetail(ctx, entry) {
  const { doc } = ctx;
  const { op } = entry;
  const acc = access(doc, op);
  const box = h("div", { class: "dev-ref-detail", "data-testid": "dev-ref-detail" });
  box.append(...callableLines(acc));
  if (typeof op.description === "string" && op.description) box.appendChild(renderMarkdown(op.description));

  const params = entry.params.map((p) => deref(doc, p)).filter(isObj);
  if (params.length) {
    box.appendChild(h("h4", { class: "dev-ref-sub" }, "Parameters"));
    box.appendChild(
      h(
        "ul",
        { class: "dev-ref-props", "data-testid": "dev-ref-params" },
        params.map((p) =>
          h(
            "li",
            null,
            h("code", { class: "dev-ref-prop" }, text(p.name)),
            " in " + text(p.in) + ", " + (p.required === true ? "required" : "optional") + ", ",
            h("span", { class: "dev-ref-type" }, typeLabel(doc, p.schema, 0)),
            typeof p.description === "string" && p.description ? renderMarkdown(p.description) : null
          )
        )
      )
    );
  }

  const body = bodySchema(doc, op);
  if (body) box.appendChild(collapsible("Request body", h("div", null, describe(ctx, body.schema, 0, new Set(), false))));

  const responses = isObj(op.responses) ? op.responses : {};
  const errors = [];
  for (const code of Object.keys(responses)) {
    const res = deref(doc, responses[code]);
    if (!isObj(res)) continue;
    const desc = text(res.description);
    if (/^[45](\d\d|XX)$/i.test(code)) {
      errors.push(h("li", null, h("code", null, code), " " + desc));
      continue;
    }
    const json = isObj(res.content) ? res.content["application/json"] : null;
    const label = (code === "default" ? "default (any other status)" : code) + " " + desc;
    box.appendChild(isObj(json) ? collapsible(label, h("div", null, describe(ctx, json.schema, 0, new Set(), false))) : h("p", null, label));
  }
  if (errors.length) {
    box.appendChild(h("h4", { class: "dev-ref-sub" }, "Error responses"));
    box.appendChild(h("ul", { class: "dev-ref-props", "data-testid": "dev-ref-errors" }, errors));
  }

  const curl = curlFor(doc, entry, acc);
  if (curl) {
    const note = h("span", { class: "dev-ref-copy-note", role: "status", "aria-live": "polite", "data-testid": "dev-ref-copy-note" });
    const copy = h(
      "button",
      {
        type: "button",
        class: "dev-btn",
        "data-testid": "dev-ref-copy",
        onClick: async () => {
          try {
            await navigator.clipboard.writeText(curl);
            note.textContent = "Copied to the clipboard.";
          } catch {
            note.textContent = "Couldn't copy. Select the text and copy it.";
          }
        },
      },
      "Copy curl"
    );
    box.appendChild(h("h4", { class: "dev-ref-sub" }, "curl"));
    box.appendChild(h("pre", { class: "dev-ref-code", tabindex: 0, "data-testid": "dev-ref-curl" }, curl));
    box.appendChild(h("div", { class: "dev-ref-actions" }, copy, note));
  }
  if (entry.area === "webhook-endpoints") {
    box.appendChild(
      h(
        "button",
        { type: "button", class: "dev-btn dev-ref-manage", "data-testid": "dev-ref-manage-op", onClick: () => ctx.show("webhooks") },
        "Manage in Webhooks"
      )
    );
  }
  return box;
}

function opNode(ctx, entry) {
  const summary = text(entry.op.summary);
  const el = h(
    "details",
    { class: "dev-ref-op", "data-testid": "dev-ref-op" },
    h(
      "summary",
      null,
      h("span", { class: "dev-ref-method dev-ref-m-" + entry.method.toLowerCase() }, entry.method),
      " ",
      h("code", { class: "dev-ref-path" }, entry.path),
      summary ? h("span", { class: "dev-ref-sum" }, summary) : null
    )
  );
  let built = false;
  el.addEventListener("toggle", () => {
    if (!el.open || built) return;
    built = true;
    try {
      el.appendChild(buildDetail(ctx, entry));
    } catch {
      el.appendChild(h("p", { class: "dev-muted" }, "This endpoint couldn't be shown."));
    }
  });
  entry.el = el;
  return el;
}

// ── the tab ─────────────────────────────────────────────────────────────

export function mountApiRef(host, showTab) {
  const abort = new AbortController();
  let groups = [];

  const root = h("div", { class: "dev-app dev-ref", "data-testid": "dev-ref-app" });
  const status = h("p", { class: "dev-status", role: "status", "aria-live": "polite", "data-testid": "dev-ref-status" });
  const retry = h("button", { type: "button", class: "dev-btn", hidden: true, "data-testid": "dev-ref-retry", onClick: () => load() }, "Try again");
  const intro = h("div", { class: "dev-ref-intro", "data-testid": "dev-ref-intro" });
  const search = h("input", {
    type: "search",
    class: "dev-input dev-ref-search-input",
    maxLength: 100,
    autocomplete: "off",
    "data-testid": "dev-ref-search",
    onInput: () => applyFilter(),
  });
  const searchBox = h("label", { class: "dev-ref-search", hidden: true }, h("span", { class: "dev-muted" }, "Search endpoints"), search);
  const noMatch = h("p", { class: "dev-banner", hidden: true, "data-testid": "dev-ref-nomatch" });
  const list = h("div", { class: "dev-ref-list", "data-testid": "dev-ref-list" });
  // The search box comes before the intro so that Tab reaches it first, ahead
  // of any link in the document's own description.
  root.append(h("h2", { class: "dev-title" }, "API reference"), searchBox, status, retry, intro, noMatch, list);
  host.replaceChildren(root);

  function fail(message) {
    status.textContent = message;
    status.className = "dev-status dev-status-on dev-status-error";
    retry.hidden = false;
  }

  function applyFilter() {
    const q = search.value.trim().toLowerCase();
    let total = 0;
    for (const g of groups) {
      let n = 0;
      for (const e of g.entries) {
        const hit = !q || e.hay.includes(q);
        e.el.hidden = !hit;
        if (hit) n++;
      }
      g.el.hidden = n === 0;
      g.count.textContent = " (" + n + ")";
      total += n;
    }
    noMatch.hidden = !(q && total === 0);
    if (!noMatch.hidden) noMatch.replaceChildren("No endpoints match ", h("q", { "data-testid": "dev-ref-query" }, search.value.trim()));
  }

  function render(doc) {
    const ctx = { doc, show: showTab };
    const info = isObj(doc.info) ? doc.info : {};
    intro.replaceChildren(
      h("p", { class: "dev-muted" }, [text(info.title), text(info.version) && " " + info.version].filter(Boolean).join(" ")),
      ...(typeof info.description === "string" && info.description ? [renderMarkdown(info.description)] : [])
    );
    const byName = new Map();
    for (const entry of collectOps(doc)) {
      let g = byName.get(entry.group);
      if (!g) {
        g = { name: entry.group, entries: [], count: h("span", { class: "dev-muted" }), el: null };
        byName.set(entry.group, g);
      }
      g.entries.push(entry);
    }
    groups = [...byName.values()];
    for (const g of groups) {
      g.el = h(
        "section",
        { class: "dev-ref-group", "data-testid": "dev-ref-group" },
        h("h3", { class: "dev-subtitle", "data-testid": "dev-ref-group-heading" }, g.name, g.count),
        g.entries.map((e) => opNode(ctx, e))
      );
    }
    // dom-insert-ok: the loop above gave every group its el (g.el starts null only inside the group builder)
    list.replaceChildren(...groups.map((g) => g.el));
    searchBox.hidden = false;
    applyFilter();
  }

  async function load() {
    retry.hidden = true;
    status.className = "dev-status";
    status.textContent = "Loading the API reference…";
    let doc;
    try {
      doc = await api("GET", SPEC_URL, undefined, abort.signal);
    } catch (e) {
      if (e && e.name === "AbortError") return;
      return fail("Couldn't load the API reference.");
    }
    try {
      if (!isObj(doc) || !isObj(doc.paths)) return fail("The API reference couldn't be read.");
      render(doc);
      status.textContent = "";
    } catch {
      fail("The API reference couldn't be read.");
    }
  }

  load();

  return {
    revealOpen: () => false,
    destroy() {
      abort.abort();
      host.replaceChildren();
    },
  };
}
