import { isIP } from "node:net";
import { RegisterMessage, RegisterResponse } from "@fulcrumaxe/runner-protocol";
import { withTenant } from "@fx/db/src/withTenant.js";
import { MAX_BODY_BYTES, RunnerHttpError, parseJsonBody, parseMessage, pgCode, type RunnerCloudDeps, type RunnerHttpRequest, type RunnerHttpResponse } from "./http.js";
import { PROVISIONING_TOKEN_PREFIX, hashProvisioningToken } from "./provisioningTokens.js";
import { hashRegistrationCode } from "./registrationCodes.js";
import { verifySelfSignedRequest } from "./verifyRunnerRequest.js";

export const REGISTER_PATH = "/api/runner/register";
/** The limit for an account on this plan, or 503 when the plan data cannot say. A missing figure is never a default, and never unlimited. */
function maxRunnersOf(deps: RunnerCloudDeps, plan: string | undefined): number {
  try {
    const max = plan === undefined ? undefined : deps.maxRunners?.(plan);
    if (typeof max === "number" && Number.isInteger(max) && max >= 0) return max;
  } catch {
    // fx-swallow-ok: unavailable plan data is the same refusal as no figure; the 503 below is the report
  }
  throw new RunnerHttpError(503, "plan_unavailable", "the runner limits are not available");
}

/**
 * POST /api/runner/register. The runner proves it holds the key by signing with it. Account, registrant, credential mode
 * and repos all come from the code's own row, through `runner_register` (0712, 0757), which also enforces single use, the
 * expiry, the minter still being an owner or admin, and the plan's runner limit (the plan data's, passed in). A replay is 409 `key_registered` (README).
 * The 201 reply is `RegisterResponse`: the runner id, the account and the credential mode, the last two read from the stored row.
 */
export async function registerRunner(deps: RunnerCloudDeps, req: RunnerHttpRequest): Promise<RunnerHttpResponse> {
  if (req.body.byteLength > MAX_BODY_BYTES) throw new RunnerHttpError(413, "body_too_large", "the request body is too large");
  const message = parseMessage(RegisterMessage, parseJsonBody(req));
  const jkt = await verifySelfSignedRequest(deps, REGISTER_PATH, req, message.public_key_jwk);

  // The signer already has a runner: this is a replay of its registration (or a second try), never a second runner.
  const existing = await deps.appUserPool.query<{ taken: boolean }>("SELECT runner_jkt_registered($1) AS taken", [jkt]);
  if (existing.rows[0]?.taken === true) throw new RunnerHttpError(409, "key_registered", "that key is already registered");

  // Two kinds of secret reach this route: the one-time code (`fxrr_`) and a provisioning token (`fxrp_`, D#605 FL-6). The prefix picks the kind; each is
  // checked by its own definer for single use, expiry and the minter's role, and every failure answers the same 401.
  const provisioning = message.code.startsWith(PROVISIONING_TOKEN_PREFIX);
  const codeHash = provisioning ? hashProvisioningToken(message.code) : hashRegistrationCode(message.code);
  // A header that is not an address is recorded as unknown. It is for display only and never decides anything.
  const clientIp = req.clientIp !== undefined && isIP(req.clientIp) !== 0 && !req.clientIp.includes("%") ? req.clientIp : null;

  // Before a tenant is known: which account does this code belong to? An unknown code and a used one look the same.
  const { rows } = await deps.appUserPool.query<{ account_id: string | null }>(
    provisioning ? "SELECT runner_provisioning_token_account($1) AS account_id" : "SELECT runner_code_account($1) AS account_id",
    [codeHash],
  );
  const accountId = rows[0]?.account_id;
  if (!accountId) throw new RunnerHttpError(401, "invalid_code", "the registration code is not valid");

  try {
    // The mode comes back from the stored row (the code's own mode, copied by `runner_register`), in the same transaction.
    const body = await withTenant(deps.appUserPool, accountId, async (client) => {
      // Every plan has the plan data's limit (D#6 R2b criterion 12, D#605 FL-12a); plan data that cannot give one refuses the registration.
      const plan = (await client.query<{ plan: string }>("SELECT plan FROM accounts WHERE id = $1", [accountId])).rows[0]?.plan;
      const maxRunners = maxRunnersOf(deps, plan);
      const result = provisioning
        ? await client.query<{ id: string }>("SELECT runner_provisioning_register($1, $2::jsonb, NULL, $3, $4) AS id", [codeHash, JSON.stringify(message.public_key_jwk), maxRunners, clientIp])
        : await client.query<{ id: string }>("SELECT runner_register($1, $2::jsonb, NULL, $3) AS id", [codeHash, JSON.stringify(message.public_key_jwk), maxRunners]);
      const id = result.rows[0]!.id;
      // D#605 FL-2: the runner's own name, as the default name of the row this registration just made. The definer accepts only a runner created by
      // this very transaction (migration 0789), so it is never a rename. No name: nothing is written, and the row reads as an unnamed runner.
      if (message.name !== undefined) await client.query("SELECT runner_name_initial($1::uuid, $2)", [id, message.name]);
      const row = await client.query<{ credential_mode: string }>("SELECT credential_mode FROM runners WHERE id = $1 AND account_id = $2", [id, accountId]);
      // Parsed inside the transaction: a reply that does not fit the protocol rolls the registration back.
      return RegisterResponse.parse({ runner_id: id, account_id: accountId, credential_mode: row.rows[0]?.credential_mode });
    });
    return { status: 201, body, headers: { "cache-control": "no-store" } };
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
