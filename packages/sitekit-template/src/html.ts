/**
 * Minimal HTML-text escaping, shared by every renderer in this package.
 * Used for both text nodes and attribute values (the same five characters
 * are unsafe in both positions, so one function covers both).
 */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
