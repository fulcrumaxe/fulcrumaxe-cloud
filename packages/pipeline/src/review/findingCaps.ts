/**
 * D#600 CX-4a: the caps on a reviewer's findings, in one place for the two cuts that use them: `readVerdict` (what is kept of a verdict) and the fix
 * prompt (what the prompt carries). A finding cut at `MAX_FINDING_CHARS`, or findings past `MAX_FINDINGS`, are the "findings beyond the caps" that
 * leave the prompt first. The full text is not lost: `readVerdict` returns it beside the cut text, and the assembler spills it to a file and marks the
 * cut in the prompt.
 */
export const MAX_FINDINGS = 20;
export const MAX_FINDING_CHARS = 600;
