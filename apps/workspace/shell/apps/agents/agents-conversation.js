// ── ConversationManager ────────────────────────────────────────────
// Manages the full multi-process conversation for a session:
// connects to the execution-process stream to discover processes,
// loads historic process entries, streams running process entries,
// and combines everything into a single ordered conversation.
import { FULCAgentsStream } from "./agents-stream.js";
const Stream = FULCAgentsStream;
export function ConversationManager(sessionId, opts) {
    this.sessionId = sessionId;
    this.opts = opts || {};
    this._processes = {};
    this._processOrder = [];
    this._processStreamWs = null;
    this._streamControllers = {};
    this._destroyed = false;
    this._connectProcessStream();
}
const P = ConversationManager.prototype;
P._connectProcessStream = function () {
    const self = this;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const url = protocol +
        "//" +
        location.host +
        "/api/execution-processes/stream/session/ws?session_id=" +
        this.sessionId;
    try {
        this._processStreamWs = new WebSocket(url);
    }
    catch (e) {
        console.warn("[conversation] process stream connect error:", e);
        return;
    }
    this._processStreamWs.onmessage = (e) => {
        if (self._destroyed)
            return;
        try {
            const msg = JSON.parse(e.data);
            if (msg.JsonPatch)
                self._handleProcessPatches(msg.JsonPatch);
        }
        catch {
            /* ignore */
        }
    };
    this._processStreamWs.onerror = () => {
        console.warn("[conversation] process stream error");
    };
    this._processStreamWs.onclose = () => {
        self._processStreamWs = null;
    };
};
P._handleProcessPatches = function (patches) {
    for (let i = 0; i < patches.length; i++) {
        const p = patches[i];
        if ((p.op === "add" || p.op === "replace") && p.value) {
            const val = p.value;
            if (val.id && val.session_id) {
                this._onProcessDiscovered(val);
                continue;
            }
            // Map of processes (initial snapshot)
            if (typeof val === "object" && !val.id) {
                const procs = [];
                for (const key in val) {
                    const v = val[key];
                    if (Object.prototype.hasOwnProperty.call(val, key) && v && v.id) {
                        procs.push(v);
                    }
                }
                procs.sort((a, b) => new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime());
                for (let j = 0; j < procs.length; j++) {
                    this._onProcessDiscovered(procs[j]);
                }
            }
        }
    }
};
P._onProcessDiscovered = function (proc) {
    const existing = this._processes[proc.id];
    if (existing) {
        const prevStatus = existing.process.status;
        existing.process = proc;
        if (prevStatus === "running" && proc.status !== "running") {
            this._stopStreaming(proc.id);
            this._loadHistoricEntries(proc);
        }
        this._emit();
        if (this.opts.onProcessStatus) {
            this.opts.onProcessStatus(proc.id, proc.status);
        }
        return;
    }
    this._processes[proc.id] = {
        process: proc,
        entries: [],
        loaded: false,
        streaming: false,
    };
    this._processOrder.push(proc.id);
    if (proc.status === "running") {
        this._streamRunningEntries(proc);
    }
    else {
        this._loadHistoricEntries(proc);
    }
    if (this.opts.onProcessStatus) {
        this.opts.onProcessStatus(proc.id, proc.status);
    }
};
P._loadHistoricEntries = function (proc) {
    const self = this;
    const url = this._logsUrl(proc);
    Stream.loadAllEntries(url).then((entries) => {
        if (self._destroyed)
            return;
        const state = self._processes[proc.id];
        if (!state)
            return;
        state.entries = entries;
        state.loaded = true;
        self._emit();
    });
};
P._streamRunningEntries = function (proc) {
    const state = this._processes[proc.id];
    if (!state || state.streaming)
        return;
    state.streaming = true;
    this._streamWithBackoff(proc, 0);
};
P._streamWithBackoff = function (proc, attempt) {
    if (this._destroyed)
        return;
    if (attempt >= 20)
        return;
    const self = this;
    const url = this._logsUrl(proc);
    const ctrl = Stream.streamEntries(url, {
        onEntries(entries) {
            if (self._destroyed)
                return;
            const state = self._processes[proc.id];
            if (!state)
                return;
            state.entries = entries;
            self._emit();
        },
        onFinished(entries) {
            if (self._destroyed)
                return;
            const state = self._processes[proc.id];
            if (!state)
                return;
            state.entries = entries;
            state.loaded = true;
            state.streaming = false;
            delete self._streamControllers[proc.id];
            self._emit();
        },
        onError() {
            ctrl.close();
            delete self._streamControllers[proc.id];
            setTimeout(() => {
                self._streamWithBackoff(proc, attempt + 1);
            }, 500);
        },
    });
    this._streamControllers[proc.id] = ctrl;
};
P._stopStreaming = function (processId) {
    const ctrl = this._streamControllers[processId];
    if (ctrl) {
        ctrl.close();
        delete this._streamControllers[processId];
    }
    const state = this._processes[processId];
    if (state)
        state.streaming = false;
};
P._logsUrl = function (proc) {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const isScript = proc.executor_action &&
        proc.executor_action.typ &&
        proc.executor_action.typ.type === "ScriptRequest";
    const path = isScript
        ? "/api/execution-processes/" + proc.id + "/raw-logs/ws"
        : "/api/execution-processes/" + proc.id + "/normalized-logs/ws";
    return protocol + "//" + location.host + path;
};
P._emit = function () {
    if (this._destroyed)
        return;
    if (!this.opts.onEntries)
        return;
    const allEntries = [];
    let hasRunningProcess = false;
    let hasPendingApproval = false;
    let lastProcessFailedOrKilled = false;
    let latestTokenUsage = null;
    for (let i = 0; i < this._processOrder.length; i++) {
        const pid = this._processOrder[i];
        const state = this._processes[pid];
        if (!state)
            continue;
        const proc = state.process;
        const isLast = i === this._processOrder.length - 1;
        const isRunning = proc.status === "running";
        const isFailed = proc.status === "failed" || proc.status === "killed";
        const isScript = !!(proc.executor_action &&
            proc.executor_action.typ &&
            proc.executor_action.typ.type === "ScriptRequest");
        if (isRunning)
            hasRunningProcess = true;
        if (isFailed && isLast)
            lastProcessFailedOrKilled = true;
        // Add user message for coding agent processes
        if (!isScript && proc.executor_action && proc.executor_action.typ) {
            const actionType = proc.executor_action.typ.type;
            if (actionType === "CodingAgentInitialRequest" ||
                actionType === "CodingAgentFollowUpRequest" ||
                actionType === "ReviewRequest") {
                const prompt = proc.executor_action.typ.prompt || "";
                if (prompt) {
                    allEntries.push({
                        processId: pid,
                        index: "user",
                        processIndex: i,
                        entry: {
                            type: "NORMALIZED_ENTRY",
                            content: {
                                entry_type: { type: "user_message" },
                                content: prompt,
                                timestamp: proc.created_at,
                            },
                        },
                    });
                }
            }
        }
        for (let j = 0; j < state.entries.length; j++) {
            const entry = state.entries[j];
            if (!entry)
                continue;
            if (entry.type === "NORMALIZED_ENTRY" && entry.content && entry.content.entry_type) {
                const et = entry.content.entry_type;
                if (et.type === "user_message")
                    continue;
                if (et.type === "system_message" && i > 0)
                    continue;
                if (et.type === "token_usage_info") {
                    latestTokenUsage = et;
                    continue;
                }
                if (et.type === "tool_use" && et.status && et.status.status === "pending_approval") {
                    hasPendingApproval = true;
                }
            }
            allEntries.push({
                processId: pid,
                index: j,
                processIndex: i,
                entry,
            });
        }
        if (!isLast || !isRunning) {
            allEntries.push({
                processId: pid,
                index: "_boundary",
                processIndex: i,
                entry: {
                    type: "_PROCESS_BOUNDARY",
                    status: proc.status,
                    isScript,
                    processIndex: i,
                },
            });
        }
    }
    if (this._terminalHistory && this._terminalHistory.length > 0) {
        allEntries.push({
            processId: "terminal",
            index: "_boundary",
            processIndex: this._processOrder.length,
            entry: {
                type: "_PROCESS_BOUNDARY",
                status: "terminal",
                isScript: false,
                label: "Continued in Terminal",
            },
        });
        for (let th = 0; th < this._terminalHistory.length; th++) {
            allEntries.push({
                processId: "terminal",
                index: th,
                processIndex: this._processOrder.length,
                entry: this._terminalHistory[th],
            });
        }
    }
    this.opts.onEntries(allEntries, {
        hasRunningProcess,
        hasPendingApproval,
        lastProcessFailedOrKilled,
        latestTokenUsage,
        processCount: this._processOrder.length,
    });
    if (!hasRunningProcess && !this._terminalPollStarted) {
        this._startTerminalPoll();
    }
};
P._startTerminalPoll = function () {
    if (this._terminalPollStarted || this._destroyed)
        return;
    this._terminalPollStarted = true;
    this._terminalHistory = null;
    this._terminalLastCount = 0;
    this._pollTerminalHistory();
    const self = this;
    this._terminalPollTimer = setInterval(() => {
        if (self._destroyed) {
            if (self._terminalPollTimer)
                clearInterval(self._terminalPollTimer);
            return;
        }
        self._pollTerminalHistory();
    }, 5000);
};
P._pollTerminalHistory = function () {
    if (this._destroyed || this._terminalPollInFlight)
        return;
    this._terminalPollInFlight = true;
    const self = this;
    fetch("/api/sessions/" + this.sessionId + "/terminal-history")
        .then((r) => r.json())
        .then((json) => {
        self._terminalPollInFlight = false;
        const data = (json.data || json);
        if (data.continued_in_terminal && data.entries && data.entries.length > 0) {
            if (data.entries.length !== self._terminalLastCount) {
                self._terminalLastCount = data.entries.length;
                self._terminalHistory = data.entries;
                self._emit();
            }
        }
    })
        .catch(() => {
        self._terminalPollInFlight = false;
    });
};
ConversationManager.prototype.getRunningProcessId = function () {
    for (let i = this._processOrder.length - 1; i >= 0; i--) {
        const state = this._processes[this._processOrder[i]];
        if (state && state.process.status === "running") {
            return state.process.id;
        }
    }
    if (this._processOrder.length > 0) {
        return this._processOrder[this._processOrder.length - 1];
    }
    return null;
};
ConversationManager.prototype.destroy = function () {
    this._destroyed = true;
    if (this._terminalPollTimer) {
        clearInterval(this._terminalPollTimer);
        this._terminalPollTimer = null;
    }
    if (this._processStreamWs) {
        try {
            this._processStreamWs.close();
        }
        catch {
            /* ignore */
        }
        this._processStreamWs = null;
    }
    for (const pid in this._streamControllers) {
        try {
            this._streamControllers[pid].close();
        }
        catch {
            /* ignore */
        }
    }
    this._streamControllers = {};
    this._processes = {};
    this._processOrder = [];
};
export const FULCAgentsConversation = {
    ConversationManager: ConversationManager,
};
window.FULCAgentsConversation = FULCAgentsConversation;
const _transcriptRegistry = new Map();
export const AgentsTranscriptView = {
    /**
     * Called by ChatRenderer.setSession() to register the active session's
     * render handle. Unregistered automatically on session change.
     */
    register(sessionId, handle) {
        _transcriptRegistry.set(sessionId, handle);
    },
    unregister(sessionId) {
        _transcriptRegistry.delete(sessionId);
    },
    /** Returns the Set of entry_ids already rendered for a session. */
    renderedEntryIds(sessionId) {
        const h = _transcriptRegistry.get(sessionId);
        return h ? h.getRenderedIds() : new Set();
    },
    /**
     * Append a normalized entry to the transcript if it is not already rendered.
     * entry must be a NORMALIZED_ENTRY-shaped object with content.entry_type.
     */
    appendNormalizedEntry(sessionId, entry) {
        const h = _transcriptRegistry.get(sessionId);
        if (!h)
            return;
        h.appendEntry(entry);
    },
    /**
     * Reconcile a CRDT doc's message list against the currently rendered
     * transcript. Parses payload_json and appends any entries not yet shown.
     * Safe to call multiple times — entry_id dedupe prevents double-render.
     */
    syncFromDoc(sessionId, messages) {
        const rendered = this.renderedEntryIds(sessionId);
        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            if (!msg || !msg.entry_id)
                continue;
            if (rendered.has(msg.entry_id))
                continue;
            try {
                const content = JSON.parse(msg.payload_json);
                const entry = {
                    type: "NORMALIZED_ENTRY",
                    content,
                    _crdt_entry_id: msg.entry_id,
                };
                this.appendNormalizedEntry(sessionId, entry);
            }
            catch {
                // Malformed payload — skip silently
            }
        }
    },
};
// Expose globally for agents-crdt-bind.js (vanilla JS, no import)
window.AgentsTranscriptView =
    AgentsTranscriptView;
//# sourceMappingURL=agents-conversation.js.map