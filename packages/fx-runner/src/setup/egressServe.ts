/**
 * The two programs that run INSIDE a standard-tier setup sandbox (D#845 ON-8e, `hostGuest.ts`). Neither is in --help.
 *
 * `fx-runner __egress-serve <socket>`: the forwarder. The sandbox has no network of its own; this relays every connection made to `127.0.0.1:5253` (where the guest's proxy variables point) to the one Unix socket of the
 * runner's egress proxy for this job, and nothing else: it makes no decision (the proxy does), reads no file and no environment, and opens no other address. The socket sits in a directory the guest only sees read-only,
 * so what the forwarder connects to is not something the guest can change. It runs until the sandbox ends.
 *
 * `fx-runner __egress-wait`: asks the loopback port whether it answers, and ends 0 when it does (non-zero after a bound). It replaces a "ready file": every place the sandbox can write is a place the command can write too, so
 * a file there proves nothing, and a place it cannot write is a place the forwarder cannot write either. A connection to the port is the one signal both sides share.
 */
import net from "node:net";
import path from "node:path";
import { CliError } from "../cliError.js";
import type { CommandContext } from "../context.js";

export const EGRESS_FORWARD_PORT = 5253;
/** How long `__egress-wait` keeps asking, in milliseconds. */
const WAIT_LIMIT_MS = 10_000;
const WAIT_STEP_MS = 50;

export function egressServeCommand(socket: string | undefined, ctx: Pick<CommandContext, "err">): Promise<number> {
  if (socket === undefined || !path.isAbsolute(socket)) throw new CliError("__egress-serve needs an absolute socket", 2);
  return new Promise<number>((resolve) => {
    const server = net.createServer((client) => {
      const upstream = net.connect(socket);
      const end = (): void => void (client.destroy(), upstream.destroy());
      client.on("error", end).on("close", end);
      upstream.on("error", end).on("close", end);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    server.on("error", () => {
      ctx.err("fx-runner: the egress forwarder could not listen");
      resolve(1);
    });
    server.listen(EGRESS_FORWARD_PORT, "127.0.0.1");
  });
}

export function egressWaitCommand(): Promise<number> {
  const deadline = Date.now() + WAIT_LIMIT_MS;
  return new Promise<number>((resolve) => {
    const attempt = (): void => {
      const probe = net.connect(EGRESS_FORWARD_PORT, "127.0.0.1");
      probe.on("connect", () => {
        probe.destroy();
        resolve(0);
      });
      probe.on("error", () => {
        probe.destroy();
        if (Date.now() >= deadline) resolve(1);
        else setTimeout(attempt, WAIT_STEP_MS);
      });
    };
    attempt();
  });
}
