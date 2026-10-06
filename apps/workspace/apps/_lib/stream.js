// D#37 WS-F2b: the per-run stream client. It reads /api/v1/runs/{id}/events with
// the shell's openStream (which owns the SSE parser) and backs off with its
// backoffDelay; the tab-hidden close comes from the shell's onHidden hook, not a
// timer here. The resume point is the last seq, in this closure only. One run
// stream per tab: opening another closes the first.
import live, { HEALTHY_MS, backoffDelay, openStream } from "../../core/cloud-live.js";

const WAKE = ["pointerdown", "keydown", "focus"];
let current = null;

/** onEvent(dto) gets each new run event (seq above the last seen), onEnd(status) the terminal frame. env = test seams. */
export function openRunStream(runId, { lastSeq = 0, onEvent, onEnd, env = {} } = {}) {
  if (current) current.close();
  const lv = env.live || live;
  const doFetch = env.fetch || ((...a) => lv.apiFetch(...a));
  const win = env.win || globalThis.window;
  const now = env.now || Date.now;
  let ctl = null, timer = null, seq = lastSeq, failures = 0, closed = false, idle = false, hidden = false;
  if (typeof lv.visible === "function" && !lv.visible()) hidden = true; // opened into a tab already told hidden: wait for onHidden(false)

  function stopStream() {
    clearTimeout(timer);
    if (ctl) { const c = ctl; ctl = null; c.close(); }
  }
  function close() {
    closed = true;
    stopStream();
    offHidden();
    for (const ev of WAKE) win.removeEventListener(ev, wake);
    if (current === handle) current = null;
  }
  function onFrame(f) {
    if (closed) return;
    if (f.event === "revoked") { close(); return void lv.confirmSession("revoked"); } // the shell's D4 path decides
    if (f.event === "idle") { idle = true; failures = 0; return void stopStream(); }
    if (f.event === "error") return void (ctl && ctl.close()); // the attempt ends: connect() backs off
    let dto = null;
    try { dto = JSON.parse(f.data); } catch { /* not a frame */ }
    if (f.event === "end") {
      close();
      if (onEnd) onEnd(dto && typeof dto.status === "string" ? dto.status : "");
    } else if (f.event === "run_event" && dto && Number.isSafeInteger(dto.seq) && dto.seq > seq) {
      seq = dto.seq;
      if (onEvent) onEvent(dto);
    }
  }
  async function connect() {
    if (closed || ctl || idle || hidden) return;
    const startedAt = now();
    const mine = openStream(doFetch, { url: "/api/v1/runs/" + encodeURIComponent(runId) + "/events", lastId: seq > 0 ? String(seq) : "", onFrame });
    ctl = mine;
    const res = await mine.done;
    if (ctl !== mine) return; // closed, idled or replaced meanwhile
    ctl = null;
    if (closed || idle || hidden) return;
    failures = res.opened && now() - startedAt >= HEALTHY_MS ? 0 : failures + 1; // a 429 or an instant close backs off
    timer = setTimeout(connect, backoffDelay(failures, (env.random || Math.random)()));
  }
  function wake() { // idle: reopen on input or focus (a visible tab comes back through onHidden(false))
    if (closed || !idle) return;
    idle = false;
    connect();
  }
  const offHidden = lv.onHidden((isHidden) => {
    if (closed) return;
    hidden = isHidden;
    if (isHidden) return void stopStream();
    idle = false;
    failures = 0;
    connect();
  });
  for (const ev of WAKE) win.addEventListener(ev, wake, { passive: true });
  const handle = { close };
  current = handle;
  connect();
  return handle;
}
