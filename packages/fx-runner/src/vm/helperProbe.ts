/**
 * "Does the helper answer on its socket?" (D#587 B-2a-2 PR-3). Sends the one harmless `list` request and accepts any well-formed reply frame
 * that carries the protocol number: the helper answers a caller that is not the runner (root, here) with `bad_peer`, and that still proves
 * the service is up and speaking its protocol. The reply is read to one newline, at most 4096 bytes, within a time limit; nothing else is read.
 */
import net from "node:net";

const MAX_REPLY = 4096;

function askOnce(socket: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let buf = "";
    const c = net.connect(socket);
    const end = (ok: boolean): void => {
      clearTimeout(timer);
      c.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => end(false), timeoutMs);
    c.on("error", () => end(false));
    c.on("connect", () => c.write('{"verb":"list"}\n'));
    c.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0 && buf.length <= MAX_REPLY) return;
      try {
        const reply = JSON.parse(nl < 0 ? "" : buf.slice(0, nl)) as { protocol?: unknown };
        end(typeof reply.protocol === "number");
      } catch {
        // fx-swallow-ok: a reply that is not one JSON frame is "did not answer"
        end(false);
      }
    });
    c.on("close", () => end(false));
  });
}

/** Asks up to `attempts` times, `delayMs` apart: the service may still be starting when `enable --now` returns. */
export async function probeHelper(socket: string, options: { attempts?: number; delayMs?: number; timeoutMs?: number } = {}): Promise<boolean> {
  const { attempts = 20, delayMs = 250, timeoutMs = 2000 } = options;
  for (let i = 0; i < attempts; i++) {
    if (await askOnce(socket, timeoutMs)) return true;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}
