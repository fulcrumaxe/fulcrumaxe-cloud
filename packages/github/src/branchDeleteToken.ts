import { createPublicKey, randomUUID } from "node:crypto";
import { SignJWT, decodeProtectedHeader, jwtVerify } from "jose";
import type { RunnerGitTicketSigner } from "./runnerGitTicket.js";
import { DELETABLE_BRANCH, type InstallationHttp, type InstallationHttpKind, type InstallationHttpTarget } from "./installationHttp.js";

/**
 * D#598 P1f-5d: the delete-only token. It is a short signed grant that names ONE branch of ONE private repository and the head the platform
 * recorded for it, and the only thing it can be redeemed for is a client (`installationHttp.ts`, kind `branch_delete`) that reads that branch and
 * deletes it, once. It is signed with the git-ticket signing key (the worker reads it from the environment, in one place) but carries its own `typ`, so `verifyRunnerGitTicket`
 * refuses it: it cannot pass for a push ticket. The claims are a strict set; a token with another claim, another branch shape or a lifetime other than
 * the fixed one is refused.
 *
 * The grant never leaves the worker process: the sweep mints it and redeems it in the same call, so a use counter in memory (`jti`, kept until the
 * token's own expiry) is enough for "once". Redeeming also opens the client with a fresh installation token, which `close()` revokes.
 */

export const BRANCH_DELETE_TYP = "fx-branch-delete+jwt";
export const BRANCH_DELETE_LIFETIME_SECONDS = 120;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
const WIRE_CLAIMS = ["acct", "exp", "iat", "item", "jti", "ref", "repo", "sha"].join();

export type BranchDeleteTokenErrorCode = "malformed" | "header" | "signature" | "expired" | "claims" | "used";
/** A refused token. The message is fixed text: it never echoes the token or a claim. */
export class BranchDeleteTokenError extends Error {
  constructor(readonly code: BranchDeleteTokenErrorCode) {
    super(`branchDeleteToken: refused (${code})`);
    this.name = "BranchDeleteTokenError";
  }
}

export interface BranchDeleteGrant {
  accountId: string;
  workItemId: string;
  repo: { id: string; owner: string; name: string };
  /** One of the two branch shapes the platform pushes; never main, a default or a protected name. */
  branch: string;
  /** The head the platform recorded for the branch. The branch is deleted only while GitHub still says this. */
  sha: string;
}

export type BranchDeleteOutcome = "deleted" | "already_gone" | "head_changed" | "protected" | "default_branch" | "repo_gone";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function parseClaims(payload: unknown): (BranchDeleteGrant & { jti: string }) | null {
  if (!isRecord(payload) || Object.keys(payload).sort().join() !== WIRE_CLAIMS) return null;
  const { acct, item, repo, ref, sha, jti, iat, exp } = payload;
  if (typeof acct !== "string" || !UUID.test(acct) || typeof item !== "string" || !UUID.test(item) || typeof jti !== "string" || !UUID.test(jti)) return null;
  if (typeof ref !== "string" || !DELETABLE_BRANCH.test(ref) || typeof sha !== "string" || !SHA.test(sha)) return null;
  if (typeof iat !== "number" || !Number.isSafeInteger(iat) || exp !== iat + BRANCH_DELETE_LIFETIME_SECONDS) return null;
  if (!isRecord(repo) || Object.keys(repo).sort().join() !== "id,name,owner" || typeof repo["id"] !== "string" || !UUID.test(repo["id"]) || typeof repo["owner"] !== "string" || typeof repo["name"] !== "string") return null;
  return { accountId: acct, workItemId: item, repo: { id: repo["id"], owner: repo["owner"], name: repo["name"] }, branch: ref, sha, jti };
}

/** Signs a grant. Throws `BranchDeleteTokenError("claims")` for input the verifier would refuse (a branch outside the two shapes, a short sha). */
export async function mintBranchDeleteToken(grant: BranchDeleteGrant, signer: RunnerGitTicketSigner, now: Date): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000);
  const payload = { acct: grant.accountId, item: grant.workItemId, repo: { id: grant.repo.id, owner: grant.repo.owner, name: grant.repo.name }, ref: grant.branch, sha: grant.sha, jti: randomUUID(), iat, exp: iat + BRANCH_DELETE_LIFETIME_SECONDS };
  if (parseClaims(payload) === null) throw new BranchDeleteTokenError("claims");
  return new SignJWT(payload).setProtectedHeader({ alg: "EdDSA", typ: BRANCH_DELETE_TYP, kid: signer.keyId }).sign(signer.privateKey);
}

export interface BranchDeleteDeps {
  signer: RunnerGitTicketSigner;
  /** `openInstallationHttp`: the client for one repository and (for `branch_delete`) one branch. */
  open: (kind: InstallationHttpKind, target: InstallationHttpTarget) => Promise<InstallationHttp>;
  now?: () => Date;
}

/** Redeemed `jti`s with their expiry (ms). Process-wide on purpose: a token is good for one redemption in this process, whoever holds the deps. */
const spent = new Map<string, number>();

/**
 * Verifies a grant (header, signature, expiry, strict claims), burns its `jti`, and returns its claims with the client the grant allows: pinned to
 * the branch it names. A second redemption of the same token is `used`. The caller must `close()` the client.
 */
export async function redeemBranchDeleteToken(token: string, deps: BranchDeleteDeps): Promise<{ grant: BranchDeleteGrant; http: InstallationHttp }> {
  const now = deps.now ?? (() => new Date());
  if (typeof token !== "string" || token.length === 0 || token.length > 2048) throw new BranchDeleteTokenError("malformed");
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    // fx-swallow-ok: replaced by a fixed code; the parser's text can echo the token
    throw new BranchDeleteTokenError("malformed");
  }
  if (header.alg !== "EdDSA" || header.typ !== BRANCH_DELETE_TYP || header.kid !== deps.signer.keyId) throw new BranchDeleteTokenError("header");
  let payload: unknown;
  try {
    ({ payload } = await jwtVerify(token, createPublicKey(deps.signer.privateKey), { algorithms: ["EdDSA"], typ: BRANCH_DELETE_TYP, currentDate: now() }));
  } catch (error) {
    // fx-swallow-ok: replaced by a fixed code (by the library's `.code`, never its text)
    throw new BranchDeleteTokenError((error as { code?: string } | null)?.code === "ERR_JWT_EXPIRED" ? "expired" : "signature");
  }
  const claims = parseClaims(payload);
  if (claims === null) throw new BranchDeleteTokenError("claims");
  const at = now().getTime();
  for (const [id, until] of spent) if (until <= at) spent.delete(id);
  if (spent.has(claims.jti)) throw new BranchDeleteTokenError("used");
  spent.set(claims.jti, at + (BRANCH_DELETE_LIFETIME_SECONDS + 60) * 1000);
  const grant: BranchDeleteGrant = { accountId: claims.accountId, workItemId: claims.workItemId, repo: claims.repo, branch: claims.branch, sha: claims.sha };
  return { grant, http: await deps.open("branch_delete", { repoId: grant.repo.id, owner: grant.repo.owner, name: grant.repo.name, branch: grant.branch }) };
}

/** Thrown for any answer the contract does not list (a 5xx, a 403, a body of the wrong shape): the caller leaves the item for the next pass. */
export class BranchDeleteUnavailableError extends Error {
  constructor() {
    super("branchDelete: unavailable");
    this.name = "BranchDeleteUnavailableError";
  }
}

/**
 * Redeems the token and removes its branch if, and only if, it still is what was recorded. GitHub's answers: ref read 200 (with the head) or 404;
 * delete 204, 404 (gone) or 422 (gone, or protected: told apart by reading the ref again). The default branch is never deleted.
 */
export async function deleteBranchWithToken(token: string, deps: BranchDeleteDeps): Promise<BranchDeleteOutcome> {
  const { grant, http } = await redeemBranchDeleteToken(token, deps);
  const base = `/repos/${grant.repo.owner}/${grant.repo.name}`;
  const refPath = `${base}/git/ref/heads/${grant.branch}`;
  const head = async (): Promise<string | null> => {
    const res = await http.request({ method: "GET", path: refPath });
    if (res.status === 404) return null;
    const sha = res.status === 200 && isRecord(res.body) && isRecord(res.body["object"]) ? res.body["object"]["sha"] : undefined;
    if (typeof sha !== "string" || !SHA.test(sha)) throw new BranchDeleteUnavailableError();
    return sha;
  };
  try {
    const repo = await http.request({ method: "GET", path: base });
    // The repository itself is gone or no longer visible to the installation: nothing more can be done for this branch, ever.
    if (repo.status === 404) return "repo_gone";
    if (repo.status !== 200 || !isRecord(repo.body)) throw new BranchDeleteUnavailableError();
    if (repo.body["default_branch"] === grant.branch) return "default_branch";
    const current = await head();
    if (current === null) return "already_gone";
    if (current !== grant.sha) return "head_changed";
    const res = await http.request({ method: "DELETE", path: `${base}/git/refs/heads/${grant.branch}` });
    if (res.status === 204) return "deleted";
    if (res.status === 404) return "already_gone";
    if (res.status === 422) return (await head()) === null ? "already_gone" : "protected";
    throw new BranchDeleteUnavailableError();
  } finally {
    await http.close?.();
  }
}
