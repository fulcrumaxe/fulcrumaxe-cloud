/**
 * D#597 CC-7a-1: the local tool proxy, the only thing the assistant's model process talks to. It listens on a Unix socket in a fresh 0700
 * directory and holds the delegation token itself; the model process gets the socket path and a per-session secret (useless against the cloud),
 * never the token. The allowlist is exactly the corrections list, `draft_correction` and the read tools; any other name is refused here and the cloud sees
 * nothing, so no tool can accept, reject, approve, merge, cancel or lift a halt. A 401 (or a token past its time) answers `assistant_relink`
 * and sends nothing more with that token.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { assistantCall } from "./cloudCall.js";
import { fenceJson } from "./fence.js";
import { READ_TOOLS, correctionsPath, readPath } from "./readTools.js";
import { AssistantError, assertStateDirSafe, readAssistantToken, type AssistantProblem } from "./tokenFile.js";

/** The whole tool list: the corrections list and `draft_correction` (CC-7a-1) and the six read tools (CC-7a-2). Nothing here writes except the proposal. */
export const ALLOWED_TOOLS: readonly string[] = Object.freeze(["list_corrections", "draft_correction", ...READ_TOOLS]);
/** The argument names of the two correction tools (`call` below reads exactly these), for the name cross-check against the hosted registry. */
export const CORRECTION_TOOL_ARGS: Readonly<Record<string, readonly string[]>> = Object.freeze({ list_corrections: ["work_item_id"], draft_correction: ["work_item_id", "kind", "body"] });
export const PROXY_SOCKET_ENV = "FX_ASSISTANT_PROXY_SOCKET";
export const PROXY_SECRET_ENV = "FX_ASSISTANT_PROXY_SECRET";
const MAX_REQUEST_BYTES = 32 * 1024;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ProxyOptions {
  stateDir: string;
  uid: number | undefined;
  fetchFn: typeof fetch;
  now: () => Date;
  bypass?: string | undefined;
  /** Where a fixed line is written if the server fails after it started. */
  log?: (line: string) => void;
}

export interface Proxy {
  server: Server;
  socketPath: string;
  secret: string;
  /** The two values the model process is given, by name. */
  env: Record<string, string>;
  close(): Promise<void>;
}

type Answer = { status: number; body: unknown };
const refuse = (status: number, code: AssistantProblem, reason?: string): Answer => ({ status, body: { error: code, message: new AssistantError(code, reason).message } });

export async function startProxy(o: ProxyOptions): Promise<Proxy> {
  const secret = randomBytes(24).toString("base64url");
  assertStateDirSafe(o.stateDir, o.uid);
  const dir = mkdtempSync(path.join(o.stateDir, "assistant-proxy-"));
  const socketPath = path.join(dir, "s");
  let dead: string | undefined;

  async function call(tool: string, args: Record<string, unknown>): Promise<Answer> {
    if (!ALLOWED_TOOLS.includes(tool)) return refuse(403, "assistant_tool_refused");
    const read = READ_TOOLS.includes(tool);
    const id = args.work_item_id;
    let route: { method: "GET" | "POST"; body?: unknown } = { method: "GET" };
    if (!read) {
      if (typeof id !== "string" || !ID.test(id)) return refuse(400, "assistant_tool_refused", "work_item_id must be a work item id");
      if (tool === "list_corrections") route = { method: "GET" };
      else if (typeof args.kind === "string" && /^[a-z_]{1,32}$/.test(args.kind) && typeof args.body === "string") route = { method: "POST", body: { kind: args.kind, body: args.body } };
      else return refuse(400, "assistant_tool_refused", "draft_correction needs a kind and a text body");
    }
    let stored;
    try {
      stored = readAssistantToken(o.stateDir, o.uid);
    } catch (error) {
      if (error instanceof AssistantError) return refuse(409, error.code);
      throw error;
    }
    if (stored.token === dead || o.now().getTime() >= Date.parse(stored.expires_at)) return refuse(401, "assistant_relink");
    let target = correctionsPath(String(id));
    if (read) {
      const planned = readPath(tool, args, stored.repo_id);
      if ("fault" in planned) return refuse(400, "assistant_tool_refused", planned.fault);
      target = planned.path;
    }
    const reply = await assistantCall({ fetchFn: o.fetchFn, origin: stored.origin, method: route.method, path: target, body: route.body, token: stored.token, bypass: o.bypass });
    if (reply.status === 401) {
      dead = stored.token;
      return refuse(401, "assistant_relink");
    }
    // A read answers fenced data or a fixed word: another repo's id is the cloud's 404 ("not found"), and none of the cloud's error body is passed on.
    if (read || tool === "list_corrections") {
      if (reply.status === 404) return refuse(404, "assistant_not_found");
      if (reply.status !== 200 || reply.body === undefined) return refuse(502, "assistant_read_failed");
      return { status: 200, body: fenceJson(reply.body) };
    }
    // The proposal is answered as a fixed sentence and the id (the hosted tool's words), never the cloud's reply, which carries the model's own body back.
    const made = typeof reply.body === "object" && reply.body !== null ? (reply.body as { id?: unknown }).id : undefined;
    if (reply.status < 200 || reply.status > 299 || typeof made !== "string" || !ID.test(made)) return refuse(502, "assistant_read_failed");
    return { status: reply.status, body: { message: `correction ${made} is proposed. A person must accept it before anything happens.` } };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (a: Answer): void => {
      res.writeHead(a.status, { "content-type": "application/json" });
      res.end(JSON.stringify(a.body));
    };
    const given = Buffer.from(req.headers.authorization ?? "");
    const want = Buffer.from(`Bearer ${secret}`);
    if (req.method !== "POST" || req.url !== "/tool" || given.length !== want.length || !timingSafeEqual(given, want)) return send(refuse(403, "assistant_tool_refused"));
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_REQUEST_BYTES) return send(refuse(413, "assistant_tool_refused", "the request is too large"));
      chunks.push(chunk as Buffer);
    }
    let message: { tool?: unknown; args?: unknown };
    try {
      message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      // fx-swallow-ok: unparsable input from the model process is answered with a fixed refusal
      return send(refuse(400, "assistant_tool_refused", "the request is not JSON"));
    }
    const args = typeof message.args === "object" && message.args !== null ? (message.args as Record<string, unknown>) : {};
    try {
      send(typeof message.tool === "string" ? await call(message.tool, args) : refuse(403, "assistant_tool_refused"));
    } catch (error) {
      // fx-swallow-ok: the model process is told in fixed words; a network failure's text is not passed on
      send(refuse(502, "assistant_link_failed", error instanceof Error && error.name === "CliError" ? "the cloud could not be reached" : "the proxy failed"));
    }
  }

  const server = createServer((req, res) => void handle(req, res));
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  const close = (): Promise<void> =>
    new Promise<void>((resolve) => {
      server.close(() => {
        rmSync(dir, { recursive: true, force: true });
        resolve();
      });
      server.closeAllConnections();
    });
  server.on("error", () => {
    o.log?.(`${new AssistantError("assistant_link_failed", "the local proxy stopped").message}`);
    void close();
  });
  return {
    server,
    socketPath,
    secret,
    env: { [PROXY_SOCKET_ENV]: socketPath, [PROXY_SECRET_ENV]: secret },
    close,
  };
}
