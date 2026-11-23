import { MAX_PRD_BYTES } from "../../src/projectDraft.js";

/** D#845 ON-10a: the fixture drafts. Every one is a VALID `ProjectDraft`; the hostile ones carry markup, script-scheme links and a PRD at the byte cap. They are what the render test draws through the public renderer. */
const row = (row_key: string, depends_on: string[] = [], title = `Row ${row_key}`) => ({ row_key, title, summary: `What ${row_key} does.`, size: "M" as const, depends_on });

export const PLAIN_DRAFT = { v: 1 as const, prd_md: "# Plan\n\nA **small** service with `two` parts.\n\n- one\n- two\n", roadmap: [row("A"), row("B", ["A"]), row("C", ["A", "B"])] };

export const HOSTILE_PRD = [
  "# <script>alert(1)</script>",
  "",
  "[click](javascript:alert(1)) and [data](data:text/html;base64,PHNjcmlwdD4=) and [ok](https://example.com/docs)",
  "",
  '<img src=x onerror="alert(1)"> <a href="https://evil.example" onclick="x">raw html</a>',
  "",
  "```",
  "<script>document.cookie</script>",
  "```",
  "",
  "[x](https://u:p@evil.example/) and **<b>bold</b>**",
].join("\n");

export const HOSTILE_DRAFT = {
  v: 1 as const,
  prd_md: HOSTILE_PRD,
  roadmap: [{ row_key: "X", title: "<script>alert(1)</script>", summary: "[x](javascript:alert(1))", size: "S" as const, depends_on: [] as string[] }],
};

/** A PRD of exactly `MAX_PRD_BYTES` UTF-8 bytes (multi-byte characters included) and nothing else odd. */
export function maxPrd(): string {
  const unit = "Section é 日本\n\n";
  let s = "";
  while (Buffer.byteLength(s + unit, "utf8") <= MAX_PRD_BYTES) s += unit;
  while (Buffer.byteLength(s + "x", "utf8") <= MAX_PRD_BYTES) s += "x";
  return s;
}
export const MAX_DRAFT = { v: 1 as const, prd_md: maxPrd(), roadmap: [row("A")] };

export const FIXTURE_DRAFTS = { plain: PLAIN_DRAFT, hostile: HOSTILE_DRAFT, max: MAX_DRAFT };
export { row as draftRow };
