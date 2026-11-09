/**
 * Extracts the `<!-- AGENT_OUTPUT --> ```json {...}``` <!-- /AGENT_OUTPUT -->`
 * block every role card asks agents to end their final message with. Pure
 * string/JSON parsing, no I/O — used by the local runner to populate
 * `NormalizedEvent.agentOutput` on the final result event.
 *
 * D#2 H14c-ENV-1/2: the LAST block wins, not the first. An agent's final
 * message can quote earlier text (a diff, a log, a PR body) that contains a
 * planted `{"verdict":"pass"}` block; the agent's own envelope is always the
 * final thing it writes. If the last block is malformed the result is
 * `undefined` — an earlier block is never a fallback, or a planted pass
 * would win the moment the real block failed to parse.
 *
 * The body between the markers may not itself contain an opening marker, so
 * an unterminated earlier block cannot swallow the real one that follows.
 */
/** Longer input is refused (`undefined`, which the gate reads as no verdict). */
export const MAX_ENVELOPE_INPUT_BYTES = 256 * 1024;

const MARKER = /<!--\s*AGENT_OUTPUT\s*-->/g;
const OPENER = /<!--\s*AGENT_OUTPUT\s*-->\s*```json\s*/g;
const CLOSER = /```\s*<!--\s*\/AGENT_OUTPUT\s*-->/g;

const starts = (re: RegExp, text: string): { at: number; end: number }[] =>
  Array.from(text.matchAll(re), (m) => ({ at: m.index, end: m.index + m[0].length }));

/**
 * The body of the last block, found in one linear pass: each opener pairs
 * with the first closer after it, unless another opening marker comes first
 * (a regex with a lazy body and a negative lookahead per character was cubic
 * on repeated whitespace).
 */
function lastBody(text: string): string | undefined {
  return lastBlock(text)?.body;
}

/** The last complete block: its body and where its own closing marker ends. */
function lastBlock(text: string): { body: string; end: number } | undefined {
  const markers = starts(MARKER, text);
  const closers = starts(CLOSER, text);
  let m = 0;
  let c = 0;
  let last: { body: string; end: number } | undefined;
  for (const { end: bodyStart } of starts(OPENER, text)) {
    while (m < markers.length && markers[m]!.at < bodyStart) m++;
    while (c < closers.length && closers[c]!.at < bodyStart) c++;
    const closer = closers[c];
    if (!closer) break;
    if (m < markers.length && markers[m]!.at < closer.at) continue;
    last = { body: text.slice(bodyStart, closer.at).trim(), end: closer.end };
  }
  return last;
}

export function extractAgentOutputEnvelope(text: string): Record<string, unknown> | undefined {
  // UTF-16 units never exceed UTF-8 bytes, so a longer string is over the cap.
  if (text.length > MAX_ENVELOPE_INPUT_BYTES || new TextEncoder().encode(text).length > MAX_ENVELOPE_INPUT_BYTES) return undefined;
  const body = lastBody(text);
  if (body === undefined) return undefined;
  try {
    const parsed = JSON.parse(body);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    // fx-swallow-ok: a body that is not JSON is "no envelope"; the caller rejects it
    return undefined;
  }
}

/**
 * True when the text ends with a complete block: the last closing marker is the last non-whitespace text. The sandbox port adopts a block from an EARLIER
 * message as the run's envelope (when the final message has none, the shape a background command's trailing turn leaves) only for such a message, so a
 * block that was merely quoted in the middle of a message, with prose after it, is never taken for the agent's answer.
 */
export function endsWithEnvelopeBlock(text: string): boolean {
  // The closing marker that counts is the LAST COMPLETE block's own: a bare closing marker typed after prose does not make an earlier quoted block "the end".
  const block = lastBlock(text);
  return block !== undefined && text.slice(block.end).trim() === "";
}
