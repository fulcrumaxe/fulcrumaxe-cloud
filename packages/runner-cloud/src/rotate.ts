import { RotateMessage } from "@fulcrumaxe/runner-protocol";
import { RunnerHttpError, parseJsonBody, parseMessage, pgCode, type RunnerCloudDeps, type RunnerHttpRequest, type RunnerHttpResponse } from "./http.js";
import { isUsableEd25519Key } from "./strictEd25519.js";
import { verifyRunnerRequest, withRunnerSession } from "./verifyRunnerRequest.js";

export const ROTATE_PATH = "/api/runner/rotate";

/**
 * POST /api/runner/rotate. The request is signed by the runner's CURRENT key (criterion 6: the new key arrives inside a
 * request the old key signed) and carries the new public key. The middleware has verified that signature, so the
 * session may name the runner in the runner-id session setting; `runner_rotate_key` (0712) refuses any session that does not, and
 * compares the old thumbprint, so a member session can never reach it. A reused nonce is 409. After the rotation the
 * old key is unknown: its next request gets 401.
 */
export async function rotateRunnerKey(deps: RunnerCloudDeps, req: RunnerHttpRequest): Promise<RunnerHttpResponse> {
  const runner = await verifyRunnerRequest(deps, ROTATE_PATH, req, { replay: "once" });
  const message = parseMessage(RotateMessage, parseJsonBody(req));
  if (!isUsableEd25519Key(message.public_key_jwk.x)) throw new RunnerHttpError(400, "invalid_key", "the public key is not usable");
  try {
    const jkt = await withRunnerSession(deps.appUserPool, runner, async (client) => {
      const { rows } = await client.query<{ jkt: string }>("SELECT runner_rotate_key($1, $2, $3::jsonb) AS jkt", [runner.runnerId, runner.jkt, JSON.stringify(message.public_key_jwk)]);
      return rows[0]!.jkt;
    });
    return { status: 200, body: { jkt }, headers: { "cache-control": "no-store" } };
  } catch (error) {
    switch (pgCode(error)) {
      case "22023":
        throw new RunnerHttpError(400, "invalid_key", "the public key is not usable");
      case "23505":
        throw new RunnerHttpError(409, "key_registered", "that key is already registered");
      case "42501":
      case "P0002":
      case "55000":
        throw new RunnerHttpError(401, "unauthorized", "the request is not signed by a registered runner");
      default:
        throw error;
    }
  }
}
