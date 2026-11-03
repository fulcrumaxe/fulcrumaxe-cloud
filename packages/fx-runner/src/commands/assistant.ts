/** `fx-runner assistant link` (D#597 CC-7a-1): links to the cloud this runner registered with, under a client id made from its runner id. */
import { runUnlink } from "../assistant/unlink.js";
import { runLink } from "../assistant/link.js";
import { CliError } from "../cliError.js";
import { loadRegistration } from "../config.js";
import type { CommandContext } from "../context.js";
import { requireUsable } from "../protectionBypass.js";

export async function assistantCommand(words: readonly string[], ctx: CommandContext): Promise<number> {
  if (words[0] === "unlink") {
    await runUnlink({ stateDir: ctx.stateDir, uid: ctx.uid, fetchFn: ctx.fetchFn, out: ctx.out, bypass: requireUsable(ctx.bypass) });
    return 0;
  }
  if (words[0] !== "link") throw new CliError("assistant takes: link or unlink", 2);
  const registration = loadRegistration(ctx.stateDir);
  if (registration === undefined) throw new CliError("this machine is not registered; run: fx-runner register first");
  await runLink({
    origin: registration.cloud_origin,
    clientId: `runner-${registration.runner_id}`,
    stateDir: ctx.stateDir,
    uid: ctx.uid,
    fetchFn: ctx.fetchFn,
    now: ctx.now,
    sleep: ctx.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    out: ctx.out,
    bypass: requireUsable(ctx.bypass),
  });
  return 0;
}
