import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/** One tool call the scripted model asks for. `id` is how its result is found again. */
export interface ScriptedCall {
  id: string;
  name: "Bash" | "Read" | "Grep" | "Glob";
  input: Record<string, unknown>;
}
export interface ToolResultText {
  text: string;
  isError: boolean;
}

/**
 * A loopback stand-in for the Messages API, for tests only (D#587 B-10.5). The production runner refuses
 * `ANTHROPIC_BASE_URL` in a job's environment (`cleanEnv` copies no such name and `jobEnv` throws on it), so nothing
 * here can reach a customer job.
 *
 * It plays a script of steps. Each step is a list of tool calls sent as ONE assistant message; the next step is sent
 * once every call of the previous step has a result in the conversation. When the script is done it answers with text
 * and ends the turn. Every other request the CLI makes (a title, a token count, a model list) gets a minimal valid
 * answer, so only the tool calls come from the script. It holds no credential and checks none.
 */
export class FakeMessagesApi {
  readonly results = new Map<string, ToolResultText>();
  /** Every request body as received, for the "sentinel is in no proxy log" check. */
  readonly rawRequests: string[] = [];
  private server: Server | undefined;

  constructor(private readonly script: readonly (readonly ScriptedCall[])[]) {}

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (address === null || typeof address === "string") throw new Error("fake api: no port");
    return `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server === undefined ? resolve() : this.server.close(() => resolve())));
  }

  /** The step to send now: the first whose calls do not all have a result yet, or undefined when the script is done. */
  nextStep(): readonly ScriptedCall[] | undefined {
    return this.script.find((step) => step.some((call) => !this.results.has(call.id)));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (raw !== "") this.rawRequests.push(raw);
    const url = req.url ?? "";
    if (req.method !== "POST") return void send(res, 200, { data: [], has_more: false });
    if (url.includes("count_tokens")) return void send(res, 200, { input_tokens: 1 });
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // fx-swallow-ok: test fake; an unparseable body is answered as an empty request
    }
    const isMain = Array.isArray(body.tools) && body.tools.length > 0;
    if (isMain) this.collect(body);
    const calls = isMain ? this.nextStep() : undefined;
    const model = typeof body.model === "string" ? body.model : "fake-model";
    if (body.stream === true) return void stream(res, model, calls);
    send(res, 200, message(model, calls));
  }

  private collect(body: Record<string, unknown>): void {
    for (const msg of Array.isArray(body.messages) ? (body.messages as Record<string, unknown>[]) : []) {
      if (!Array.isArray(msg.content)) continue;
      for (const block of msg.content as Record<string, unknown>[]) {
        if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
        const content = block.content;
        const text = typeof content === "string" ? content : JSON.stringify(content ?? "");
        this.results.set(block.tool_use_id, { text, isError: block.is_error === true });
      }
    }
  }
}

function send(res: ServerResponse, status: number, json: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(json));
}

function message(model: string, calls: readonly ScriptedCall[] | undefined): Record<string, unknown> {
  const content = calls === undefined ? [{ type: "text", text: "done" }] : calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.input }));
  return { id: "msg_fx", type: "message", role: "assistant", model, content, stop_reason: calls === undefined ? "end_turn" : "tool_use", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
}

/** The same message as a server-sent event stream, in the order the API sends it. */
function stream(res: ServerResponse, model: string, calls: readonly ScriptedCall[] | undefined): void {
  const full = message(model, calls);
  const events: Array<[string, unknown]> = [["message_start", { type: "message_start", message: { ...full, content: [], stop_reason: null } }]];
  (full.content as Array<Record<string, unknown>>).forEach((block, index) => {
    if (block.type === "text") {
      events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }]);
      events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } }]);
    } else {
      events.push(["content_block_start", { type: "content_block_start", index, content_block: { ...block, input: {} } }]);
      events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } }]);
    }
    events.push(["content_block_stop", { type: "content_block_stop", index }]);
  });
  events.push(["message_delta", { type: "message_delta", delta: { stop_reason: full.stop_reason, stop_sequence: null }, usage: { output_tokens: 1 } }]);
  events.push(["message_stop", { type: "message_stop" }]);
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  res.end(events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(""));
}
