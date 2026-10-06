// ── fulcrumaxe-os Notifications (epic-16 task 01) ────────────────────────────────────
//
// One stackable, non-blocking toast system for the whole desktop.
//
// This is a *unification*, not a greenfield feature. Before this module fulcrumaxe-os
// had, by actual count, five different behaviours for "show the user a short
// message":
//
//   | implementation                      | position      | stacking          | default |
//   |-------------------------------------|---------------|-------------------|---------|
//   | `FULCModals.toast` (26 call sites)  | bottom-centre | none — *replaces* | 2000 ms |
//   | `fm-bridge.js showToast`            | bottom-centre | unbounded append  | 2000 ms |
//   | `fm-archive.js showToast(m, isErr)` | bottom-centre | unbounded append  | 4000 ms |
//   | `fm-batch-rename.js showUndoToast`  | bottom-centre | unbounded append  | 5000 ms |
//   | `terminal-notify.ts` cards          | top-right     | stacks, max 5     | 5000 ms |
//
// The `FULCModals.toast` row is the user-visible bug that motivates the whole
// task: it calls `document.querySelector('.fulc-toast')?.remove()` on every
// call, so two messages in quick succession means the first is silently
// destroyed before it can be read. Every one of those 26 call sites is a
// place a user can lose a message.
//
// ## Migrating onto this module
//
// `notify()` deliberately accepts the shapes callers already use, so a
// migration is a one-line delegation rather than a rewrite:
//
//   notify('Saved')                       → info toast, default duration
//   notify('Saved', 3000)                 → `FULCModals.toast(msg, duration)`
//   notify('Extract failed', true)        → `showToast(msg, isError)`
//   notify('Gone wrong', 'error')         → explicit severity
//   notify({ title, body, severity, duration, actions })  → full surface
//
// ## Deliberately NOT folded in
//
// - `core/update-notification.js` — the epic-34 update *banner*
//   (`window.FULCUpdateNotification`). A persistent chrome widget, not a
//   transient message. Untouched.
// - `terminal-notify.ts` — mostly unread-count/tab-badge/watch-mode plumbing
//   that happens to render a card. Its toast is the small half of it.
// - `entitlement-manager`'s `deps.toast` — despite the name it routes to
//   `window.fulcAlert`, a *blocking* modal. Moving it to a toast is a real UX
//   change that wants its own review.
//
// ## Leak discipline
//
// Every listener this module creates is attached either to a toast element
// (and so is collected with the node) or is the single document-level
// `keydown` handler, which is installed when the stack becomes non-empty and
// removed when it drains. Timers are cleared in `_destroy`. `_live` never
// retains a detached node: `_destroy` is the only removal path and it splices
// the entry out before dropping the element.
/** Default auto-dismiss per severity. `error` is 0 — sticky until dismissed. */
const DEFAULT_DURATION = {
    info: 3000,
    success: 3000,
    warning: 5000,
    error: 0,
};
const ICON = {
    info: 'i',
    success: '✓',
    warning: '!',
    error: '×',
};
/** Toasts on screen at once. The oldest is evicted when a new one exceeds it. */
const MAX_VISIBLE = 5;
/** Notification history retained in memory. */
const MAX_HISTORY = 50;
/** Fallback in case `transitionend` never fires (reduced motion, hidden tab). */
const LEAVE_TIMEOUT_MS = 400;
const SEVERITIES = ['info', 'success', 'warning', 'error'];
let idCounter = 0;
function nextId() {
    idCounter += 1;
    return 'jn-' + idCounter;
}
function normalizeSeverity(value) {
    return SEVERITIES.indexOf(value) >= 0
        ? value
        : 'info';
}
/**
 * Fold the accepted call shapes into one options object. See the module
 * header for the shapes and why they exist.
 */
function toOptions(input, shorthand) {
    if (typeof input !== 'string')
        return input ?? {};
    const opts = { title: input };
    if (typeof shorthand === 'number')
        opts.duration = shorthand;
    else if (typeof shorthand === 'boolean')
        opts.severity = shorthand ? 'error' : 'info';
    else if (typeof shorthand === 'string')
        opts.severity = normalizeSeverity(shorthand);
    return opts;
}
class NotificationCenter {
    _container = null;
    /** Live toasts, oldest first — index 0 is the eviction victim. */
    _live = [];
    _history = [];
    _keydownBound = null;
    // ── Public API ────────────────────────────────────────────────────────
    notify(input, shorthand) {
        const opts = toOptions(input, shorthand);
        const severity = normalizeSeverity(opts.severity);
        const title = opts.title == null ? '' : String(opts.title);
        const body = opts.body == null ? '' : String(opts.body);
        const duration = typeof opts.duration === 'number' && isFinite(opts.duration) && opts.duration >= 0
            ? opts.duration
            : DEFAULT_DURATION[severity];
        const id = nextId();
        this._record({ id, title, body, severity, timestamp: Date.now() });
        // Evict before inserting so the stack never momentarily exceeds the cap.
        while (this._live.length >= MAX_VISIBLE)
            this._dismissEntry(this._live[0]);
        const entry = this._build(id, title, body, severity, duration, opts.actions);
        this._container_().appendChild(entry.el);
        this._live.push(entry);
        this._bindKeydown();
        // Next frame, so the browser has painted the off-screen start state and
        // the transition to `.is-visible` actually animates.
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => entry.el.classList.add('is-visible'));
        }
        else {
            entry.el.classList.add('is-visible');
        }
        if (duration > 0)
            this._resumeTimer(entry, duration);
        return id;
    }
    info(title, body, opts) {
        return this.notify({ ...opts, title, body, severity: 'info' });
    }
    success(title, body, opts) {
        return this.notify({ ...opts, title, body, severity: 'success' });
    }
    warning(title, body, opts) {
        return this.notify({ ...opts, title, body, severity: 'warning' });
    }
    error(title, body, opts) {
        return this.notify({ ...opts, title, body, severity: 'error' });
    }
    /** Dismiss one toast by id. No-op if it is gone or already leaving. */
    dismiss(id) {
        for (const entry of this._live) {
            if (entry.id === id) {
                this._dismissEntry(entry);
                return;
            }
        }
    }
    dismissAll() {
        for (const entry of this._live.slice())
            this._dismissEntry(entry);
    }
    /** Number of toasts currently on screen (including ones animating out). */
    count() {
        return this._live.length;
    }
    /** Newest first, capped at {@link MAX_HISTORY}. Returns a copy. */
    history() {
        return this._history.slice();
    }
    clearHistory() {
        this._history.length = 0;
    }
    // ── Internals ─────────────────────────────────────────────────────────
    _record(rec) {
        this._history.unshift(rec);
        if (this._history.length > MAX_HISTORY)
            this._history.length = MAX_HISTORY;
    }
    _container_() {
        let el = this._container;
        if (el && el.isConnected)
            return el;
        el = document.getElementById('fulc-notifications');
        if (!el) {
            el = document.createElement('div');
            el.id = 'fulc-notifications';
            el.className = 'fulc-notifications';
            document.body.appendChild(el);
        }
        this._container = el;
        return el;
    }
    _build(id, title, body, severity, duration, actions) {
        const el = document.createElement('div');
        el.className = 'fulc-toast fulc-toast--' + severity;
        el.dataset.notifyId = id;
        el.dataset.severity = severity;
        // Errors and warnings interrupt; info/success wait for a pause. Set on the
        // toast itself rather than the container so each message gets its own
        // politeness rather than the container's.
        const urgent = severity === 'error' || severity === 'warning';
        el.setAttribute('role', urgent ? 'alert' : 'status');
        el.setAttribute('aria-live', urgent ? 'assertive' : 'polite');
        const icon = document.createElement('div');
        icon.className = 'fulc-toast__icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = ICON[severity];
        el.appendChild(icon);
        const content = document.createElement('div');
        content.className = 'fulc-toast__content';
        if (title) {
            const t = document.createElement('div');
            t.className = 'fulc-toast__title';
            t.textContent = title;
            content.appendChild(t);
        }
        if (body) {
            const b = document.createElement('div');
            b.className = 'fulc-toast__body';
            b.textContent = body;
            content.appendChild(b);
        }
        if (actions && actions.length) {
            const row = document.createElement('div');
            row.className = 'fulc-toast__actions';
            for (const action of actions) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'fulc-toast__action';
                btn.textContent = action.label;
                btn.addEventListener('click', (ev) => {
                    // Without this the click also hits the dismiss-on-click handler on
                    // the toast body, so an action with `dismiss: false` would still
                    // close the toast.
                    ev.stopPropagation();
                    try {
                        action.onClick?.(id);
                    }
                    catch (err) {
                        console.error('[notify] action handler threw', err);
                    }
                    if (action.dismiss !== false)
                        this.dismiss(id);
                });
                row.appendChild(btn);
            }
            content.appendChild(row);
        }
        el.appendChild(content);
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'fulc-toast__close';
        close.setAttribute('aria-label', 'Dismiss notification');
        close.textContent = '×';
        close.addEventListener('click', (ev) => {
            ev.stopPropagation();
            this.dismiss(id);
        });
        el.appendChild(close);
        if (duration > 0) {
            const progress = document.createElement('div');
            progress.className = 'fulc-toast__progress';
            const bar = document.createElement('div');
            bar.className = 'fulc-toast__progress-bar';
            // The bar and the dismissal timer are two clocks. They are kept in sync
            // by pausing both off the same `.is-paused` class / `_pauseTimer` pair,
            // and by giving the CSS animation exactly `duration`.
            bar.style.animationDuration = duration + 'ms';
            progress.appendChild(bar);
            el.appendChild(progress);
        }
        const entry = {
            id,
            el,
            duration,
            remaining: duration,
            deadline: 0,
            timer: null,
            leaveTimer: null,
            paused: false,
            dismissing: false,
        };
        el.addEventListener('click', () => this.dismiss(id));
        // `focusin`/`focusout` as well as pointer events, so a keyboard user
        // tabbing to the action button gets the same reprieve as a mouse hover.
        el.addEventListener('mouseenter', () => this._pauseTimer(entry));
        el.addEventListener('mouseleave', () => this._resumeTimer(entry));
        el.addEventListener('focusin', () => this._pauseTimer(entry));
        el.addEventListener('focusout', () => this._resumeTimer(entry));
        return entry;
    }
    _pauseTimer(entry) {
        if (entry.duration <= 0 || entry.paused || entry.dismissing)
            return;
        entry.paused = true;
        if (entry.timer !== null) {
            clearTimeout(entry.timer);
            entry.timer = null;
        }
        entry.remaining = Math.max(0, entry.deadline - Date.now());
        entry.el.classList.add('is-paused');
    }
    _resumeTimer(entry, initial) {
        if (entry.duration <= 0 || entry.dismissing)
            return;
        if (initial === undefined && !entry.paused)
            return;
        entry.paused = false;
        entry.el.classList.remove('is-paused');
        const ms = initial !== undefined ? initial : entry.remaining;
        entry.deadline = Date.now() + ms;
        if (entry.timer !== null)
            clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
            entry.timer = null;
            this._dismissEntry(entry);
        }, ms);
    }
    _dismissEntry(entry) {
        if (entry.dismissing)
            return;
        entry.dismissing = true;
        if (entry.timer !== null) {
            clearTimeout(entry.timer);
            entry.timer = null;
        }
        // Drop it from the live stack immediately: an entry animating out must
        // not be eligible for eviction, Escape, or a second dismiss.
        const idx = this._live.indexOf(entry);
        if (idx >= 0)
            this._live.splice(idx, 1);
        entry.el.classList.remove('is-visible');
        entry.el.classList.add('is-leaving');
        const finish = () => {
            if (entry.leaveTimer !== null) {
                clearTimeout(entry.leaveTimer);
                entry.leaveTimer = null;
            }
            entry.el.removeEventListener('transitionend', finish);
            entry.el.remove();
            this._unbindKeydownIfIdle();
        };
        entry.el.addEventListener('transitionend', finish);
        // `transitionend` does not fire for a zero-duration transition, which is
        // exactly what `prefers-reduced-motion` and a backgrounded tab produce —
        // without this fallback those nodes would stay in the DOM forever.
        entry.leaveTimer = setTimeout(finish, LEAVE_TIMEOUT_MS);
    }
    // ── Escape-to-dismiss ─────────────────────────────────────────────────
    _bindKeydown() {
        if (this._keydownBound)
            return;
        this._keydownBound = (ev) => {
            if (ev.key !== 'Escape' || this._live.length === 0)
                return;
            // A fulcrumaxe-os modal owns Escape while it is open — dismissing a toast
            // underneath it would eat the keystroke the user meant for the dialog.
            // See `core/modals.js`.
            if (document.querySelector('.fulc-modal-overlay:not(.hidden)'))
                return;
            // Newest first (LIFO): the top of the stack is the message the user is
            // most likely reacting to. Not `preventDefault`ed — other Escape
            // handlers still see the key.
            this._dismissEntry(this._live[this._live.length - 1]);
        };
        document.addEventListener('keydown', this._keydownBound);
    }
    _unbindKeydownIfIdle() {
        if (this._live.length > 0 || !this._keydownBound)
            return;
        document.removeEventListener('keydown', this._keydownBound);
        this._keydownBound = null;
    }
}
/** The desktop-wide singleton. Also published as `window.FULCNotify`. */
export const FULCNotify = new NotificationCenter();
if (typeof window !== 'undefined') {
    window.FULCNotify = FULCNotify;
    // Event form, for callers that would rather not reach for the global (and
    // for anything running before this module's import graph is available).
    // `detail` takes exactly the same shapes as `notify()`.
    window.addEventListener('fulc-notify', (ev) => {
        const detail = ev.detail;
        if (detail)
            FULCNotify.notify(detail);
    });
}
//# sourceMappingURL=notifications.js.map