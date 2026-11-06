import type { PoolClient } from "pg";
import type { ContextSection } from "@fx/runner";

/**
 * D#600 CX-7: the note a fix round's fresh session is given. It is the closing text of the executor run the round follows (the build, or the previous round): the
 * checkpoint summary when the run wrote one, else the `summary` of its parsed AGENT_OUTPUT envelope. It is the agent's own text, so it is returned raw and the caller sends
 * it through the one assembler (`assembleFixNotePrompt`), which sanitises, caps it at 4 KiB and fences it. A run with no text gives `undefined` and the round has no note.
 * The run is read through the tenant's own login: a run of another account or item is simply not found.
 */
export async function readExecutorNote(client: PoolClient, accountId: string, runId: string, workItemId: string): Promise<string | undefined> {
  const { rows } = await client.query<{ summary: string | null }>(
    `SELECT COALESCE(
              (SELECT e.payload->>'summary' FROM run_events e WHERE e.account_id = ar.account_id AND e.run_id = ar.id AND e.kind = 'checkpoint' ORDER BY e.seq LIMIT 1),
              CASE WHEN jsonb_typeof(ar.envelope) = 'object' AND jsonb_typeof(ar.envelope->'summary') = 'string' THEN ar.envelope->>'summary' END
            ) AS summary
       FROM agent_runs ar
      WHERE ar.account_id = $1 AND ar.id = $2 AND ar.work_item_id = $3 AND ar.role = 'executor'`,
    [accountId, runId, workItemId],
  );
  const text = rows[0]?.summary;
  return typeof text === "string" && text.trim() !== "" ? text : undefined;
}

/**
 * The prompt's section list with the note's entry in, in the place the note holds in the prompt: before the closing output section. `noteSections` is the assembler's list for
 * the noted prompt; only its `note` entries are taken (the rest are the same prompt, already counted by the caller's own list). Absent sections stay absent.
 */
export function withNoteSection<T extends readonly ContextSection[] | undefined>(sections: T, noteSections: readonly ContextSection[]): T {
  const notes = noteSections.filter((s) => s.code === "note");
  if (sections === undefined || notes.length === 0) return sections;
  const at = sections.findIndex((s) => s.code === "output");
  const list = [...sections];
  list.splice(at < 0 ? list.length : at, 0, ...notes);
  return list as unknown as T;
}
