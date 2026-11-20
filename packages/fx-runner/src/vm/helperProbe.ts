/**
 * "Does the helper answer on its socket?" (D#587 B-2a-2 PR-3). Sends the one harmless `list` request and accepts any well-formed reply frame
 * that carries the protocol number: the helper answers a caller that is not the runner (root, here) with `bad_peer`, and that still proves
 * the service is up and speaking its protocol. The reply is read to one newline, at most 4096 bytes, within a time limit; nothing else is read.
 */
import net from "node:net";
import type { HelperState } from "./limits.js";

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

/**
 * What the helper says when asked once (D#587 B-5a part 3): `ready` when it answers a `list` with a frame that carries this build's protocol number and `ok: true`,
 * `out_of_date` when the frame carries another number (an older or newer helper: the same fix, `fx-runner vm install`), and `not_ready` for everything else
 * (no answer in time, a socket that refuses, a reply that is not one frame, a refusal by the helper). One attempt: the claim gate asks again on its own schedule.
 */
export function askHelperState(socket: string, expectedProtocol: number, timeoutMs = 2000): Promise<HelperState> {
  return new Promise((resolve) => {
    let buf = "";
    let done = false;
    const c = net.connect(socket);
    const end = (state: HelperState): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      c.destroy();
      resolve(state);
    };
    const timer = setTimeout(() => end("not_ready"), timeoutMs);
    c.on("error", () => end("not_ready"));
    c.on("connect", () => c.write('{"verb":"list"}\n'));
    c.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0 && buf.length <= MAX_REPLY) return;
      try {
        const reply = JSON.parse(nl < 0 ? "" : buf.slice(0, nl)) as { protocol?: unknown; ok?: unknown };
        if (typeof reply.protocol !== "number") end("not_ready");
        else if (reply.protocol !== expectedProtocol) end("out_of_date");
        else end(reply.ok === true ? "ready" : "not_ready");
      } catch {
        // fx-swallow-ok: a reply that is not one JSON frame is "not ready"
        end("not_ready");
      }
    });
    c.on("close", () => end("not_ready"));
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
