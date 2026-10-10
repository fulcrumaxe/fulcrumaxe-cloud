import { ActivityField, redactText, type ToolUse } from "@fulcrumaxe/runner-protocol";

/**
 * What a `tool_use` event may say about itself beyond the tool's name (D#6 C42-2): a coarse kind, a repo-relative path or a short search
 * term, and a shell command's first line. The shared reducer (`extractToolUses`) has already kept only what passes `commandIsClean`, which
 * is redaction with no secrets known. This is the second check, with the run's own secret values: a field that redaction would change
 * is not cut down, it is dropped, and the kind stays. The cloud checks all of it again; this side must already be clean, because a value
 * the protocol schema refuses would cost the whole batch.
 */
function clean(value: string | undefined, secrets: readonly string[]): string | undefined {
  if (value === undefined) return undefined;
  return redactText(value, secrets) === value ? value : undefined;
}

export function activityOf(use: ToolUse, secrets: readonly string[]): ActivityField | undefined {
  if (use.tool === undefined) return undefined;
  const path = clean(use.path, secrets);
  const pattern = clean(use.pattern, secrets);
  const command = use.tool === "command" || use.tool === "test" ? clean(use.command, secrets) : undefined;
  const candidates = [{ tool: use.tool, path, pattern, command }, { tool: use.tool }];
  for (const candidate of candidates) {
    const fields = Object.fromEntries(Object.entries(candidate).filter(([, v]) => v !== undefined));
    const parsed = ActivityField.safeParse(fields);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}
