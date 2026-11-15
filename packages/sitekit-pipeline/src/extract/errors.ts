export type ExtractErrorCode =
  | "input_invalid"
  | "spend_refused"
  | "policy_invalid"
  | "sandbox_failed"
  | "clone_failed"
  | "policy_failed"
  | "agent_failed"
  | "over_cap"
  | "output_invalid";

/** A refusal with a fixed code. The message never carries repository, agent or adapter text. */
export class ExtractError extends Error {
  constructor(public readonly code: ExtractErrorCode) {
    super(`site extract refused: ${code}`);
    this.name = "ExtractError";
  }
}

/**
 * What an adapter throws when the agent was started and then failed (a timeout, a crash). `usedUsd` is the spend it
 * metered up to that point, when it knows it. A start that may have spent money is never a "spent nothing" outcome:
 * with no figure, the workflow settles the whole reservation.
 */
export class AgentRunError extends Error {
  constructor(public readonly usedUsd?: number) {
    super("site extract agent run failed");
    this.name = "AgentRunError";
  }
}

const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const SHA_RE = /^[0-9a-f]{40}$/;

/** The repository coordinates the prompt and the clone carry outside any fence. Throws `input_invalid` on anything not plain. */
export function assertRepoCoordinates(owner: string, name: string, sha: string): void {
  const ok = typeof owner === "string" && typeof name === "string" && typeof sha === "string" && NAME_RE.test(owner) && NAME_RE.test(name) && owner !== ".." && name !== ".." && SHA_RE.test(sha);
  if (!ok) throw new ExtractError("input_invalid");
}
