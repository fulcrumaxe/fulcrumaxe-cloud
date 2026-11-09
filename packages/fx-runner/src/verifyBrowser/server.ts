import { promises as fs } from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { findChromium, launchDriver, ToolError, type DriverConfig, type PageDriver } from "./driver.js";
import { groundAnswer } from "./ground.js";
import { isAllowedUrl, parseBase, resolveOpenPath, type BasePin } from "./pin.js";
import { cleanPageText, fenced, MAX_RESULT_CHARS, snapshotBody } from "./snapshot.js";
import { MAX_JOB_MS, Trace, numbersIn } from "./trace.js";

const JOURNEY_ID = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * D#749 V2c-2a: the verify browser as a stdio MCP server (newline-delimited JSON-RPC), run by the runner's own binary for one deploy-verifier job. The model drives a
 * browser it never holds: twelve small tools, none that runs a script, reads the network, uploads, downloads or takes an address or a selector. `open` takes a path
 * under the base URL; refs come from the last snapshot. Every result is page text cleaned, cut and fenced as untrusted. `submit_answer` checks the answer against what
 * the page showed and writes the accepted JSON to `answer.json` in the job directory. The process, its streams and its environment arrive as arguments; the entry that
 * wires them to this code is a later change.
 */
type ArgType = "string" | "integer" | "json";
interface ToolDef {
  description: string;
  props: Record<string, { type: ArgType; max?: number; enum?: readonly string[] }>;
  required: readonly string[];
}
const TEXT = { type: "string", max: 500 } as const;
const REF = { type: "string", max: 8 } as const;

/** The closed tool table. The advertised schemas and the argument checks are both built from it, so they cannot drift. */
export const TOOLS: Readonly<Record<string, ToolDef>> = {
  begin_journey: { description: "Start checking a journey, by its id, before any other browser tool; call it again to switch journeys. An answer may quote only what the page showed while that journey was being checked.", props: { id: { type: "string", max: 40 } }, required: ["id"] },
  open: { description: "Open a page of the app by path, for example /items. Takes a path that starts with one slash, never an address.", props: { path: { type: "string", max: 500 } }, required: ["path"] },
  snapshot: { description: "List the visible buttons, links, fields, headings and status elements with refs (e1, e2, ...), and a slice of the page text.", props: {}, required: [] },
  click: { description: "Click the element with this ref from the latest snapshot.", props: { ref: REF }, required: ["ref"] },
  type: { description: "Type text into the text field or textarea with this ref. Password and file fields are refused.", props: { ref: REF, text: TEXT }, required: ["ref", "text"] },
  select: { description: "Choose an option, by its visible label, in the select with this ref.", props: { ref: REF, option: TEXT }, required: ["ref", "option"] },
  press: { description: "Press Enter, Escape or Tab.", props: { key: { type: "string", enum: ["Enter", "Escape", "Tab"] } }, required: ["key"] },
  reload: { description: "Reload the current page.", props: {}, required: [] },
  wait_text: { description: "Wait up to 10 seconds for text to be visible on the page.", props: { text: TEXT, seconds: { type: "integer", max: 10 } }, required: ["text"] },
  read_number: { description: "Read the element with this ref and return its text and the number it holds.", props: { ref: REF }, required: ["ref"] },
  console: { description: "The count of console errors since the start and the first few console messages.", props: {}, required: [] },
  submit_answer: { description: "Submit the final JSON answer once. Every dom_fact and number must be something the page showed you through these tools.", props: { envelope: { type: "json" } }, required: ["envelope"] },
};

export function toolList(): Array<{ name: string; description: string; inputSchema: unknown }> {
  return Object.entries(TOOLS).map(([name, def]) => ({
    name,
    description: def.description,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [...def.required],
      properties: Object.fromEntries(Object.entries(def.props).map(([k, p]) => [k, p.type === "json" ? { description: "the answer object" } : p.type === "integer" ? { type: "integer", minimum: 1, maximum: p.max } : { type: "string", ...(p.max === undefined ? {} : { maxLength: p.max }), ...(p.enum === undefined ? {} : { enum: [...p.enum] }) }])),
    },
  }));
}

/** The arguments of a call, checked against the table: no unknown key, every required key, string values within their length. Undefined when they do not fit. */
function checkArgs(def: ToolDef, args: unknown): Record<string, unknown> | undefined {
  if (args === undefined) args = {};
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  const given = args as Record<string, unknown>;
  if (Object.keys(given).some((k) => !Object.hasOwn(def.props, k)) || def.required.some((k) => !Object.hasOwn(given, k))) return undefined;
  for (const [k, v] of Object.entries(given)) {
    const p = def.props[k]!;
    if (p.type === "integer" && (!Number.isInteger(v) || (v as number) < 1 || (v as number) > (p.max ?? 10))) return undefined;
    if (p.type === "string" && (typeof v !== "string" || v.length > (p.max ?? 500) || (p.enum !== undefined && !p.enum.includes(v)))) return undefined;
  }
  return given;
}

export interface ServerOptions {
  /** The app under test. Everything the browser may reach is this origin. */
  baseUrl: string;
  /** The job directory: holds the browser's HOME and TMPDIR while it runs and receives `answer.json`. */
  jobDir: string;
  input: Readable;
  output: Writable;
  /** The runner's environment, handed in (this code does not read the process's own). */
  hostEnv: Readonly<Record<string, string | undefined>>;
  storageStatePath?: string;
  /** Tests only: accept a self-signed certificate. */
  ignoreHttpsErrors?: boolean;
  executablePath?: string;
  now?: () => number;
  /** Replaced in tests; the default starts Chromium. */
  openDriver?: (cfg: DriverConfig) => Promise<PageDriver>;
}

interface Reply {
  text: string;
  error: boolean;
}
const ok = (text: string): Reply => ({ text, error: false });
const fail = (code: string, body = ""): Reply => ({ text: fenced(`error: ${code}`, body), error: true });

export function startVerifyBrowserServer(opts: ServerOptions): { done: Promise<void>; stop: () => Promise<void> } {
  const now = opts.now ?? (() => Date.now());
  const trace = new Trace(now());
  const base: BasePin | undefined = parseBase(opts.baseUrl);
  const open = opts.openDriver ?? launchDriver;
  let driver: PageDriver | undefined;
  let accepted = false;
  let stopped = false;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => (finish = resolve));

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    clearTimeout(stopWatch);
    await driver?.close().catch(() => undefined);
    finish();
  };
  // The whole job is bounded even when the model's CLI goes quiet: the browser is closed (its process group with it) when the time is up.
  const stopWatch = setTimeout(() => void stop(), MAX_JOB_MS);
  stopWatch.unref();

  /** The browser, started on the first call that needs it. */
  const browser = async (): Promise<PageDriver> => {
    if (stopped) throw new ToolError("job_stopped");
    if (base === undefined) throw new ToolError("bad_base_url");
    if (driver !== undefined) return driver;
    const executablePath = opts.executablePath ?? findChromium(opts.hostEnv);
    if (executablePath === undefined) throw new ToolError("no_browser");
    const started = await open({ base, executablePath, jobDir: opts.jobDir, storageStatePath: opts.storageStatePath, hostEnv: opts.hostEnv, ignoreHttpsErrors: opts.ignoreHttpsErrors, onConsole: (t, x) => trace.console(t, cleanPageText(x, 300)) });
    // The job may have been stopped while the browser was starting: nothing launched after a stop is kept.
    if (stopped) {
      await started.close().catch(() => undefined);
      throw new ToolError("job_stopped");
    }
    driver = started;
    return started;
  };

  /** Text the model is shown: cleaned, cut and fenced. Not logged for grounding: use `fromPage` for what the page itself held. */
  const shown = (status: string, raw: string, max = MAX_RESULT_CHARS): Reply => ok(fenced(status, cleanPageText(raw, max)));
  /** Page content the model is shown: as `shown`, and logged in the current journey's record. */
  const fromPage = (status: string, raw: string, max = MAX_RESULT_CHARS): Reply => {
    const text = cleanPageText(raw, max);
    trace.observe(text);
    return ok(fenced(status, text));
  };

  /** Where the page is, as a path (an address would be stripped as a link). */
  const where = (d: PageDriver): string => {
    try {
      const u = new URL(d.url());
      return u.protocol === "about:" ? "about:blank" : `${u.pathname}${u.search}`;
    } catch {
      // fx-swallow-ok: an address that does not parse is shown as unknown
      return "unknown";
    }
  };

  /** After an action: the page must still be on the base origin. If it is not, it is parked on about:blank and the journey is over. */
  const afterAction = async (d: PageDriver, blockedBefore: number): Promise<Reply | undefined> => {
    if (base === undefined) return undefined;
    if (!isAllowedUrl(d.url(), base)) {
      try {
        await d.go("about:blank");
      } catch {
        // fx-swallow-ok: parking is best effort (a failed load can be mid-navigation); the journey is over either way
      }
      return fail("left_origin");
    }
    return d.blocked().navigations > blockedBefore ? fail("left_origin") : undefined;
  };

  const run = async (name: string, a: Record<string, unknown>): Promise<Reply> => {
    if (name === "submit_answer") {
      if (accepted) return fail("already_submitted");
      const verdict = groundAnswer(a.envelope, trace);
      if (!verdict.ok) return fail("answer_rejected", verdict.reason);
      await fs.writeFile(path.join(opts.jobDir, "answer.json"), verdict.json, { flag: "wx", mode: 0o600 });
      accepted = true;
      return ok("answer accepted");
    }
    if (name === "begin_journey") {
      if (!JOURNEY_ID.test(a.id as string)) return fail("bad_arguments");
      trace.begin(a.id as string);
      return ok("journey started");
    }
    if (name === "console") return shown(`console_errors: ${trace.consoleErrors}`, trace.consoleLines.join("\n"));
    if (!trace.started()) return fail("no_journey", "call begin_journey with the journey id first");
    if (!trace.takeCall()) return fail("call_budget_used", "submit_answer now");
    const d = await browser();
    const blockedBefore = d.blocked().navigations;
    const str = (k: string): string => a[k] as string;
    let reply: Reply;
    try {
      switch (name) {
        case "open": {
          const target = base === undefined ? undefined : resolveOpenPath(str("path"), base);
          if (target === undefined) return fail("bad_path");
          await d.go(target);
          reply = shown("opened", where(d));
          break;
        }
        case "snapshot": {
          const page = await d.scan();
          const snap = snapshotBody(page.elements, page.text);
          for (const piece of snap.observed) trace.observe(piece);
          reply = ok(fenced(`blocked_requests: ${d.blocked().requests}`, snap.text));
          break;
        }
        case "click":
          await d.click(str("ref"));
          reply = shown("clicked", where(d));
          break;
        case "type":
          await d.fill(str("ref"), str("text"));
          reply = ok("typed");
          break;
        case "select":
          await d.choose(str("ref"), str("option"));
          reply = ok("selected");
          break;
        case "press":
          await d.press(str("key"));
          reply = ok("pressed");
          break;
        case "reload":
          await d.reload();
          reply = shown("reloaded", where(d));
          break;
        case "wait_text": {
          const found = await d.waitText(str("text"), (a.seconds === undefined ? 5 : (a.seconds as number)) * 1000);
          reply = ok(found ? "text_visible" : "text_not_visible");
          break;
        }
        default: {
          // read_number
          const text = cleanPageText(await d.textOf(str("ref")), 300);
          const numbers = numbersIn(text);
          reply = fromPage(`numbers: ${JSON.stringify(numbers)}`, text);
        }
      }
    } catch (error) {
      // A refused navigation aborts the load, which the browser reports as a failure: it is the origin pin that answers, not the failure.
      const left = await afterAction(d, blockedBefore);
      if (left !== undefined) return left;
      throw error;
    }
    return (await afterAction(d, blockedBefore)) ?? reply;
  };

  const call = async (name: unknown, args: unknown): Promise<Reply> => {
    if (stopped) return fail("job_stopped");
    const def = typeof name === "string" && Object.hasOwn(TOOLS, name) ? TOOLS[name] : undefined;
    if (def === undefined || typeof name !== "string") return fail("unknown_tool");
    const checked = checkArgs(def, args);
    if (checked === undefined) return fail("bad_arguments");
    if (trace.expired(now())) return fail("job_time_used");
    try {
      return await run(name, checked);
    } catch (error) {
      // fx-swallow-ok: a failed action is answered with a closed error code; the browser's message can carry page text and is not forwarded
      return fail(error instanceof ToolError ? error.code : "action_failed");
    }
  };

  const send = (message: unknown): void => void opts.output.write(`${JSON.stringify(message)}\n`);
  const handle = async (line: string): Promise<void> => {
    let msg: { id?: unknown; method?: unknown; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      // fx-swallow-ok: a line that is not JSON gets the protocol's parse error
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      return;
    }
    if (msg === null || typeof msg !== "object" || msg.id === undefined) return;
    const id = msg.id;
    const params = msg.params ?? {};
    switch (msg.method) {
      case "initialize":
        return send({ jsonrpc: "2.0", id, result: { protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fxverify", version: "1" } } });
      case "tools/list":
        return send({ jsonrpc: "2.0", id, result: { tools: toolList() } });
      case "tools/call": {
        const reply = await call(params.name, params.arguments);
        return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: reply.text }], isError: reply.error } });
      }
      case "ping":
        return send({ jsonrpc: "2.0", id, result: {} });
      default:
        return send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
    }
  };

  // One line at a time, in order: a call finishes before the next starts.
  let buffer = "";
  let queue: Promise<void> = Promise.resolve();
  opts.input.setEncoding("utf8");
  opts.input.on("data", (chunk: string) => {
    if (stopped) return;
    buffer += chunk;
    if (buffer.length > 2_000_000) {
      // A line this long is not the protocol: stop the job, drop what was read and stop reading.
      buffer = "";
      opts.input.destroy();
      return void stop();
    }
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim() !== "") queue = queue.then(() => handle(line));
  });
  opts.input.on("end", () => void queue.then(stop));
  opts.input.on("close", () => void queue.then(stop));
  return { done, stop };
}
