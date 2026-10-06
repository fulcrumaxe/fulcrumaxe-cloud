// ── fulcrumaxe-os Taskbar keyboard behaviour — WAI-ARIA toolbar (D#649 PR 1) ──────────
//
// WHAT THIS BUYS, and why it is not "add tabindex=0 to every icon".
//
// Making each dock icon focusable is one line and is the wrong fix. A dock with
// a dozen pinned apps then costs a dozen Tab presses to walk past, and a user
// reaching for the desktop behind it pays that toll every time. The WAI-ARIA
// toolbar pattern is the answer the spec already has for this: the container is
// ONE tab stop, and the arrow keys move a roving `tabindex` between the items
// inside it. Tab in, arrow along, Tab out — and no new global shortcut is
// needed, which is why PR 1 adds none (Ctrl+Alt+B is taken by browser-app.js
// and terminal-split.js anyway).
//
// Activation is deliberately NOT implemented here. The items are native
// `<button>` elements after D#649, so Enter and Space already fire `click`
// through the platform. Re-implementing that would mean two code paths for one
// behaviour and a second chance to get Space's scroll suppression wrong.
//
// ── The one design decision worth arguing about ──────────────────────────────
//
// The dock is not one DOM container. `#dock-pinned` and `#dock-open` are
// siblings with a divider between them, and there is no wrapper around the pair
// — adding one would move real flex children and risk the visual regression
// AC7 exists to catch. So a GROUP is the unit here: several containers share a
// single roving tabindex, which is what actually delivers "one tab stop for the
// dock" and lets the arrows cross from a pinned icon to an open-window icon
// without leaving the dock. Each container still carries its own `role="toolbar"`
// and its own label ("Pinned apps", "Open windows"), because that is what a
// screen-reader user is actually looking at, and two honestly-labelled toolbars
// read better than one mislabelled one.
//
// `attach()` is idempotent and is called again after every dock re-render —
// `taskbar.js` rebuilds both containers from scratch on each `update()`, so
// element identity does not survive and the roving stop is restored by INDEX,
// clamped to the new item count.

(function () {
  'use strict';

  /** group name -> { containers: [el], index: number } */
  var groups = Object.create(null);

  /** Containers already carrying our key handlers. Attach must be idempotent. */
  var wired = new WeakSet();

  function groupFor(name) {
    if (!groups[name]) groups[name] = { containers: [], index: 0 };
    return groups[name];
  }

  /**
   * Every item in the group, in DOM order across all of its containers.
   *
   * Containers are registered in the order `taskbar.js` calls `attach()`, which
   * is the order they appear in `index.html`, so concatenation IS DOM order and
   * no sort is needed. A container that has since been removed from the
   * document contributes nothing rather than throwing.
   */
  function itemsOf(group) {
    var out = [];
    for (var i = 0; i < group.containers.length; i++) {
      var c = group.containers[i];
      if (!c.el || !c.el.isConnected) continue;
      var found = c.el.querySelectorAll(c.itemSelector);
      for (var j = 0; j < found.length; j++) out.push(found[j]);
    }
    return out;
  }

  /**
   * Apply the roving tabindex: exactly one `0`, every other item `-1`.
   *
   * Exactly one is the whole contract. Zero means the group is unreachable by
   * Tab — the defect this file exists to fix, reintroduced. More than one means
   * the group is N tab stops again.
   */
  function applyRoving(group) {
    var items = itemsOf(group);
    if (!items.length) return items;
    if (group.index >= items.length) group.index = items.length - 1;
    if (group.index < 0) group.index = 0;
    for (var i = 0; i < items.length; i++) {
      items[i].tabIndex = i === group.index ? 0 : -1;
    }
    return items;
  }

  function focusIndex(group, next) {
    var items = itemsOf(group);
    if (!items.length) return;
    if (next < 0) next = 0;
    if (next >= items.length) next = items.length - 1;
    group.index = next;
    applyRoving(group);
    items[next].focus();
  }

  /**
   * Horizontal unless the taskbar is docked to a side.
   *
   * Read live rather than cached: `theme-layout.js` flips
   * `body[data-taskbar-position]` at runtime, and a cached orientation would
   * leave the arrows pointing along the wrong axis until the next reload.
   */
  function isVertical() {
    var pos = (document.body && document.body.dataset.taskbarPosition) || 'bottom';
    return pos === 'left' || pos === 'right';
  }

  function onKeydown(group, ev) {
    if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
    var vertical = isVertical();
    var forward = vertical ? 'ArrowDown' : 'ArrowRight';
    var back = vertical ? 'ArrowUp' : 'ArrowLeft';
    var items = itemsOf(group);
    if (!items.length) return;
    var at = items.indexOf(ev.target);
    if (at === -1) return;

    if (ev.key === forward) {
      focusIndex(group, at + 1 >= items.length ? 0 : at + 1);
    } else if (ev.key === back) {
      focusIndex(group, at - 1 < 0 ? items.length - 1 : at - 1);
    } else if (ev.key === 'Home') {
      focusIndex(group, 0);
    } else if (ev.key === 'End') {
      focusIndex(group, items.length - 1);
    } else {
      // Enter and Space fall through on purpose: these are native <button>
      // elements and the platform already activates them.
      return;
    }
    // Only reached when we handled the key. Arrows and Home/End scroll the
    // document otherwise, which moves the desktop out from under the user
    // while they are walking the dock.
    ev.preventDefault();
  }

  /**
   * Register one container as part of a roving-tabindex toolbar group.
   *
   * Idempotent: safe to call on every dock re-render, which is exactly how
   * `taskbar.js` calls it. Options:
   *   group         which roving group this container joins ('dock' | ...)
   *   label         the toolbar's accessible name
   *   itemSelector  what counts as an item inside this container
   */
  function attach(el, options) {
    if (!el) return;
    var opts = options || {};
    var name = opts.group || 'dock';
    var group = groupFor(name);

    var known = null;
    for (var i = 0; i < group.containers.length; i++) {
      if (group.containers[i].el === el) { known = group.containers[i]; break; }
    }
    if (!known) {
      known = { el: el, itemSelector: opts.itemSelector || '*' };
      group.containers.push(known);
    } else if (opts.itemSelector) {
      known.itemSelector = opts.itemSelector;
    }

    el.setAttribute('role', 'toolbar');
    el.setAttribute('aria-orientation', isVertical() ? 'vertical' : 'horizontal');
    if (opts.label) el.setAttribute('aria-label', opts.label);

    if (!wired.has(el)) {
      wired.add(el);
      el.addEventListener('keydown', function (ev) { onKeydown(group, ev); });
      // A pointer click moves focus to an item the roving stop is not on.
      // Without this the next Tab return would land somewhere the user did not
      // leave, and the arrows would jump from a stale index.
      el.addEventListener('focusin', function (ev) {
        var items = itemsOf(group);
        var at = items.indexOf(ev.target);
        if (at !== -1 && at !== group.index) {
          group.index = at;
          applyRoving(group);
        }
      });
    }

    applyRoving(group);
  }

  /** Re-apply the roving tabindex for every registered group. */
  function refresh() {
    for (var name in groups) applyRoving(groups[name]);
  }

  /** The current tab stop per group. Exposed for verification, not for logic. */
  function state() {
    var out = {};
    for (var name in groups) {
      var items = itemsOf(groups[name]);
      out[name] = {
        items: items.length,
        index: groups[name].index,
        tabStops: items.filter(function (el) { return el.tabIndex === 0; }).length,
      };
    }
    return out;
  }

  window.FULCTaskbarKeyboard = { attach: attach, refresh: refresh, state: state };
})();

export const FULCTaskbarKeyboard = window.FULCTaskbarKeyboard;
