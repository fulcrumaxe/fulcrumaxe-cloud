// Typed wrappers around the baseapp proxy:
//   • request(method, path, body?)   → /api/baseapp/<id>/<path>
//   • openWS(path)                   → /api/ws/baseapp/<id>/<path>
//
// These match the proxy mounted by `crates/baseapp-runtime/src/proxy.rs` and
// the runtime host in epic-12 task 08. The proxy injects user/tenant headers
// server-side, so SDK consumers never touch auth.
import { requireAppId, debugLog } from "./internal.js";
/** Structured error thrown by `request()` for non-2xx responses. */
export class FULCBackendError extends Error {
    status;
    body;
    constructor(status, message, body) {
        super(message);
        this.name = "FULCBackendError";
        this.status = status;
        this.body = body;
    }
}
function joinPath(base, rest) {
    if (!rest)
        return base;
    if (rest.startsWith("/"))
        return base + rest;
    return base + "/" + rest;
}
function isJsonBody(body) {
    if (body === undefined || body === null)
        return false;
    if (typeof FormData !== "undefined" && body instanceof FormData)
        return false;
    if (typeof Blob !== "undefined" && body instanceof Blob)
        return false;
    if (typeof ArrayBuffer !== "undefined" && body instanceof ArrayBuffer)
        return false;
    if (ArrayBuffer.isView(body))
        return false;
    if (typeof body === "string")
        return false;
    return true;
}
/**
 * Issue an HTTP request to the running app's backend through the fulcrumaxe-os proxy.
 *
 * The path is automatically prefixed with `/api/baseapp/<this-app-id>/`. The
 * proxy injects `X-FULC-User` / `X-FULC-Tenant` server-side; you don't pass
 * any auth headers from JS.
 *
 * Bodies are JSON-encoded by default. Pass `{ raw: true }` to send `FormData`,
 * `Blob`, or raw bytes verbatim.
 *
 * Throws `FULCBackendError` on non-2xx responses (with parsed JSON body if the
 * server returned `Content-Type: application/json`, otherwise the response
 * text).
 */
export async function request(method, path, body, options = {}) {
    const appId = requireAppId(`backend.request("${method} ${path}")`);
    const url = joinPath(`/api/baseapp/${encodeURIComponent(appId)}`, path);
    const headers = {
        Accept: "application/json",
        ...(options.headers ?? {}),
    };
    let payload;
    if (body !== undefined && body !== null) {
        if (options.raw || !isJsonBody(body)) {
            payload = body;
        }
        else {
            payload = JSON.stringify(body);
            if (!("Content-Type" in headers || "content-type" in headers)) {
                headers["Content-Type"] = "application/json";
            }
        }
    }
    debugLog(`request ${method} ${url}`);
    let res;
    try {
        res = await fetch(url, {
            method,
            headers,
            body: payload,
            credentials: "same-origin",
            signal: options.signal,
        });
    }
    catch (err) {
        throw new FULCBackendError(0, `network error: ${err.message}`, null);
    }
    const ctype = res.headers.get("content-type") ?? "";
    let parsed = null;
    let text = "";
    if (res.status !== 204) {
        text = await res.text();
        if (text.length > 0 && ctype.includes("application/json")) {
            try {
                parsed = JSON.parse(text);
            }
            catch {
                parsed = text;
            }
        }
        else {
            parsed = text;
        }
    }
    if (!res.ok) {
        const message = typeof parsed === "object" && parsed !== null && "error" in parsed
            ? String(parsed.error)
            : typeof parsed === "string" && parsed.length > 0
                ? parsed
                : `HTTP ${res.status} ${res.statusText}`;
        throw new FULCBackendError(res.status, message, parsed);
    }
    return parsed;
}
function isEnvelope(x) {
    return (typeof x === "object" &&
        x !== null &&
        typeof x.type === "string");
}
/**
 * Open a WebSocket against `/api/ws/baseapp/<this-app-id>/<path>`.
 *
 * The default protocol is JSON envelopes `{ type, payload }`:
 *   ws.on("todoUpdated", (payload) => …)
 *   ws.send("subscribe", { topic: "todos" })
 *
 * Lifecycle events: `open`, `close`, `error`. Any incoming text frame that
 * isn't a recognisable envelope surfaces on `"message"` instead.
 */
export function openWS(path) {
    const appId = requireAppId(`backend.openWS("${path}")`);
    const proto = typeof location !== "undefined" && location.protocol === "https:" ? "wss:" : "ws:";
    const host = typeof location !== "undefined" ? location.host : "";
    const url = `${proto}//${host}${joinPath(`/api/ws/baseapp/${encodeURIComponent(appId)}`, path)}`;
    debugLog(`openWS ${url}`);
    const sock = new WebSocket(url);
    const listeners = new Map();
    function emit(event, ...args) {
        const set = listeners.get(event);
        if (!set)
            return;
        for (const fn of Array.from(set)) {
            try {
                fn(...args);
            }
            catch (err) {
                console.error(`fulcrumaxe-os WS listener for "${event}" threw:`, err);
            }
        }
    }
    sock.addEventListener("open", () => emit("open"));
    sock.addEventListener("error", (e) => emit("error", e));
    sock.addEventListener("close", (e) => emit("close", { code: e.code, reason: e.reason }));
    sock.addEventListener("message", (e) => {
        emit("message", e);
        if (typeof e.data !== "string")
            return;
        try {
            const parsed = JSON.parse(e.data);
            if (isEnvelope(parsed)) {
                emit(parsed.type, parsed.payload);
            }
        }
        catch {
            // Non-JSON text frames only surface on `"message"`.
        }
    });
    const handle = {
        on(event, listener) {
            let set = listeners.get(event);
            if (!set) {
                set = new Set();
                listeners.set(event, set);
            }
            set.add(listener);
        },
        off(event, listener) {
            listeners.get(event)?.delete(listener);
        },
        send(eventOrRaw, payload) {
            if (sock.readyState !== WebSocket.OPEN) {
                debugLog(`send dropped — socket not open (state=${sock.readyState})`);
                return;
            }
            if (typeof eventOrRaw === "string" && payload === undefined) {
                sock.send(eventOrRaw);
            }
            else if (typeof eventOrRaw === "string") {
                sock.send(JSON.stringify({ type: eventOrRaw, payload }));
            }
            else {
                sock.send(eventOrRaw);
            }
        },
        close(code, reason) {
            try {
                sock.close(code, reason);
            }
            catch {
                // Already closing — ignore.
            }
        },
        get isOpen() {
            return sock.readyState === WebSocket.OPEN;
        },
    };
    return handle;
}
//# sourceMappingURL=backend.js.map