// apps/workspace/e2e/helpers/context-mock.ts
//
// D#600 CX-9b: a stateful stand-in for the five context routes (packages/api/src/routes/context-rules.ts and context-settings.ts) and for
// /api/cloud/auth/me. It enforces what the real routes do that the panel touches: exactly one of repo_id and work_item_id on a read; a strict
// write body with a scope that names its own id; the server's path rules; a member writing item rules only; the other kind saved on the same
// scope and path replaces the rule; a pin set measured against the budget, with the 500-pin and 500-exclude ceilings; a removal that would bring
// pinned files back over the budget answering 409 until `?confirm=true`; the budget's range and the pins_status of the answer. Error bodies are the
// envelope the routes send (packages/api/fixtures/v1/**). Every request is recorded as "METHOD path?query" for the tests to read.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page, Route } from "@playwright/test";

const V1 = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "packages", "api", "fixtures", "v1");
const fixture = (...p: string[]) => JSON.parse(readFileSync(join(V1, ...p), "utf8"));
export const SETTINGS_FIXTURE = fixture("getRepoContextSettings", "200-ok.json");
export const REPO_ID = "33333333-3333-4333-8333-333333333333";
export const ITEM_ID = "22222222-2222-4222-8222-222222222222";

export interface Rule { id: string; scope: "repo" | "item"; kind: "pin" | "exclude"; path: string; repo_id: string | null; work_item_id: string | null }
export interface ContextMock {
  rules: Rule[];
  budget: number | null;
  isAdmin: boolean;
  /** Bytes a pinned path weighs when the budget is measured (default 1000). */
  size: Record<string, number>;
  /** Replies forced for the next calls of a kind ("PUT", "DELETE", "GET list", "GET settings", "PUT settings"), oldest first. */
  forced: Record<string, { status: number; code: string; headers?: Record<string, string> }[]>;
  requests: string[];
  bodies: unknown[];
}

let seq = 0;
export const uuid = () => "c" + (++seq).toString(16).padStart(7, "0") + "-0000-4000-8000-000000000000";
export const ruleOf = (scope: "repo" | "item", kind: "pin" | "exclude", path: string, ids = { repo: REPO_ID, item: ITEM_ID }): Rule => ({
  id: uuid(), scope, kind, path, repo_id: scope === "repo" ? ids.repo : null, work_item_id: scope === "item" ? ids.item : null,
});

/** A small stand-in for excludeCovers: the path itself, a folder prefix, or a glob where ** crosses folders, * stays in one and ? is one character. */
const covers = (pattern: string, path: string) => {
  const re = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, ".*");
  return new RegExp(`^${re}$`).test(path) || path.startsWith(pattern.replace(/\/$/, "") + "/");
};
const ruleable = (p: string) => !(p === "" || [...p].length > 512 || /[\p{Cc}\\]/u.test(p) || p.startsWith("/") || p.startsWith("~") || p.split("/").some((s) => s === "" || s === "." || s === ".."));
const MESSAGES: Record<string, string> = {
  pins_exceed_budget: "the pinned files would not fit the repository's context budget",
  pins_exceed_ceiling: "a run can carry at most 500 pinned files",
  excludes_exceed_cap: "a run can hold at most 500 excluded paths",
  exclude_readds_pins: "removing this exclude puts pinned files back in this item's runs and they no longer fit the budget; repeat with confirm=true to remove it anyway",
  invalid_path: "that path cannot be used",
  insufficient_role: "insufficient account role",
  not_found: "not found",
  tree_unavailable: "the repository could not be read just now; nothing was saved",
  validation_failed: "bad request",
};
export const serverText = (code: string) => MESSAGES[code] ?? code;
const envelope = (code: string) => ({ error: { code, message: serverText(code), request_id: "33333333-3333-4333-8333-333333333333" } });

export function newContextMock(over: Partial<ContextMock> = {}): ContextMock {
  return { rules: [], budget: null, isAdmin: true, size: {}, forced: {}, requests: [], bodies: [], ...over };
}

export async function installContextRoutes(page: Page, m: ContextMock): Promise<void> {
  const json = (route: Route, status: number, body: unknown, headers: Record<string, string> = {}) =>
    route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(body) });
  const bytesOf = (p: string) => m.size[p] ?? 1000;
  const budgetOf = () => m.budget ?? SETTINGS_FIXTURE.role_defaults.executor;
  /** The rules in force for an item: its own, and the repository's for every path the item has no rule on. */
  const inForce = (itemId: string) => {
    const own = m.rules.filter((r) => r.work_item_id === itemId);
    const paths = new Set(own.map((r) => r.path));
    return [...own, ...m.rules.filter((r) => r.scope === "repo" && !paths.has(r.path))];
  };
  const pinTotal = (rules: Rule[]) => rules.filter((r) => r.kind === "pin").reduce((n, r) => n + bytesOf(r.path), 0);
  const forced = (key: string, route: Route) => {
    const f = m.forced[key]?.shift();
    return f ? json(route, f.status, envelope(f.code), f.headers) : null;
  };

  await page.route("**/api/cloud/auth/me", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), is_admin: m.isAdmin } });
  });

  await page.route("**/api/v1/context-rules**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    m.requests.push(`${method} ${url.pathname}${url.search}`);
    const isList = url.pathname === "/api/v1/context-rules";
    if (method === "GET") {
      const f = forced("GET list", route);
      if (f) return f;
      const keys = [...url.searchParams.keys()];
      const repo = url.searchParams.get("repo_id"), item = url.searchParams.get("work_item_id");
      if (!isList || keys.length !== 1 || (repo === null) === (item === null)) return json(route, 422, envelope("validation_failed"));
      return json(route, 200, { data: repo ? m.rules.filter((r) => r.repo_id === repo) : inForce(item!) });
    }
    if (method === "PUT" && isList) {
      const f = forced("PUT", route);
      if (f) return f;
      const b = JSON.parse(req.postData() ?? "null");
      m.bodies.push(b);
      const allowed = new Set(["scope", "repo_id", "work_item_id", "kind", "path"]);
      const shape = b && typeof b === "object" && Object.keys(b).every((k) => allowed.has(k)) && ["repo", "item"].includes(b.scope) && ["pin", "exclude"].includes(b.kind) && typeof b.path === "string"
        && (b.scope === "repo" ? typeof b.repo_id === "string" && b.work_item_id === undefined : typeof b.work_item_id === "string" && b.repo_id === undefined);
      if (!shape) return json(route, 422, envelope("validation_failed"));
      if (!ruleable(b.path) || (b.kind === "pin" && /[*?]/.test(b.path))) return json(route, 422, envelope("invalid_path"));
      if (b.scope === "repo" && !m.isAdmin) return json(route, 403, envelope("insufficient_role"));
      const same = (r: Rule) => r.scope === b.scope && r.path === b.path && (b.scope === "repo" ? r.repo_id === b.repo_id : r.work_item_id === b.work_item_id);
      const next: Rule = { id: m.rules.find(same)?.id ?? uuid(), scope: b.scope, kind: b.kind, path: b.path, repo_id: b.repo_id ?? null, work_item_id: b.work_item_id ?? null };
      const after = [...m.rules.filter((r) => !same(r)), next];
      const sets = b.scope === "repo" ? [...new Set(after.filter((r) => r.work_item_id).map((r) => r.work_item_id!)), ""] : [b.work_item_id];
      const resolved = sets.map((id) => (id ? inForce2(after, id) : after.filter((r) => r.scope === "repo")));
      if (resolved.some((s) => s.filter((r) => r.kind === "pin").length > 500)) return json(route, 409, envelope("pins_exceed_ceiling"));
      if (resolved.some((s) => s.filter((r) => r.kind === "exclude").length > 500)) return json(route, 409, envelope("excludes_exceed_cap"));
      if (b.kind === "pin" && resolved.some((s) => pinTotal(s) > budgetOf())) return json(route, 409, envelope("pins_exceed_budget"));
      m.rules = after;
      return json(route, 200, next);
    }
    if (method === "DELETE" && !isList) {
      const f = forced("DELETE", route);
      if (f) return f;
      const keys = [...url.searchParams.keys()];
      if (keys.length > 1 || (keys.length === 1 && (keys[0] !== "confirm" || url.searchParams.get("confirm") !== "true"))) return json(route, 422, envelope("validation_failed"));
      const id = url.pathname.split("/").pop()!;
      const r = m.rules.find((x) => x.id === id);
      if (!r) return json(route, 404, envelope("not_found"));
      if (r.scope === "repo" && !m.isAdmin) return json(route, 403, envelope("insufficient_role"));
      // exclude_readds_pins is computed, as the real route answers it: only for an ITEM exclude whose removal brings a REPO pin back into the item's
      // readable set AND leaves the readable pins over the budget. (It used to fire for any id in a preset set, which the real route never does.)
      // Simplification: coverage is covers() below, a small stand-in for excludeCovers in packages/runner-protocol, and the budget check on a PUT
      // still counts every pin; only this check skips pins an exclude covers.
      if (r.scope === "item" && r.kind === "exclude" && url.searchParams.get("confirm") !== "true") {
        const readable = (set: Rule[]) => set.filter((p) => p.kind === "pin" && !set.some((e) => e.kind === "exclude" && covers(e.path, p.path)));
        const wasReadable = new Set(readable(inForce2(m.rules, r.work_item_id!)).map((p) => p.path));
        const nowReadable = readable(inForce2(m.rules.filter((x) => x.id !== id), r.work_item_id!));
        if (nowReadable.some((p) => p.scope === "repo" && !wasReadable.has(p.path)) && pinTotal(nowReadable) > budgetOf()) return json(route, 409, envelope("exclude_readds_pins"));
      }
      m.rules = m.rules.filter((x) => x.id !== id);
      return json(route, 200, { removed: true });
    }
    return json(route, 404, envelope("not_found"));
  });

  await page.route("**/api/v1/repos/*/context-settings", async (route) => {
    const req = route.request();
    m.requests.push(`${req.method()} ${new URL(req.url()).pathname}`);
    const view = () => ({
      ...SETTINGS_FIXTURE, context_budget_bytes: m.budget,
      effective_by_role: Object.fromEntries(Object.keys(SETTINGS_FIXTURE.role_defaults).map((k) => [k, m.budget ?? SETTINGS_FIXTURE.role_defaults[k]])),
    });
    if (req.method() === "GET") return forced("GET settings", route) ?? json(route, 200, view());
    const f = forced("PUT settings", route);
    if (f) return f;
    if (!m.isAdmin) return json(route, 403, envelope("insufficient_role"));
    const b = JSON.parse(req.postData() ?? "null");
    m.bodies.push(b);
    const v = b && typeof b === "object" && Object.keys(b).join() === "context_budget_bytes" ? b.context_budget_bytes : undefined;
    if (!(v === null || (Number.isInteger(v) && v >= SETTINGS_FIXTURE.min_bytes && v <= SETTINGS_FIXTURE.max_bytes))) return json(route, 422, envelope("validation_failed"));
    const changed = m.budget !== v;
    m.budget = v;
    const over = pinTotal(m.rules.filter((r) => r.scope === "repo")) > budgetOf();
    return json(route, 200, { ...view(), changed, pins_status: over ? "over_budget" : "fit" });
  });

  function inForce2(rules: Rule[], itemId: string) {
    const own = rules.filter((r) => r.work_item_id === itemId);
    const paths = new Set(own.map((r) => r.path));
    return [...own, ...rules.filter((r) => r.scope === "repo" && !paths.has(r.path))];
  }
}
