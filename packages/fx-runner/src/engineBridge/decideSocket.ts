/**
 * The engine's decide socket: `$XDG_RUNTIME_DIR/fx-runner/engine-bridge.sock`, HTTP/1.1 over a Unix socket, one route, `POST /api/runner/engine/decide`.
 * The runner checks what the engine asks, then forwards it to the cloud's decide route in its own signed request and returns the cloud's answer.
 *
 * - The socket is mode 0600 in a 0700 directory of this user's. A directory that is a link, someone else's or open to others is refused, and so is a
 *   path where something other than a socket already is. Only this user can open the socket; Node has no way to read `SO_PEERCRED`, so the file mode is the check.
 * - The body is `EngineDecideRequest` (strict). A `repo_gh_id` that is not a repo this runner is paired with is refused here, with nothing sent to the cloud
 *   (`wrong_repo`), and so is a repo whose last pull said operate is off (`operate_off`). Everything else is the cloud's to decide, which fails closed.
 * - The answer is `EngineDecideReply` or an error whose `error` is one of a short list of known words (anything else is `cloud_error`); nothing from the cloud's text or from the request reaches a log or a reply.
 */
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { COMMAND_REFUSALS, EngineDecideReply, EngineDecideRequest } from "@fulcrumaxe/runner-protocol";
import type { CloudReply } from "../cloud.js";

export const DECIDE_PATH = "/api/runner/engine/decide";
export const SOCKET_NAME = "engine-bridge.sock";
export const DECIDE_BODY_MAX_BYTES = 16 * 1024;

/** `<runtime dir>/fx-runner/engine-bridge.sock`. A missing or relative runtime directory is refused: the socket must not depend on where the runner started. */
export function socketPathFor(env: Readonly<Record<string, string | undefined>>): string {
  const runtime = env.XDG_RUNTIME_DIR;
  if (runtime === undefined || runtime === "" || !path.isAbsolute(runtime)) throw new Error("engine-bridge socket: XDG_RUNTIME_DIR must be an absolute path");
  return path.join(runtime, "fx-runner", SOCKET_NAME);
}

export interface DecideSocketDeps {
  socketPath: string;
  /** The user id the socket's directory must belong to; undefined where the platform has none. */
  uid: number | undefined;
  post: (path: string, body: unknown) => Promise<CloudReply>;
  /** The repos this runner is paired with, by GitHub id. */
  pairedRepos: () => readonly number[];
  /** What the last pull said about the repo's operate switch; undefined before it said anything. */
  operateEnabled: (repoGhId: number) => boolean | undefined;
  log: (line: string) => void;
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > DECIDE_BODY_MAX_BYTES) {
        resolve(null);
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(null));
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

/** The words of the cloud's refusals the engine may read. Anything else the cloud says is passed on as `cloud_error`. */
export const KNOWN_ERROR_WORDS: ReadonlySet<string> = new Set([...COMMAND_REFUSALS, "invalid_request", "invalid_message", "unauthorized", "forbidden", "not_found", "conflict", "rate_limited"]);

/** The cloud's refusal as one fixed word the engine can read: its own `error` when that is one of the known words, else `cloud_error`. */
const wordOf = (body: unknown): string => {
  const error = (body as { error?: unknown } | null)?.error;
  return typeof error === "string" && KNOWN_ERROR_WORDS.has(error) ? error : "cloud_error";
};

export async function handleDecide(deps: DecideSocketDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.url !== DECIDE_PATH) return send(res, 404, { error: "not_found" });
  if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" });
  const text = await readBody(req);
  if (text === null) return send(res, 413, { error: "invalid_request" });
  let parsed: ReturnType<typeof EngineDecideRequest.safeParse>;
  try {
    parsed = EngineDecideRequest.safeParse(JSON.parse(text));
  } catch {
    // fx-swallow-ok: a body that is not JSON is one fixed refusal; the parser's words could quote the body
    return send(res, 400, { error: "invalid_request" });
  }
  if (!parsed.success) return send(res, 400, { error: "invalid_request" });
  const request = parsed.data;
  if (!deps.pairedRepos().includes(request.repo_gh_id)) return send(res, 403, { error: "wrong_repo" });
  if (deps.operateEnabled(request.repo_gh_id) === false) return send(res, 403, { error: "operate_off" });
  const reply = await deps.post(DECIDE_PATH, request);
  if (reply.status === 200) {
    const answer = EngineDecideReply.safeParse(reply.body);
    return answer.success ? send(res, 200, answer.data) : send(res, 502, { error: "cloud_error" });
  }
  if (reply.status === 0) return send(res, 502, { error: "cloud_unreachable" });
  send(res, [400, 401, 403, 404, 409, 429].includes(reply.status) ? reply.status : 502, { error: wordOf(reply.body) });
}

/** Judges `dir` (the socket's parent): made 0700 when missing; a link, someone else's or one open to the group or others is refused. */
function ensureSocketDir(dir: string, uid: number | undefined): void {
  if (lstatSync(dir, { throwIfNoEntry: false }) === undefined) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error("engine-bridge socket: its directory is not a plain directory");
  if (uid !== undefined && st.uid !== uid) throw new Error("engine-bridge socket: its directory is not owned by this user");
  if ((st.mode & 0o077) !== 0) throw new Error("engine-bridge socket: its directory is open to other users");
}

export interface DecideSocket {
  close(): Promise<void>;
}

/** Starts serving. Rejects with a fixed message when the directory is unsafe or the path is taken by something that is not a socket. */
export async function serveDecideSocket(deps: DecideSocketDeps): Promise<DecideSocket> {
  ensureSocketDir(path.dirname(deps.socketPath), deps.uid);
  const old = lstatSync(deps.socketPath, { throwIfNoEntry: false });
  if (old !== undefined) {
    if (!old.isSocket()) throw new Error("engine-bridge socket: something that is not a socket is at its path");
    unlinkSync(deps.socketPath);
  }
  const server: Server = createServer((req, res) => {
    handleDecide(deps, req, res).catch(() => {
      // fx-swallow-ok: the error could name a request; the engine gets one fixed word and the log one fixed line
      deps.log("engine-bridge: a decide request failed");
      if (!res.headersSent) send(res, 500, { error: "internal" });
    });
  });
  server.maxConnections = 16;
  server.requestTimeout = 15_000;
  server.headersTimeout = 5_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(deps.socketPath, () => resolve());
  });
  try {
    chmodSync(deps.socketPath, 0o600);
    if ((lstatSync(deps.socketPath).mode & 0o777) !== 0o600) throw new Error("engine-bridge socket: its mode is not 0600");
  } catch (error) {
    server.close();
    throw error;
  }
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
