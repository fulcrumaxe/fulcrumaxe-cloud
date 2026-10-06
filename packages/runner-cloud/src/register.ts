import { RegisterMessage } from "@fulcrumaxe/runner-protocol";
import { withTenant } from "@fx/db/src/withTenant.js";
import { MAX_BODY_BYTES, RunnerHttpError, parseJsonBody, parseMessage, pgCode, type RunnerCloudDeps, type RunnerHttpRequest, type RunnerHttpResponse } from "./http.js";
import { hashRegistrationCode } from "./registrationCodes.js";
import { verifySelfSignedRequest } from "./verifyRunnerRequest.js";

export const REGISTER_PATH = "/api/runner/register";

/**
 * POST /api/runner/register. The runner proves it holds the key by signing with it. Account, registrant, credential mode
 * and repos all come from the code's own row, through `runner_register` (0712), which also enforces single use, the
 * expiry, the minter still being an owner or admin, and the runner-plan limit. A replay is 409 `key_registered` (README).
 */
export async function registerRunner(deps: RunnerCloudDeps, req: RunnerHttpRequest): Promise<RunnerHttpResponse> {
  if (req.body.byteLength > MAX_BODY_BYTES) throw new RunnerHttpError(413, "body_too_large", "the request body is too large");
  const message = parseMessage(RegisterMessage, parseJsonBody(req));
  const jkt = await verifySelfSignedRequest(deps, REGISTER_PATH, req, message.public_key_jwk);

  // The signer already has a runner: this is a replay of its registration (or a second try), never a second runner.
  const existing = await deps.appUserPool.query<{ taken: boolean }>("SELECT runner_jkt_registered($1) AS taken", [jkt]);
  if (existing.rows[0]?.taken === true) throw new RunnerHttpError(409, "key_registered", "that key is already registered");

  // Before a tenant is known: which account does this code belong to? An unknown code and a used one look the same.
  const codeHash = hashRegistrationCode(message.code);
  const { rows } = await deps.appUserPool.query<{ account_id: string | null }>("SELECT runner_code_account($1) AS account_id", [codeHash]);
  const accountId = rows[0]?.account_id;
  if (!accountId) throw new RunnerHttpError(401, "invalid_code", "the registration code is not valid");

  try {
    const runnerId = await withTenant(deps.appUserPool, accountId, async (client) => {
      const result = await client.query<{ id: string }>("SELECT runner_register($1, $2::jsonb, NULL) AS id", [codeHash, JSON.stringify(message.public_key_jwk)]);
      return result.rows[0]!.id;
    });
    return { status: 201, body: { runner_id: runnerId }, headers: { "cache-control": "no-store" } };
  } catch (error) {
    switch (pgCode(error)) {
      case "P0002": // no_data_found: unusable code (used, expired, minter demoted)
      case "42501": // insufficient_privilege: no active account
        throw new RunnerHttpError(401, "invalid_code", "the registration code is not valid");
      case "53400": // configuration_limit_exceeded
        throw new RunnerHttpError(409, "runner_limit", "this account has reached its runner limit");
      case "23505": // unique_violation
        throw new RunnerHttpError(409, "key_registered", "that key is already registered");
      case "22023": // invalid_parameter_value
        throw new RunnerHttpError(400, "invalid_message", "the message does not match the protocol");
      default:
        throw error;
    }
  }
}
