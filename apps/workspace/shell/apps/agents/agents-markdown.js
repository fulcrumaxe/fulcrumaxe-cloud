// ── Pure markdown + string helpers for the chat renderer ──────────
// Extracted so tests can exercise these without pulling in the full
// ChatRenderer dependency graph (which transitively imports
// core/window-manager.js through agents-terminal-bridge).
/** Tiny markdown-to-HTML escape + formatter. Pure function. */
export function renderMarkdown(text) {
    let s = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    s = s.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
        return ('<pre class="chat-code-block" data-lang="' +
            (lang || "text") +
            '"><code>' +
            code +
            "</code></pre>");
    });
    s = s.replace(/`([^`]+)`/g, '<code class="chat-inline-code">$1</code>');
    s = s.replace(/^#### (.+)$/gm, '<div class="chat-h4">$1</div>');
    s = s.replace(/^### (.+)$/gm, '<div class="chat-h3">$1</div>');
    s = s.replace(/^## (.+)$/gm, '<div class="chat-h2">$1</div>');
    s = s.replace(/^# (.+)$/gm, '<div class="chat-h1">$1</div>');
    s = s.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
    s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/\*(.+?)\*/g, "<em>$1</em>");
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a class="chat-link" href="$2" target="_blank">$1</a>');
    s = s.replace(/^[\-\*] (.+)$/gm, '<div class="chat-list-item">$1</div>');
    s = s.replace(/^\d+\. (.+)$/gm, '<div class="chat-list-item chat-list-ordered">$1</div>');
    s = s.replace(/\n\n/g, "<br><br>");
    s = s.replace(/\n/g, "<br>");
    return s;
}
/** Truncate long strings with a "...N chars truncated" suffix. */
export function truncate(s, max) {
    if (!s)
        return "";
    if (s.length <= max)
        return s;
    return s.substring(0, max) + "\n... (" + (s.length - max) + " chars truncated)";
}
//# sourceMappingURL=agents-markdown.js.map