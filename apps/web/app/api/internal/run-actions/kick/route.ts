import { start } from "workflow/api";
import { KICK_HEADER, handleKick, kickSecretFromEnv } from "@fx/pipeline";
import { workerConfigured } from "../../../../../lib/worker";
import { runActionWorkflow } from "../../../../../workflows/runAction";

/**
 * D#2 H14c-3b: the run-action kick. Authenticated by the request signature alone
 * (packages/pipeline's handleKick): no session, no cookie, no token. A bad or stale
 * signature is a bare 401; every valid kick is a bare 202 whether or not the action exists.
 */
export async function POST(req: Request): Promise<Response> {
  const status = await handleKick(req.headers.get(KICK_HEADER), await req.text(), {
    secret: kickSecretFromEnv(),
    nowSeconds: () => Math.floor(Date.now() / 1000),
    configured: workerConfigured,
    startWorkflow: async (actionId) => {
      await start(runActionWorkflow, [actionId]);
    },
  });
  return new Response(null, { status });
}
