// ── AgentOutputViewer ──────────────────────────────────────────────
// Raw-log viewer: streams /raw-logs/ws, parses Claude Code JSONL
// protocol, renders stdout/stderr/system lines. Separate from
// ChatRenderer which shows the normalized conversation.
const MAX_LINES = 10000;
export function AgentOutputViewer(container) {
    this.container = container;
    this.ws = null;
    this.lines = [];
    this.autoScroll = true;
    this.showTimestamps = false;
    this.processId = null;
    this.sessionId = null;
    this.executorProfileId = null;
    this.onFollowUp = null;
    this._build();
}
const OVP = AgentOutputViewer.prototype;
OVP._build = function () {
    this.container.innerHTML = "";
    this.container.className = "agent-output";
    const toolbar = document.createElement("div");
    toolbar.className = "agent-output-toolbar";
    const tsBtn = document.createElement("button");
    tsBtn.className = "agent-btn agent-btn-sm";
    tsBtn.textContent = "Timestamps";
    tsBtn.title = "Toggle timestamps";
    const self = this;
    tsBtn.onclick = () => {
        self.showTimestamps = !self.showTimestamps;
        tsBtn.classList.toggle("active", self.showTimestamps);
        self._renderLines();
    };
    const copyBtn = document.createElement("button");
    copyBtn.className = "agent-btn agent-btn-sm";
    copyBtn.textContent = "Copy";
    copyBtn.onclick = () => {
        const text = self.lines.map((l) => l.text).join("\n");
        navigator.clipboard.writeText(text).then(() => {
            if (window.FULCToast)
                window.FULCToast.show("Output copied", "info");
        });
    };
    const clearBtn = document.createElement("button");
    clearBtn.className = "agent-btn agent-btn-sm";
    clearBtn.textContent = "Clear";
    clearBtn.onclick = () => {
        self.lines = [];
        self._renderLines();
    };
    toolbar.appendChild(tsBtn);
    toolbar.appendChild(copyBtn);
    toolbar.appendChild(clearBtn);
    this.container.appendChild(toolbar);
    this.outputEl = document.createElement("div");
    this.outputEl.className = "agent-output-content";
    this.outputEl.addEventListener("scroll", () => {
        const el = self.outputEl;
        self.autoScroll = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
    });
    this.container.appendChild(this.outputEl);
    const followUpBar = document.createElement("div");
    followUpBar.className = "agents-follow-up-bar";
    this.followUpInput = document.createElement("input");
    this.followUpInput.type = "text";
    this.followUpInput.className = "agents-follow-up-input";
    this.followUpInput.placeholder = "Send follow-up message...";
    this.followUpInput.onkeydown = (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            self._sendFollowUp();
        }
    };
    const sendBtn = document.createElement("button");
    sendBtn.className = "agent-btn agent-btn-primary";
    sendBtn.textContent = "Send";
    sendBtn.onclick = () => {
        self._sendFollowUp();
    };
    followUpBar.appendChild(this.followUpInput);
    followUpBar.appendChild(sendBtn);
    this.container.appendChild(followUpBar);
};
OVP._sendFollowUp = function () {
    const msg = this.followUpInput.value.trim();
    if (!msg || !this.sessionId)
        return;
    const self = this;
    const profileId = this.executorProfileId || { executor: "CLAUDE_CODE", variant: null };
    this.followUpInput.value = "";
    this._addLine("system", "[Sending: " + msg + "]");
    fetch("/api/sessions/" + this.sessionId + "/follow-up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            prompt: msg,
            executor_profile_id: profileId,
            retry_process_id: null,
            force_when_dirty: null,
            perform_git_reset: null,
        }),
    })
        .then((r) => r.json())
        .then((json) => {
        if (json.success === false) {
            self._addLine("stderr", "[Follow-up failed: " + (json.message || "Unknown error") + "]");
            return fetch("/api/sessions/" + self.sessionId + "/queue", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ message: msg, executor_profile_id: profileId }),
            })
                .then((r2) => r2.json())
                .then((json2) => {
                if (json2.success !== false) {
                    self._addLine("system", "[Message queued]");
                }
                else {
                    self._addLine("stderr", "[Queue failed: " + (json2.message || "Unknown error") + "]");
                }
            });
        }
        const proc = json.data;
        if (proc && proc.id) {
            self._addLine("system", "[New process started: " + proc.id.substring(0, 8) + "]");
            self.connect(proc.id);
            if (self.onFollowUp)
                self.onFollowUp(proc);
        }
    })
        .catch((err) => {
        self._addLine("stderr", "[Error: " + err.message + "]");
    });
};
OVP.setSession = function (sessionId, executorProfileId) {
    this.sessionId = sessionId;
    this.executorProfileId = executorProfileId;
};
OVP.connect = function (processId) {
    this.disconnect();
    this.processId = processId;
    this.lines = [];
    this._renderLines();
    if (!processId)
        return;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const url = protocol + "//" + location.host + "/api/execution-processes/" + processId + "/raw-logs/ws";
    const self = this;
    try {
        this.ws = new WebSocket(url);
    }
    catch (e) {
        this._addLine("stderr", "[Connection error: " + e.message + "]");
        return;
    }
    this.ws.onopen = () => {
        self._addLine("system", "[Connected to agent output stream]");
    };
    this.ws.onmessage = (e) => {
        const raw = e.data;
        if (typeof raw !== "string") {
            self._addLine("stdout", "[binary data]");
            return;
        }
        try {
            const msg = JSON.parse(raw);
            self._handleMessage(msg);
        }
        catch {
            self._addLine("stdout", raw);
        }
    };
    this.ws.onerror = () => {
        self._addLine("stderr", "[WebSocket error]");
    };
    this.ws.onclose = (e) => {
        self._addLine("system", "[Stream closed" + (e.code !== 1000 ? " (code " + e.code + ")" : "") + "]");
        self.ws = null;
    };
};
OVP._handleMessage = function (msg) {
    if (msg.finished) {
        this._addLine("system", "[Agent finished]");
        return;
    }
    if (msg.Ready) {
        return;
    }
    if (msg.JsonPatch) {
        const patches = msg.JsonPatch;
        for (let i = 0; i < patches.length; i++) {
            const p = patches[i];
            if (p.op === "add" && p.value != null) {
                const val = p.value;
                if (val.type === "STDERR") {
                    this._addLine("stderr", val.content || "");
                }
                else if (val.type === "STDOUT") {
                    this._handleStdoutContent(val.content || "");
                }
                else if (typeof val === "string") {
                    this._handleStdoutLine(val);
                }
            }
        }
        return;
    }
    if (typeof msg === "string") {
        this._handleStdoutLine(msg);
        return;
    }
    this._addLine("system", JSON.stringify(msg));
};
OVP._handleStdoutContent = function (content) {
    this._handleStdoutLine(content);
};
OVP._handleStdoutLine = function (line) {
    if (!line || !line.trim())
        return;
    let parsed;
    try {
        parsed = JSON.parse(line);
    }
    catch {
        this._addLine("stdout", line);
        return;
    }
    const type = parsed.type;
    if (type === "stream_event" && parsed.event) {
        const evt = parsed.event;
        if (evt.type === "content_block_delta" && evt.delta && evt.delta.text) {
            this._appendText(evt.delta.text);
            return;
        }
        if (evt.type === "content_block_start")
            return;
        if (evt.type === "content_block_stop") {
            this._flushPending();
            return;
        }
        if (evt.type === "message_start" || evt.type === "message_stop" || evt.type === "message_delta")
            return;
        return;
    }
    if (type === "assistant" && parsed.message) {
        const message = parsed.message;
        if (message.content) {
            for (let i = 0; i < message.content.length; i++) {
                if (message.content[i].type === "tool_use") {
                    this._addLine("system", "[Tool: " + (message.content[i].name || "unknown") + "]");
                }
            }
        }
        return;
    }
    if (type === "user" && parsed.message) {
        const message = parsed.message;
        const userContent = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
        this._addLine("system", "[User] " + userContent);
        return;
    }
    if (type === "result") {
        if (parsed.result) {
            this._addLine("stdout", parsed.result);
        }
        if (parsed.is_error) {
            this._addLine("stderr", "[Agent error]");
        }
        const totalCost = parsed.total_cost_usd || 0;
        this._addLine("system", "[Done — " + (parsed.num_turns || 0) + " turn(s), $" + totalCost.toFixed(4) + "]");
        return;
    }
    if (type === "system" && parsed.subtype === "init") {
        this._addLine("system", "[Agent initialized — " +
            (parsed.model || "unknown") +
            " in " +
            (parsed.cwd || "") +
            "]");
        return;
    }
    if (type === "rate_limit_event")
        return;
    if (type === "control_request" || type === "control_response")
        return;
    if (type === "tool_result") {
        if (parsed.content) {
            this._addLine("stdout", typeof parsed.content === "string" ? parsed.content : JSON.stringify(parsed.content));
        }
        return;
    }
};
OVP._appendText = function (text) {
    if (!this._pendingText)
        this._pendingText = "";
    this._pendingText += text;
    const lines = this._pendingText.split("\n");
    for (let i = 0; i < lines.length - 1; i++) {
        if (lines[i])
            this._addLine("stdout", lines[i]);
    }
    this._pendingText = lines[lines.length - 1];
};
OVP._flushPending = function () {
    if (this._pendingText) {
        this._addLine("stdout", this._pendingText);
        this._pendingText = "";
    }
};
OVP._addLine = function (type, text) {
    this.lines.push({ type, text, time: new Date() });
    if (this.lines.length > MAX_LINES) {
        this.lines = this.lines.slice(this.lines.length - MAX_LINES);
    }
    this._appendLine(this.lines[this.lines.length - 1]);
    if (this.autoScroll) {
        this.outputEl.scrollTop = this.outputEl.scrollHeight;
    }
};
OVP._appendLine = function (line) {
    const el = document.createElement("div");
    el.className = "agent-output-line agent-output-" + line.type;
    let text = "";
    if (this.showTimestamps) {
        text = "[" + line.time.toLocaleTimeString() + "] ";
    }
    text += line.text;
    el.textContent = text;
    this.outputEl.appendChild(el);
};
OVP._renderLines = function () {
    this.outputEl.innerHTML = "";
    for (let i = 0; i < this.lines.length; i++) {
        this._appendLine(this.lines[i]);
    }
    if (this.autoScroll) {
        this.outputEl.scrollTop = this.outputEl.scrollHeight;
    }
};
OVP.disconnect = function () {
    if (this.ws) {
        try {
            this.ws.close();
        }
        catch {
            /* ignore */
        }
        this.ws = null;
    }
    this.processId = null;
};
OVP.destroy = function () {
    this.disconnect();
    this.container.innerHTML = "";
};
export const FULCAgentsOutput = {
    AgentOutputViewer: AgentOutputViewer,
};
window.FULCAgentsOutput = FULCAgentsOutput;
//# sourceMappingURL=agents-output.js.map