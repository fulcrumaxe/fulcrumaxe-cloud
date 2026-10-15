import type { Parsed } from "../args.js";
import type { Io } from "../context.js";
import { CliExit, EXIT, usage } from "../errors.js";
import { isSessionOnly, pointerLink, type SessionOnlyAction } from "../links.js";
import type { Output } from "../output.js";
import { listPages, type Page } from "../paging.js";
import { resolveSession, type Session } from "../session.js";
import { call } from "../transport.js";

interface Ctx {
  io: Io;
  out: Output;
  session: Session;
  args: Parsed;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Absent values print as a dash, never as the word "null" or "undefined". */
const show = (v: string | number | boolean | null | undefined): string => (v === null || v === undefined || v === "" ? "-" : String(v));
const usd = (n: number | null | undefined): string => (n === null || n === undefined ? "-" : `$${n !== 0 && Math.abs(n) < 0.01 ? n.toFixed(4) : n.toFixed(2)}`);
/** A work item or discussion as people tell them apart: the title, then the id. A missing title leaves the bare id. */
const titled = (title: string | null | undefined, id: string | null): string => (id === null ? "-" : title ? `${title} (${id})` : id);

/** Prints the page (human or --json) and tells a person when there is more than was shown. */
function emit<T>({ out }: Ctx, page: Page<T>, line: (item: T) => string, empty: string): void {
  if (page.data.length === 0) out.say(empty);
  else out.say(page.data.map(line).join("\n"));
  if (page.next_cursor !== null) out.note("There are more results: add --all to see them all, or --limit to change the page size.");
  out.success(page);
}

const fields = (rows: Array<[string, string | number | boolean | null | undefined]>): string => rows.map(([k, v]) => `${k}: ${show(v)}`).join("\n");

// --- runs -------------------------------------------------------------------------------------------------------------------------------

/** Titles for the run list: one page of work items, read only for a person (the --json body is the runs page unchanged). */
async function workItemTitles(c: Ctx): Promise<Map<string, string>> {
  const items = await call(c.io, c.out, c.session, "listWorkItems", { query: { limit: "100" } });
  return new Map(items.data.flatMap((w) => (w.title ? [[w.id, w.title] as [string, string]] : [])));
}

async function runsList(c: Ctx): Promise<void> {
  const page = await listPages(c.args, (query) => call(c.io, c.out, c.session, "listRuns", { query }));
  const titles = c.out.json || page.data.every((r) => r.work_item_id === null) ? new Map<string, string>() : await workItemTitles(c);
  emit(c, page, (r) => `${r.id}  ${r.status}  ${r.role}  ${titled(r.work_item_id === null ? null : titles.get(r.work_item_id), r.work_item_id)}  ${usd(r.usd)}  ${r.created_at}`, "No runs.");
}

async function runsShow(c: Ctx, id: string): Promise<void> {
  const run = await call(c.io, c.out, c.session, "getRun", { path: { id } });
  let title: string | undefined;
  if (!c.out.json && run.work_item_id !== null) {
    try {
      title = (await call(c.io, c.out, c.session, "getWorkItem", { path: { id: run.work_item_id } })).title ?? undefined;
    } catch (e) {
      // fx-swallow-ok: the run itself was read; a work item that is gone leaves its bare id
      if (!(e instanceof CliExit) || e.exit !== EXIT.notFound) throw e;
    }
  }
  const plan = run.runner_usage;
  c.out.say(
    fields([
      ["run", run.id],
      ["status", run.status],
      ["role", run.role],
      ["runtime", run.runtime],
      ["work item", titled(title, run.work_item_id)],
      ["parent run", run.parent_run_id],
      ["cost", usd(run.usd)],
      ["tokens in", run.tokens_in],
      ["tokens out", run.tokens_out],
      ["approved by", run.approved_by?.name],
      ["approval", run.approval],
      ["created", run.created_at],
      ["updated", run.updated_at],
      ...(plan ? ([["plan", plan.credential_mode], ["model", plan.model], ["api-equivalent cost", usd(plan.api_equivalent_usd)]] as Array<[string, string | null]>) : []),
    ]),
  );
  c.out.success(run);
}

// --- work items -------------------------------------------------------------------------------------------------------------------------

async function workItemsList(c: Ctx): Promise<void> {
  const page = await listPages(c.args, (query) => call(c.io, c.out, c.session, "listWorkItems", { query }));
  emit(c, page, (w) => `${w.id}  ${w.stage}  ${w.priority}  ${w.title ?? "(untitled)"}`, "No work items.");
}

async function workItemsShow(c: Ctx, id: string): Promise<void> {
  const w = await call(c.io, c.out, c.session, "getWorkItem", { path: { id } });
  c.out.say(
    fields([
      ["work item", titled(w.title ?? "(untitled)", w.id)],
      ["stage", w.stage],
      ["priority", w.priority],
      ["kind", w.kind],
      ["issue", w.issue_number === null ? null : `#${w.issue_number}`],
      ["provenance", w.provenance],
      ["cost", usd(w.cost_usd)],
      ["created", w.created_at],
      ["updated", w.updated_at],
    ]),
  );
  c.out.success(w);
}

async function workItemsTimeline(c: Ctx, id: string): Promise<void> {
  const t = await call(c.io, c.out, c.session, "getWorkItemTimeline", { path: { id } });
  c.out.say([`work item ${t.work_item_id} is now ${t.stage}`, ...t.transitions.map((x) => `${x.at}  ${x.from_stage} -> ${x.to_stage}  (${x.source}${x.reviewer ? `, ${x.reviewer} review` : ""})`)].join("\n"));
  if (t.truncated) c.out.note("The timeline was cut short by the server: older transitions are not shown.");
  c.out.success(t);
}

// --- discussions ------------------------------------------------------------------------------------------------------------------------

async function discussionsList(c: Ctx): Promise<void> {
  const page = await listPages(c.args, (query) => call(c.io, c.out, c.session, "listDiscussions", { query }));
  emit(c, page, (d) => `#${d.number}  ${d.id}  [${d.kind}]  ${d.title}`, "No discussions.");
}

async function discussionsShow(c: Ctx, id: string): Promise<void> {
  const d = await call(c.io, c.out, c.session, "getDiscussion", { path: { id } });
  c.out.say(`${fields([["discussion", `#${d.number} ${d.title}`], ["id", d.id], ["kind", d.kind], ["visibility", d.visibility], ["created", d.created_at], ["revision", d.rev], ["revised", d.revised_at]])}\n\n${d.body}`);
  c.out.success(d);
}

async function discussionsComments(c: Ctx, id: string): Promise<void> {
  const page = await listPages(c.args, (query) => call(c.io, c.out, c.session, "listComments", { path: { id }, query }));
  const who = (m: (typeof page.data)[number]): string => (m.role ? `${m.author_kind} (${m.role})` : m.author_kind);
  emit(c, page, (m) => `${m.created_at}  ${who(m)}${m.reply_to_id === null ? "" : `  replying to ${m.reply_to_id}`}\n  ${m.deleted ? "(deleted)" : show(m.body)}`, "No comments.");
}

// --- repos ------------------------------------------------------------------------------------------------------------------------------

type RepoRow = { id: string; product: string; full_name: string | null; install_state: string };
const repoName = (r: RepoRow): string => r.full_name ?? r.product;
const repoLine = (r: RepoRow): string => `${r.id}  ${repoName(r)}${r.install_state === "installed" ? "" : "  (not installed)"}`;

async function reposList(c: Ctx): Promise<void> {
  emit(c, await listPages(c.args, (query) => call(c.io, c.out, c.session, "listRepos", { query })), repoLine, "No repos.");
}

async function reposShow(c: Ctx, id: string): Promise<void> {
  const r = await call(c.io, c.out, c.session, "getRepo", { path: { id } });
  c.out.say(fields([["repo", repoName(r)], ["id", r.id], ["product", r.product], ["install", r.install_state], ["app", r.app_kind]]));
  c.out.success(r);
}

// --- webhooks ---------------------------------------------------------------------------------------------------------------------------

async function webhooksList(c: Ctx): Promise<void> {
  emit(c, await listPages(c.args, (query) => call(c.io, c.out, c.session, "listWebhookEndpoints", { query })), (w) => `${w.id}  ${w.status}  ${w.url}`, "No webhook endpoints.");
}

async function webhooksShow(c: Ctx, id: string): Promise<void> {
  const w = await call(c.io, c.out, c.session, "getWebhookEndpoint", { path: { id } });
  c.out.say(fields([["endpoint", w.url], ["id", w.id], ["status", w.status], ["disabled because", w.disabled_reason], ["events", w.event_types.join(", ")], ["created", w.created_at], ["updated", w.updated_at]]));
  c.out.success(w);
}

async function webhooksDeliveries(c: Ctx, id: string): Promise<void> {
  const page = await listPages(c.args, (query) => call(c.io, c.out, c.session, "listWebhookDeliveries", { path: { id }, query }));
  emit(c, page, (d) => `${d.created_at}  ${d.event_type}  ${d.status}  attempts ${d.attempt_count}  ${d.last_status_code === null ? show(d.last_error_class) : `http ${d.last_status_code}`}`, "No deliveries.");
}

// --- usage and budgets ------------------------------------------------------------------------------------------------------------------

async function usageShow(c: Ctx): Promise<void> {
  const u = await call(c.io, c.out, c.session, "getUsage");
  const meter = (name: string, m: { spent_usd: number; reserved_usd: number; limit_usd: number }): string => `${name}: ${usd(m.spent_usd)} spent, ${usd(m.reserved_usd)} reserved, limit ${usd(m.limit_usd)}`;
  c.out.say([`since ${u.period_start}`, meter("model", u.model), meter("foreground compute", u.foreground_compute), meter("background compute", u.background_compute), `own plan, api-equivalent: ${usd(u.own_plan_api_equivalent_usd)}`].join("\n"));
  c.out.success(u);
}

async function budgetsShow(c: Ctx): Promise<void> {
  const b = await call(c.io, c.out, c.session, "getBudgets");
  c.out.say(fields([["plan", b.plan], ["model per month", usd(b.model_usd_month)], ["foreground compute per month", usd(b.foreground_compute_usd_month)], ["background compute per month", usd(b.background_compute_usd_month)], ["compute cap per month", usd(b.compute_cap_usd_month)]]));
  c.out.success(b);
}

// --- dispatch ---------------------------------------------------------------------------------------------------------------------------

interface Entry {
  /** The id the command takes, if any. */
  id: boolean;
  run: (c: Ctx, id: string) => Promise<void>;
}
const list = (run: (c: Ctx) => Promise<void>): Entry => ({ id: false, run: (c) => run(c) });
const byId = (run: (c: Ctx, id: string) => Promise<void>): Entry => ({ id: true, run });

const COMMANDS: Record<string, Record<string, Entry>> = {
  runs: { list: list(runsList), show: byId(runsShow) },
  "work-items": { list: list(workItemsList), show: byId(workItemsShow), timeline: byId(workItemsTimeline) },
  discussions: { list: list(discussionsList), show: byId(discussionsShow), comments: byId(discussionsComments) },
  repos: { list: list(reposList), show: byId(reposShow) },
  webhooks: { list: list(webhooksList), show: byId(webhooksShow), deliveries: byId(webhooksDeliveries) },
  usage: { "": list(usageShow) },
  budgets: { "": list(budgetsShow) },
};

/** Exit 6, one line, no request: the action exists, but only in the workspace. */
function sessionOnly(io: Io, args: Parsed, action: SessionOnlyAction): CliExit {
  const { origin } = resolveSession(io, args.profile);
  const link = pointerLink(origin, action);
  return new CliExit(EXIT.sessionOnly, "session_required", `${action} needs the workspace (tokens can't do this by design): ${link}`, link);
}

/** True when `command [sub]` is a read command or a session-only pointer (and has run); false when it is neither. */
export async function readCommand(io: Io, out: Output, args: Parsed): Promise<boolean> {
  const command = args.command ?? "";
  const sub = args.rest[0];
  const action = sub === undefined ? command : `${command} ${sub}`;
  if (isSessionOnly(command)) throw sessionOnly(io, args, command);
  if (isSessionOnly(action)) throw sessionOnly(io, args, action);
  const entry = COMMANDS[command]?.[sub ?? ""];
  if (entry === undefined) return false;
  const given = args.rest.slice(1);
  if (given.length > (entry.id ? 1 : 0)) throw usage(`too many arguments for \`fx ${action}\`: see \`fx --help\``);
  if (entry.id && given[0] === undefined) throw usage(`\`fx ${action}\` needs an id: list them with \`fx ${command} list\``);
  const id = given[0] ?? "";
  if (entry.id && !UUID.test(id)) throw usage(`that is not an id: an id looks like 11111111-1111-4111-8111-111111111111`);
  await entry.run({ io, out, session: resolveSession(io, args.profile), args }, id);
  return true;
}
