import { mkdtempSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { ToolError, type DriverConfig, type PageDriver } from "../../src/verifyBrowser/driver.js";
import { startVerifyBrowserServer, type ServerOptions } from "../../src/verifyBrowser/server.js";
import type { RawElement } from "../../src/verifyBrowser/snapshot.js";
import { tmpRoot } from "../helpers/tmpRoot.js";

export const BASE = "https://app.example.test";

export interface FakePage {
  elements: Array<Partial<RawElement> & { name: string; goes?: string }>;
  text: string;
}

/**
 * A strict stand-in for the browser driver. What the real one refuses, this refuses: a ref that the latest scan did not hand out is stale, a navigation to another
 * origin is aborted and counted, password and file fields cannot be typed into, a download link cannot be clicked, and a reload or navigation drops every ref.
 */
export class FakeDriver implements PageDriver {
  current = "about:blank";
  refs = new Map<string, FakePage["elements"][number]>();
  blockedNav = 0;
  blockedReq = 0;
  calls: string[] = [];
  closed = false;
  /** When set, a click on a `goes` element really lands there (a leak the route layer should have stopped), so the URL check after the action has to catch it. */
  leak = false;
  constructor(readonly pages: Record<string, FakePage>, readonly cfg?: DriverConfig) {}

  async go(url: string): Promise<void> {
    this.calls.push(`go ${url}`);
    const u = new URL(url);
    if (url !== "about:blank" && u.origin !== BASE) {
      this.blockedNav += 1;
      this.blockedReq += 1;
      throw new ToolError("action_failed");
    }
    if (url !== "about:blank" && !this.pages[u.pathname]) throw new ToolError("action_failed");
    this.current = url;
    this.refs.clear();
  }
  url(): string {
    return this.current;
  }
  private page(): FakePage {
    return this.pages[new URL(this.current).pathname] ?? { elements: [], text: "" };
  }
  async scan(): Promise<{ elements: RawElement[]; text: string }> {
    this.refs.clear();
    const page = this.page();
    const elements = page.elements.map((e, i): RawElement => {
      const ref = `e${i + 1}`;
      this.refs.set(ref, e);
      return { ref, tag: e.tag ?? "button", role: e.role ?? "", type: e.type ?? "", name: e.name, value: e.value ?? "", disabled: false, download: e.download ?? false };
    });
    return { elements, text: page.text };
  }
  private el(ref: string): FakePage["elements"][number] {
    const e = this.refs.get(ref);
    if (e === undefined) throw new ToolError("stale_ref");
    return e;
  }
  async click(ref: string): Promise<void> {
    const e = this.el(ref);
    if (e.download || e.type === "file") throw new ToolError("refused_element");
    if (e.goes !== undefined) {
      const u = new URL(e.goes, BASE);
      if (u.origin !== BASE && !this.leak) {
        this.blockedNav += 1;
        return;
      }
      this.current = u.href;
      this.refs.clear();
    }
  }
  async fill(ref: string, _text: string): Promise<void> {
    const e = this.el(ref);
    if (["password", "file", "hidden"].includes(e.type ?? "")) throw new ToolError("refused_element");
  }
  async choose(ref: string): Promise<void> {
    this.el(ref);
  }
  async press(key: string): Promise<void> {
    if (!["Enter", "Escape", "Tab"].includes(key)) throw new ToolError("refused_key");
  }
  async reload(): Promise<void> {
    this.refs.clear();
  }
  async waitText(text: string): Promise<boolean> {
    return this.page().text.toLowerCase().includes(text.toLowerCase());
  }
  async textOf(ref: string): Promise<string> {
    return this.el(ref).name;
  }
  blocked(): { requests: number; navigations: number } {
    return { requests: this.blockedReq, navigations: this.blockedNav };
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

export interface Rpc {
  id: number;
  result: { content: Array<{ text: string }>; isError: boolean; tools: Array<{ name: string }>; serverInfo: { name: string } };
  error: { code: number };
}

export interface Rig {
  call(name: string, args?: unknown): Promise<{ text: string; isError: boolean }>;
  rpc(method: string, params?: unknown): Promise<Rpc>;
  driver: () => FakeDriver | undefined;
  jobDir: string;
  server: ReturnType<typeof startVerifyBrowserServer>;
  input: PassThrough;
}

export function rig(pages: Record<string, FakePage>, extra: Partial<ServerOptions> = {}, startJourney = true): Rig {
  const jobDir = mkdtempSync(path.join(tmpRoot(), "vb-job-"));
  const input = new PassThrough();
  const output = new PassThrough();
  let made: FakeDriver | undefined;
  const server = startVerifyBrowserServer({
    baseUrl: BASE,
    jobDir,
    input,
    output,
    hostEnv: {},
    executablePath: "/nonexistent/chrome",
    openDriver: async (cfg) => (made = new FakeDriver(pages, cfg)),
    ...extra,
  });
  const waiting = new Map<number, (m: Rpc) => void>();
  let buffer = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const m = JSON.parse(line) as Rpc;
      waiting.get(m.id)?.(m);
    }
  });
  let id = 0;
  const rpc = (method: string, params?: unknown) =>
    new Promise<Rpc>((resolve) => {
      id += 1;
      waiting.set(id, resolve);
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const call = async (name: string, args?: unknown) => {
    const r = await rpc("tools/call", { name, arguments: args });
    return { text: r.result.content[0]!.text, isError: r.result.isError };
  };
  // The server answers in order, so the journey is started before any call the test makes next.
  if (startJourney) void call("begin_journey", { id: "c1" });
  return { call, rpc, driver: () => made, jobDir, server, input };
}
