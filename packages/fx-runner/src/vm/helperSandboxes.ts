/**
 * The uninstall's two questions to the helper (D#587 B-2a-2 PR-5): which sandboxes exist, and destroy this one. One connection per request, one JSON
 * line out and one back, the helper's own frames (the same ones `helperProbe.ts` sends). The reply is checked field by field; anything that does not
 * fit, a refusal included, is `HelperSilent` with a fixed message, so the caller can only tell an answer from no answer, and nothing the helper
 * sent is echoed. The socket path is handed in; this file reads no `process.*`.
 */
import net from "node:net";

const PROTOCOL = 1;
const MAX_REPLY = 1 << 20;
/** The helper's own id pattern, copied exactly out of the variable named idPattern in vmhelper/internal/protocol/protocol.go (the `protocol.ValidID` check every helper verb applies). */
const SANDBOX_ID =/^[a-z0-9][a-z0-9-]{0,39}$/;

/** The helper did not give a usable answer: no socket, no reply in time, a refusal, or a reply that is not the protocol's. */
export class HelperSilent extends Error {
  constructor() {
    super("the sandbox helper did not answer");
    this.name = "HelperSilent";
  }
}

export interface HelperSandboxes {
  /** The ids of the sandboxes the helper holds. */
  list(): Promise<string[]>;
  /** Destroys one; resolves only when the helper said it did. */
  destroy(sandboxId: string): Promise<void>;
}

function call(socket: string, frame: Record<string, string>, timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const c = net.connect(socket);
    const end = (error: HelperSilent | null, value?: Record<string, unknown>): void => {
      clearTimeout(timer);
      c.destroy();
      if (error !== null) reject(error);
      else resolve(value ?? {});
    };
    const timer = setTimeout(() => end(new HelperSilent()), timeoutMs);
    c.on("error", () => end(new HelperSilent()));
    c.on("close", () => end(new HelperSilent()));
    c.on("connect", () => c.write(`${JSON.stringify(frame)}\n`));
    c.on("data", (d: Buffer) => {
      chunks.push(d);
      size += d.length;
      if (size > MAX_REPLY) return end(new HelperSilent());
      const all = Buffer.concat(chunks);
      const nl = all.indexOf(0x0a);
      if (nl < 0) return;
      try {
        const reply = JSON.parse(all.subarray(0, nl).toString("utf8")) as unknown;
        if (typeof reply !== "object" || reply === null || Array.isArray(reply)) return end(new HelperSilent());
        const r = reply as Record<string, unknown>;
        end(r["ok"] === true && r["protocol"] === PROTOCOL ? null : new HelperSilent(), r);
      } catch {
        // fx-swallow-ok: a reply that is not one JSON frame is "did not answer"; the parser's message could echo helper bytes
        end(new HelperSilent());
      }
    });
  });
}

export function createHelperSandboxes(socket: string, timeoutMs = 10_000): HelperSandboxes {
  return {
    list: async () => {
      const rows = (await call(socket, { verb: "list" }, timeoutMs))["sandboxes"];
      if (!Array.isArray(rows)) throw new HelperSilent();
      return rows.map((row: unknown) => {
        const id = typeof row === "object" && row !== null ? (row as Record<string, unknown>)["sandbox_id"] : undefined;
        if (typeof id !== "string" || !SANDBOX_ID.test(id)) throw new HelperSilent();
        return id;
      });
    },
    destroy: async (sandboxId) => {
      if (!SANDBOX_ID.test(sandboxId)) throw new HelperSilent();
      await call(socket, { verb: "destroy", sandbox_id: sandboxId }, timeoutMs);
    },
  };
}
