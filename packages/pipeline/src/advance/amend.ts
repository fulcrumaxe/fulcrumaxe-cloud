import type { Pool } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { WorkItemHaltedError } from "@fx/core/src/work-items/stages.js";
import { MAX_BODY_BYTES, amendSpec, utf8ByteLength, type DiscussionsContext } from "@fx/discussions";
import { systemPrincipal } from "@fx/discussions/server";
import { stripControlTokens } from "@fx/trust";
import { privateOnlyEditsNotAllowed } from "@fulcrumaxe/runner-protocol";
import { CorrectionInputError } from "@fx/core/src/corrections/index.js";
import { parseAmendBody } from "@fx/core/src/corrections/body.js";
import { MAX_SCOPE_ENTRIES, parseAcceptanceScope } from "@fx/core/src/specs/acceptanceScope.js";

/**
 * D#597 CC-2b: delivers accepted Spec amendments. Each is a person's own text, accepted by a person's click. It is published as DATA: the next Spec version
 * is version N's body byte for byte, then one labelled section per amendment, and nothing reads the amendment as an instruction. The text goes through the
 * D#1588 sanitiser's token stripping (`STATUS:<TOKEN>` lines, `SPAWN_REQUEST`, `TERMINATE_REQUEST` and every HTML comment become a visible marker), so a
 * Spec cannot carry a control token that a later reader would act on. The stored correction keeps the text as written (its hash binds it); only the
 * published copy is stripped.
 */
export interface AmendmentItem {
  /** The correction's id. */
  id: string;
  /** The correction's stored body: the text as the person wrote it, or (an amendment that adds files) the JSON body `parseAmendBody` reads. Untrusted for the purposes of control tokens. */
  text: string;
  /** Who accepted it, as the history shows them. */
  name: string;
  /** When it was accepted. */
  date: Date;
}

export type AmendOutcome = { status: "published"; version: number } | { status: "already_published"; version: number } | { status: "refused"; reason: string };

/** Only a plain code ever leaves as a refusal reason. */
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const NAME_MAX = 60;

/** A name that is safe inside the heading: one line, no parentheses, no control tokens. Never empty. */
export function headingName(name: string): string {
  const one = stripControlTokens(name).replace(/[\r\n\t]+/g, " ").replace(/[()]/g, "").replace(/\s+/g, " ").trim();
  return Array.from(one).slice(0, NAME_MAX).join("").trim() || "a team member";
}

/** The section for one amendment: `## Amendment (<person>, <date>)`, then the stripped text as a block quote. */
export function amendmentSection(item: AmendmentItem): string {
  const date = item.date.toISOString().slice(0, 10);
  // Every line is a block-quote line, so the text can neither open a heading nor leave a code fence open: where the amendment ends is where the quote ends.
  const { text, addFiles } = parseAmendBody(item.text);
  const quoted = stripControlTokens(text).trim().split(/\r\n|\r|\n/).map((l) => (l === "" ? ">" : `> ${l}`)).join("\n");
  // The files an amendment adds to the Spec's file list are named as plain text under it (each entry is a plain path, so there is nothing to strip).
  const files = addFiles.length === 0 ? "" : `\nFiles added to the Spec's file list:\n${addFiles.map((f) => `- ${f}`).join("\n")}\n`;
  return `## Amendment (${headingName(item.name)}, ${date})\n\n${quoted}\n${files}`;
}

/** Version N's body, then each section in the order given. A body that does not end in a newline gets one first. */
export function amendedBody(base: string, items: readonly AmendmentItem[]): string {
  const head = base.endsWith("\n") ? base : `${base}\n`;
  return `${head}\n${items.map(amendmentSection).join("\n")}`;
}

/**
 * Publishes the next Spec version carrying `items`, oldest first. `expectedVersion` is not taken from the caller: the newest unerased version is read here
 * and the write refuses `spec_changed` if another version lands in between. A replay is safe: when the newest version already lists every id in its
 * frontmatter nothing more is published (`already_published`), so the caller can stamp the corrections without a second version appearing.
 */
export async function publishAmendment(pool: Pool, accountId: string, workItemId: string, items: readonly AmendmentItem[]): Promise<AmendOutcome> {
  if (items.length === 0) return { status: "refused", reason: "nothing_to_amend" };
  const latest = await withTenant(pool, accountId, async (client) => {
    const { rows } = await client.query<{ version: number; body: string; amended: unknown; files: unknown }>(
      `SELECT version, body, frontmatter -> 'amended_corrections' AS amended, frontmatter -> 'acceptance_files' AS files FROM spec_versions
        WHERE account_id = $1 AND work_item_id = $2 AND erased_at IS NULL ORDER BY version DESC LIMIT 1`,
      [accountId, workItemId],
    );
    return rows[0] ?? null;
  });
  if (latest === null) return { status: "refused", reason: "no_spec_version" };
  const done = Array.isArray(latest.amended) ? new Set(latest.amended.filter((x): x is string => typeof x === "string")) : new Set<string>();
  if (items.every((i) => done.has(i.id))) return { status: "already_published", version: Number(latest.version) };

  // The files the amendments add (each body was checked when the correction was made and accepted; read again here, so a body that cannot be read refuses the publish).
  let addFiles: string[];
  try {
    addFiles = [...new Set(items.flatMap((i) => parseAmendBody(i.text).addFiles))];
  } catch (err) {
    if (err instanceof CorrectionInputError) return { status: "refused", reason: "invalid_add_files" };
    throw err;
  }
  if (addFiles.length > 0) {
    // A Spec with no readable file list gets one by Re-spec, never by an amendment inventing it.
    const held = parseAcceptanceScope(latest.files);
    if (held.kind !== "known") return { status: "refused", reason: "add_files_no_file_list" };
    const list = latest.files as string[];
    if (list.length + addFiles.filter((f) => !list.includes(f)).length > MAX_SCOPE_ENTRIES) return { status: "refused", reason: "file_list_too_large" };
    const overlay = await withTenant(pool, accountId, async (client) => {
      const { rows } = await client.query<{ overlay_globs: string[] }>(
        "SELECT p.overlay_globs FROM work_items w JOIN repo_pairing p ON p.repo_id = w.repo_id AND p.account_id = w.account_id WHERE w.id = $1 AND w.account_id = $2",
        [workItemId, accountId],
      );
      return rows[0]?.overlay_globs ?? [];
    });
    if (privateOnlyEditsNotAllowed(overlay, { kind: "unknown" }, addFiles).length > 0) return { status: "refused", reason: "add_files_private_only" };
  }

  const body = amendedBody(latest.body, items);
  if (utf8ByteLength(body) > MAX_BODY_BYTES) return { status: "refused", reason: "spec_too_large" };

  const ctx: DiscussionsContext = { pool, principal: systemPrincipal(accountId, "pipeline.amend") };
  try {
    const published = await amendSpec(ctx, { workItemId, body, basedOnVersion: Number(latest.version), correctionIds: items.map((i) => i.id), addFiles });
    return { status: "published", version: published.version };
  } catch (err) {
    if (err instanceof WorkItemHaltedError) return { status: "refused", reason: "item_halted" };
    const code = (err as { code?: unknown })?.code;
    // fx-swallow-ok: the refusal is returned as a fixed code and recorded by the caller; the error's text is not kept
    return { status: "refused", reason: typeof code === "string" && CODE.test(code) ? code : "publish_failed" };
  }
}
