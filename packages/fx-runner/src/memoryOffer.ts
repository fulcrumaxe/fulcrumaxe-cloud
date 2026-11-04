/**
 * D#601 MEM-6: what happens to the memory proposals a run's agent wrote, on the machine the run ran on.
 *
 * The agent may end its AGENT_OUTPUT envelope with `memory_proposals`. That text is untrusted. It is taken out of the envelope before `done` is sent (jobHandler), so it
 * is in no request body, and it reaches the cloud only when the person says yes to that exact proposal at their own terminal, after the run has ended:
 *
 *   - Read: the strict reader below keeps at most three proposals, each as a scope, a kind and a body from closed sets and a text check (no control or format character, 1 to
 *     1024 bytes). Anything else about a proposal (a reason, a role, any other key) is dropped on the spot and never shown or sent. A proposal that fails the check stays out.
 *   - Offered once per run: the local record `memory-offer-<run id>.json` (0600, in the state directory) is written before the first question, and a run whose record exists is never
 *     offered again. It holds the proposals and what became of each, so a "no" is kept on this machine and nothing is lost.
 *   - Asked once per proposal, never as a batch, on the terminal only (ttyAsk.ts). No terminal, a build whose cloud dropped `mem_proposal_v1`, a timeout and a closed input are all "no".
 *     A daemon that has no terminal never asks and never sends; it says one line.
 *   - Bound to the text: the sha256 shown is the hash of the body bytes. Before sending, each yes is checked against the local record as it is on disk NOW (body and hash must still be
 *     the ones shown); any difference makes that proposal a "no". The message carries scope, kind, body and that same hash, nothing else.
 *   - One send, no retry: a failed or refused send is one fixed sentence, and a new yes would need a new offer, which the record forbids for this run.
 *
 * Every sentence below is fixed. None includes text from the cloud, and the only agent text that is ever drawn is a checked body.
 */
import { createHash } from "node:crypto";
import { MEMORY_PROPOSAL_KINDS, MEMORY_PROPOSAL_SCOPES, MAX_MEMORY_PROPOSALS_PER_RUN, MemoryProposalItem, type MemoryProposalsMessage } from "@fulcrumaxe/runner-protocol";
import { readPrivateFile, writePrivateFile } from "./config.js";
import type { MemoryProposalsResult } from "./daemon/client.js";

export const OFFER_TIMEOUT_MS = 120_000;
const VIEWS_PER_PROPOSAL = 3;
const PREVIEW_CHARS = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `unconfirmed`: sent in a message of which the cloud took in only some (it answers counts, not which), so none of them is called sent. */
export type OfferState = "pending" | "sent" | "kept_local" | "failed" | "unconfirmed";
export interface OfferedProposal {
  scope: (typeof MEMORY_PROPOSAL_SCOPES)[number];
  kind: (typeof MEMORY_PROPOSAL_KINDS)[number];
  body: string;
  sha256: string;
}
interface OfferRecord {
  run_id: string;
  proposals: Array<OfferedProposal & { state: OfferState }>;
}

/** The fixed sentences. `Owner copy` in the pull request lists the same words. */
export const OFFER_COPY = {
  stayed: (n: number): string => `fx-runner: ${n} memory ${n === 1 ? "proposal" : "proposals"} stayed on this machine`,
  sent: (n: number): string => `fx-runner: sent ${n} memory ${n === 1 ? "proposal" : "proposals"} to your workspace. ${n === 1 ? "It waits" : "They wait"} in the memory queue until someone approves; you can reject ${n === 1 ? "it" : "them"} there.`,
  notTaken: "fx-runner: your workspace did not take that memory proposal in; it stayed on this machine",
  already: "fx-runner: your workspace already has memory proposals from this run, so nothing more was sent",
  failed: "fx-runner: the memory proposal could not be sent, so it stayed on this machine; nothing was retried",
  changed: "fx-runner: a memory proposal changed after you saw it, so it stayed on this machine",
  noAnswer: "fx-runner: no answer, so that memory proposal stayed on this machine",
} as const;

const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** The strict reader: the proposals this run may offer, from the untrusted envelope value. Never throws. */
export function readProposals(raw: unknown): OfferedProposal[] {
  if (!Array.isArray(raw)) return [];
  const out: OfferedProposal[] = [];
  const seen = new Set<string>();
  for (const item of raw.slice(0, MAX_MEMORY_PROPOSALS_PER_RUN)) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const { scope, kind, body } = item as Record<string, unknown>;
    if (typeof body !== "string") continue;
    const parsed = MemoryProposalItem.safeParse({ scope, kind, body, body_sha256: sha256Hex(body) });
    // The same body twice is one proposal, the first: a yes is bound to a body, so a body has one scope and one kind.
    if (parsed.success && !seen.has(body)) {
      seen.add(body);
      out.push({ scope: parsed.data.scope, kind: parsed.data.kind, body: parsed.data.body, sha256: parsed.data.body_sha256 });
    }
  }
  return out;
}

/** The title is built from the two closed words, never from agent text. */
const titleOf = (p: OfferedProposal): string => `${p.kind} (${p.scope} scope)`;
const preview = (body: string): string => {
  const chars = Array.from(body);
  return chars.length > PREVIEW_CHARS ? `${chars.slice(0, PREVIEW_CHARS).join("")}...` : body;
};
/** The Spec's line, with the help words on a second line. */
export const questionFor = (p: OfferedProposal): string =>
  `Send 1 memory proposal to your workspace? "${titleOf(p)}" (${preview(p.body)}) sha256:${p.sha256.slice(0, 8)} The run transcript stays on this machine. [y/N]\n` +
  `  Type v to see all of it. A sent proposal waits in your workspace's memory queue until someone approves it, and you can reject it there.\n> `;

export interface MemoryOfferDeps {
  stateDir: string;
  /** True once the hello kept `mem_proposal_v1`. False means nothing is offered or sent. */
  enabled: () => boolean;
  /** Whether this program was started on a terminal. A service has none. */
  interactive: boolean;
  /** One line from the terminal, or undefined (timeout, closed input, no terminal). Absent counts as no terminal. */
  ask?: ((question: string, timeoutMs: number, signal?: AbortSignal) => Promise<string | undefined>) | undefined;
  /** Aborts when the program is asked to stop (Ctrl-C): the open question ends as no, and no further question is asked. */
  signal?: AbortSignal | undefined;
  say: (line: string) => void;
  send: (message: MemoryProposalsMessage) => Promise<MemoryProposalsResult>;
  timeoutMs?: number;
}

const fileOf = (runId: string): string => `memory-offer-${runId}.json`;

function writeRecord(deps: MemoryOfferDeps, record: OfferRecord): void {
  writePrivateFile(deps.stateDir, fileOf(record.run_id), `${JSON.stringify(record)}\n`);
}

/** The proposals as the record on disk holds them now, or undefined when the record cannot be read back. */
function readRecord(deps: MemoryOfferDeps, runId: string): OfferRecord | undefined {
  try {
    const text = readPrivateFile(deps.stateDir, fileOf(runId));
    return text === undefined ? undefined : (JSON.parse(text) as OfferRecord);
  } catch {
    // fx-swallow-ok: a record that cannot be read back means no proposal can be proved unchanged, so none is sent
    return undefined;
  }
}

/**
 * Builds the offer. The returned function is called once per finished run with the run id and the envelope's `memory_proposals` value; it resolves when the person has
 * answered every question and the one send (if any) is over. Offers for different runs are asked one after the other, so two questions never share a terminal. It never throws.
 */
export function createMemoryOffer(deps: MemoryOfferDeps): (runId: string, raw: unknown) => Promise<void> {
  let queue: Promise<void> = Promise.resolve();
  return (runId, raw) => {
    queue = queue.then(() => offer(deps, runId, raw)).catch(() => deps.say(OFFER_COPY.failed));
    return queue;
  };
}

async function offer(deps: MemoryOfferDeps, runId: string, raw: unknown): Promise<void> {
  if (!UUID.test(runId)) return;
  const proposals = readProposals(raw);
  if (proposals.length === 0) return;
  // One offer per run id: a record that exists means this run was offered (or kept) already.
  if (readPrivateFile(deps.stateDir, fileOf(runId)) !== undefined) return;
  // A role lesson from a runner run has no way in later (the cloud takes a role proposal only once the item is done, and a runner run is not revisited), so it is never offered: it stays in the record.
  const offerable = proposals.filter((p) => p.scope !== "role");
  const record: OfferRecord = { run_id: runId, proposals: proposals.map((p) => ({ ...p, state: (p.scope === "role" ? "kept_local" : "pending") as OfferState })) };
  writeRecord(deps, record);
  const settle = (): void => {
    for (const p of record.proposals) if (p.state === "pending") p.state = "kept_local";
    writeRecord(deps, record);
  };
  const ask = deps.ask;
  if (!deps.interactive || ask === undefined || !deps.enabled() || offerable.length === 0) {
    settle();
    deps.say(OFFER_COPY.stayed(proposals.length));
    return;
  }

  // One question per proposal. A yes is only a note of the hash that was shown.
  const yes: OfferedProposal[] = [];
  let kept = proposals.length - offerable.length;
  for (const p of offerable) {
    let answer: string | undefined;
    for (let views = 0; ; views++) {
      answer = deps.signal?.aborted === true ? undefined : await ask(questionFor(p), deps.timeoutMs ?? OFFER_TIMEOUT_MS, deps.signal);
      if (answer?.trim().toLowerCase() === "v" && views < VIEWS_PER_PROPOSAL) {
        deps.say(`${p.body}\n`);
        continue;
      }
      break;
    }
    if (answer === undefined) deps.say(OFFER_COPY.noAnswer);
    if (answer !== undefined && /^(y|yes)$/i.test(answer.trim())) yes.push(p);
    else kept++;
  }

  // Before anything is sent, each yes is held against the record on disk: the body must still hash to what was shown.
  const onDisk = readRecord(deps, runId);
  const toSend: MemoryProposalsMessage["proposals"] = [];
  for (const p of yes) {
    // Scope, kind and body must all be what was shown; what is sent is what was shown (held in memory), never read back from the record.
    const held = onDisk?.proposals.find((q) => q.sha256 === p.sha256 && q.scope === p.scope && q.kind === p.kind && q.body === p.body);
    if (held !== undefined && sha256Hex(p.body) === p.sha256) {
      toSend.push({ scope: p.scope, kind: p.kind, body: p.body, body_sha256: p.sha256 });
    } else {
      kept++;
      deps.say(OFFER_COPY.changed);
    }
  }
  if (toSend.length === 0) {
    settle();
    if (kept > 0) deps.say(OFFER_COPY.stayed(kept));
    return;
  }

  const result = await deps.send({ run_id: runId, proposals: toSend });
  const sentHashes = new Set(toSend.map((p) => p.body_sha256));
  if (result.kind === "sent" && result.status === "ingested") {
    const state: OfferState = result.refused === 0 && result.stored === toSend.length ? "sent" : result.stored === 0 ? "kept_local" : "unconfirmed";
    for (const p of record.proposals) if (sentHashes.has(p.sha256)) p.state = state;
    if (result.stored > 0) deps.say(OFFER_COPY.sent(result.stored));
    if (result.refused > 0) deps.say(OFFER_COPY.notTaken);
  } else {
    for (const p of record.proposals) if (sentHashes.has(p.sha256)) p.state = "failed";
    deps.say(result.kind === "sent" ? OFFER_COPY.already : OFFER_COPY.failed);
  }
  settle();
  if (kept > 0) deps.say(OFFER_COPY.stayed(kept));
}
