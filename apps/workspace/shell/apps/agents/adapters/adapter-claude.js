// ── Claude Code Adapter ────────────────────────────────────────────
// Pure logic: parses Claude Code's JSONL protocol into universal
// AgentMessage entries. Handles streaming deltas, assistant blocks,
// tool-use/result pairs, approval requests, and final results.
import { FULCAdapterBase, BaseAdapter } from "./adapter-base.js";
const B = FULCAdapterBase;
export function ClaudeAdapter() {
    BaseAdapter.call(this);
    this._streamingText = "";
    this._currentToolId = null;
    this._seenStreamText = false;
}
ClaudeAdapter.prototype = Object.create(BaseAdapter.prototype);
ClaudeAdapter.prototype.constructor = ClaudeAdapter;
ClaudeAdapter.prototype.parseLine = function (line) {
    if (!line || !line.trim())
        return [];
    let parsed;
    try {
        parsed = JSON.parse(line);
    }
    catch {
        // Suppress truncated JSON fragments (contain keys like session_id, uuid, etc.)
        const lower = line.toLowerCase();
        if (lower.indexOf("session_id") !== -1 ||
            lower.indexOf("uuid") !== -1 ||
            lower.indexOf("parent_tool_use_id") !== -1 ||
            lower.indexOf("request_id") !== -1 ||
            line.charAt(0) === "{" ||
            line.charAt(line.length - 1) === "}") {
            return [];
        }
        // Plain text fallback for genuine agent text
        return [B.textMsg(B.Role.AGENT, line)];
    }
    return this._handleParsed(parsed);
};
ClaudeAdapter.prototype._handleParsed = function (parsed) {
    const type = parsed.type;
    let msgs = [];
    // Skip replay messages when we already have chat history
    if (parsed.isReplay && this.skipReplays) {
        return msgs;
    }
    // ── Stream events (real-time deltas) ──────────────────────────
    if (type === "stream_event" && parsed.event) {
        const evt = parsed.event;
        if (evt.type === "content_block_delta" && evt.delta) {
            const delta = evt.delta;
            if (delta.type === "text_delta" && delta.text) {
                this._streamingText += delta.text;
                this._seenStreamText = true;
                // Don't emit yet — accumulate until content_block_stop
            }
            return msgs;
        }
        if (evt.type === "content_block_start") {
            // New content block starting — could be text or tool_use
            const block = evt.content_block;
            if (block && block.type === "tool_use") {
                this._currentToolId = block.id || null;
                // Track tool IDs we've seen from streaming to avoid duplication
                if (!this._seenToolIds)
                    this._seenToolIds = {};
                if (this._currentToolId)
                    this._seenToolIds[this._currentToolId] = true;
            }
            return msgs;
        }
        if (evt.type === "content_block_stop") {
            // Flush accumulated streaming text
            if (this._streamingText) {
                msgs = msgs.concat(this._parseMarkdownBlocks(this._streamingText));
                this._streamingText = "";
            }
            this._currentToolId = null;
            return msgs;
        }
        // message_start, message_stop, message_delta — skip
        return msgs;
    }
    // ── Complete assistant message ────────────────────────────────
    if (type === "assistant" && parsed.message) {
        const message = parsed.message;
        if (message.content) {
            const content = message.content;
            for (let i = 0; i < content.length; i++) {
                const block = content[i];
                if (block.type === "tool_use") {
                    const blockId = block.id;
                    if (!this._seenToolIds || !blockId || !this._seenToolIds[blockId]) {
                        msgs.push(B.toolCall(block.name || "unknown", block.input || null, null, blockId || null));
                    }
                }
                // Skip text blocks — already emitted via streaming
            }
            this._seenStreamText = false;
            return msgs;
        }
    }
    // ── User message ─────────────────────────────────────────────
    if (type === "user" && parsed.message) {
        const message = parsed.message;
        let userText = "";
        const uc = message.content;
        if (typeof uc === "string") {
            userText = uc;
        }
        else if (Array.isArray(uc)) {
            const parts = [];
            for (let j = 0; j < uc.length; j++) {
                const p = uc[j];
                if (typeof p === "object" && p !== null && p.type === "text" && p.text)
                    parts.push(p.text);
                else if (typeof p === "string")
                    parts.push(p);
            }
            userText = parts.join("\n");
        }
        else if (typeof uc === "object" && uc !== null) {
            const tr = uc;
            if (tr.type === "tool_result") {
                let trOutput = "";
                if (typeof tr.content === "string") {
                    trOutput = tr.content;
                }
                else {
                    const tur = parsed.tool_use_result;
                    if (tur && tur.file) {
                        trOutput = tur.file.filePath + " (" + (tur.file.totalLines || "?") + " lines)";
                    }
                }
                if (tr.tool_use_id) {
                    msgs.push(B.makeMsg(B.MessageType.TOOL_CALL, B.Role.AGENT, {
                        name: null,
                        input: null,
                        output: trOutput || "(result)",
                        toolId: tr.tool_use_id,
                        isResult: true,
                    }));
                }
                return msgs;
            }
        }
        if (userText)
            msgs.push(B.userMsg(userText));
        return msgs;
    }
    // ── Tool result ──────────────────────────────────────────────
    if (type === "tool_result") {
        let output = "";
        if (parsed.content) {
            if (typeof parsed.content === "string") {
                output = parsed.content;
            }
            else if (Array.isArray(parsed.content)) {
                const textParts = [];
                for (let k = 0; k < parsed.content.length; k++) {
                    const piece = parsed.content[k];
                    if (piece && piece.type === "text" && piece.text)
                        textParts.push(piece.text);
                }
                output = textParts.join("\n");
            }
            else {
                output = JSON.stringify(parsed.content);
            }
        }
        const toolId = parsed.tool_use_id || null;
        if (toolId) {
            msgs.push(B.makeMsg(B.MessageType.TOOL_CALL, B.Role.AGENT, {
                name: null,
                input: null,
                output,
                toolId,
                isResult: true,
            }));
        }
        return msgs;
    }
    // ── Final result ─────────────────────────────────────────────
    if (type === "result") {
        const result = parsed.result;
        const isError = parsed.is_error;
        if (result && !isError) {
            msgs.push(B.textMsg(B.Role.AGENT, result));
        }
        if (isError) {
            msgs.push(B.errorMsg(result || "Agent error"));
        }
        const totalCost = parsed.total_cost_usd || 0;
        msgs.push(B.costUpdate(parsed.input_tokens || 0, parsed.output_tokens || 0, totalCost, parsed.num_turns || 0));
        msgs.push(B.systemMsg("Done — " + (parsed.num_turns || 0) + " turn(s), $" + totalCost.toFixed(4), "complete"));
        return msgs;
    }
    // ── System init ──────────────────────────────────────────────
    if (type === "system" && parsed.subtype === "init") {
        msgs.push(B.systemMsg("Agent initialized — " +
            (parsed.model || "unknown") +
            " in " +
            (parsed.cwd || ""), "init"));
        return msgs;
    }
    // ── Control requests (tool approval) ────────────────────────
    if (type === "control_request" && parsed.request) {
        const req = parsed.request;
        if (req.subtype === "can_use_tool" && req.tool_name) {
            let desc = "Agent wants to use: " + req.tool_name;
            if (req.input && req.input.file_path) {
                desc += " on " + req.input.file_path;
            }
            const approval = B.approvalRequest(desc, req.tool_use_id || null);
            approval.data._controlRequestId = parsed.request_id || null;
            approval.data._toolName = req.tool_name;
            approval.data._processId = null;
            msgs.push(approval);
        }
        return msgs;
    }
    // ── Filter out noise ─────────────────────────────────────────
    if (type === "rate_limit_event" || type === "control_response") {
        return msgs;
    }
    return msgs;
};
// Split text into text messages and code blocks
ClaudeAdapter.prototype._parseMarkdownBlocks = function (text) {
    const msgs = [];
    const codeRe = /```(\w*)\n([\s\S]*?)```/g;
    let lastIndex = 0;
    let match;
    while ((match = codeRe.exec(text)) !== null) {
        const before = text.slice(lastIndex, match.index).trim();
        if (before)
            msgs.push(B.textMsg(B.Role.AGENT, before));
        msgs.push(B.codeBlock(match[1] || "text", match[2], null));
        lastIndex = match.index + match[0].length;
    }
    const after = text.slice(lastIndex).trim();
    if (after)
        msgs.push(B.textMsg(B.Role.AGENT, after));
    return msgs;
};
ClaudeAdapter.prototype.flush = function () {
    let msgs = [];
    if (this._streamingText) {
        msgs = msgs.concat(this._parseMarkdownBlocks(this._streamingText));
        this._streamingText = "";
    }
    return msgs;
};
ClaudeAdapter.prototype.reset = function () {
    BaseAdapter.prototype.reset.call(this);
    this._streamingText = "";
    this._currentToolId = null;
    this._seenStreamText = false;
    this._seenToolIds = {};
};
// Register for all Claude Code executor IDs
B.registerAdapter("CLAUDE_CODE", ClaudeAdapter);
export const FULCAdapterClaude = {
    ClaudeAdapter: ClaudeAdapter,
};
window.FULCAdapterClaude = FULCAdapterClaude;
//# sourceMappingURL=adapter-claude.js.map