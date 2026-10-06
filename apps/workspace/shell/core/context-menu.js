// ── fulcrumaxe-os Context Menu System ─────────────────────────────────────────
// Reusable right-click context menu. Consumers: `import { FULCContextMenu }
// from "./context-menu.js"` then call `.show(mouseEvent, items)` / `.hide()`.
const _api = {};
(function () {
  'use strict';

  let menuEl = null;
  let subMenuEl = null;
  // The root-menu item whose submenu is currently open, so ArrowLeft can put
  // focus back on it rather than on whatever was focused before.
  let subMenuParentEl = null;
  // Where focus was when the menu opened. A menu that takes focus and never
  // gives it back strands a keyboard user on <body> after Escape.
  let returnFocusEl = null;
  // The hover timer that will open a submenu. hide() has to cancel it: a menu
  // closed inside the 200ms hover delay (Escape, an outside click) otherwise
  // gets an orphan submenu built for it afterwards, floating over the page.
  let subTimer = null;
  // The event that opened the menu. It may still be dispatching when the
  // document listeners go on, and must not dismiss the menu it just opened.
  let openingEvent = null;

  function show(event, items) {
    event.preventDefault();
    event.stopPropagation();
    hide();

    menuEl = buildMenu(items);
    document.body.appendChild(menuEl);

    // Position: prefer below-right of cursor, flip if near edges
    let x = event.clientX;
    let y = event.clientY;
    const menuRect = menuEl.getBoundingClientRect();
    if (x + menuRect.width > window.innerWidth) x = window.innerWidth - menuRect.width - 4;
    if (y + menuRect.height > window.innerHeight) y = window.innerHeight - menuRect.height - 4;
    if (x < 0) x = 4;
    if (y < 0) y = 4;
    menuEl.style.left = x + 'px';
    menuEl.style.top = y + 'px';

    // Focus the menu container, not the first item: a right-click with the
    // mouse should not paint a focus ring on an item nobody chose. The
    // container carries tabindex="-1" so it is programmatically focusable
    // without joining the tab order, and arrow keys move focus onto the items
    // from there. This is what makes the menu operable by keyboard at all — it
    // is appended to <body> at the end of the document, so without an explicit
    // focus move Tab would only reach it after every other control on the page.
    returnFocusEl = document.activeElement;
    menuEl.focus({ preventScroll: true });

    // Attached now, not on a timer. A setTimeout(0) here left a window in
    // which an Escape (or an outside click) arrived before the listeners
    // existed and was dropped, so the menu stayed open over the page. The
    // timer was only there to keep the event that opened the menu from
    // dismissing it, which openingEvent now does.
    openingEvent = event;
    document.addEventListener('click', onClickOutside);
    document.addEventListener('contextmenu', onRightClickOutside);
    document.addEventListener('keydown', onKeyDown);
  }

  function hide() {
    clearTimeout(subTimer);
    subTimer = null;
    const hadFocus = !!(menuEl && menuEl.contains(document.activeElement)) ||
      !!(subMenuEl && subMenuEl.contains(document.activeElement));
    if (menuEl) { menuEl.remove(); menuEl = null; }
    if (subMenuEl) { subMenuEl.remove(); subMenuEl = null; }
    subMenuParentEl = null;
    openingEvent = null;
    document.removeEventListener('click', onClickOutside);
    document.removeEventListener('contextmenu', onRightClickOutside);
    document.removeEventListener('keydown', onKeyDown);
    // Only when the menu actually held focus. Clicking elsewhere on the page
    // also hides the menu, and yanking focus back to the old element then would
    // fight the click the user just made.
    if (hadFocus && returnFocusEl && returnFocusEl.isConnected) {
      returnFocusEl.focus({ preventScroll: true });
    }
    returnFocusEl = null;
  }

  function onClickOutside(e) {
    if (e === openingEvent) return;
    if (menuEl && menuEl.contains(e.target)) return;
    if (subMenuEl && subMenuEl.contains(e.target)) return;
    hide();
  }

  function onRightClickOutside(e) {
    if (e === openingEvent) return;
    if (menuEl && menuEl.contains(e.target)) return;
    if (subMenuEl && subMenuEl.contains(e.target)) return;
    hide();
  }

  // The menu the arrow keys act on: the submenu while focus is inside it, the
  // root menu otherwise.
  //
  // This used to be `menuEl` unconditionally, and that was a real defect rather
  // than a tidiness point: after ArrowRight stepped into a submenu, ArrowDown
  // re-read the ROOT menu's items and yanked focus back to the parent. Every
  // submenu item carries tabIndex=-1, so items 2..N of any submenu were
  // unreachable by keyboard — only the first, which showSubmenu focuses
  // directly, could ever be activated. `window-manager.js:204` and
  // `desktop.js:765` both build multi-item submenus.
  function activeMenu() {
    if (subMenuEl && subMenuEl.contains(document.activeElement)) return subMenuEl;
    return menuEl;
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') { hide(); return; }
    if (!menuEl) return;

    const menu = activeMenu();
    const items = menu.querySelectorAll('.fulc-ctx-item:not(.disabled)');
    if (!items.length) return;

    // Derived from focus rather than carried in a variable. A stored index has
    // to be kept in sync across two menus and a mouse that moves focus on its
    // own; the DOM already knows the answer. -1 means focus is on the menu
    // container itself, which is where `show()` puts it.
    const idx = Array.prototype.indexOf.call(items, document.activeElement);

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      highlightItem(items, (idx + 1) % items.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      // From -1 this lands on the LAST item, which is what ArrowUp from a
      // freshly opened menu should do.
      highlightItem(items, (idx - 1 + items.length) % items.length);
    } else if (e.key === 'ArrowRight' && idx >= 0 && menu === menuEl) {
      // Open a submenu and step into it. Without this a submenu is mouse-only:
      // it is built on `mouseenter` and nothing else used to open it.
      if (items[idx].dataset.hasSubmenu === 'true') {
        e.preventDefault();
        items[idx].click();
      }
    } else if (e.key === 'ArrowLeft' && subMenuEl) {
      e.preventDefault();
      const parent = subMenuParentEl;
      subMenuEl.remove();
      subMenuEl = null;
      subMenuParentEl = null;
      // Back to the item that owns the submenu, not to wherever the root
      // index happened to be.
      if (parent && parent.isConnected) {
        const rootItems = menuEl.querySelectorAll('.fulc-ctx-item:not(.disabled)');
        highlightItem(rootItems, Array.prototype.indexOf.call(rootItems, parent));
      }
    }
    // Enter and Space are deliberately NOT handled here any more. Each item is
    // a native <button> that now actually holds focus, so the browser fires
    // `click` for both — synthesising a second one would run the action twice.
  }

  function highlightItem(items, idx) {
    // Cleared across BOTH menus: leaving `.kb-active` painted on a root item
    // while focus sits in the submenu shows two highlighted rows at once.
    if (menuEl) menuEl.querySelectorAll('.kb-active').forEach(function (el) { el.classList.remove('kb-active'); });
    if (subMenuEl) subMenuEl.querySelectorAll('.kb-active').forEach(function (el) { el.classList.remove('kb-active'); });
    if (idx >= 0 && idx < items.length) {
      items[idx].classList.add('kb-active');
      // Real focus, not just a class. The class is what a mouse hover paints;
      // focus is what makes Enter and Space reach the item at all.
      items[idx].focus({ preventScroll: true });
    }
  }

  function buildMenu(items) {
    const menu = document.createElement('div');
    menu.className = 'fulc-context-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Context menu');
    menu.tabIndex = -1;

    items.forEach(function (item) {
      if (item.divider) {
        const div = document.createElement('div');
        div.className = 'fulc-ctx-divider';
        menu.appendChild(div);
        return;
      }

      // Native <button>, not a <div>: focusability, Enter/Space activation and
      // the announced role all come with the tag (D#649 — the same choice PR 1
      // made for the dock and PR 2 for the desktop icons). `role=menuitem` on
      // top of it, so it is announced as part of this menu rather than as a
      // loose button. Roving tabindex: the menu is one stop, not N.
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'fulc-ctx-item';
      el.setAttribute('role', 'menuitem');
      el.tabIndex = -1;
      if (item.danger) el.classList.add('danger');
      if (item.disabled) {
        el.classList.add('disabled');
        // aria-disabled rather than the `disabled` attribute: `disabled` pulls
        // in a second UA style block, and `.fulc-ctx-item.disabled` already
        // sets `pointer-events: none` for the mouse.
        el.setAttribute('aria-disabled', 'true');
      }

      const labelSpan = document.createElement('span');
      labelSpan.textContent = item.label;
      el.appendChild(labelSpan);

      if (item.shortcut) {
        const hint = document.createElement('span');
        hint.className = 'shortcut-hint';
        hint.textContent = item.shortcut;
        el.appendChild(hint);
      }

      if (item.submenu) {
        el.dataset.hasSubmenu = 'true';
        el.setAttribute('aria-haspopup', 'menu');
        const arrow = document.createElement('span');
        arrow.className = 'submenu-arrow';
        arrow.textContent = '\u25B6';
        el.appendChild(arrow);

        // Open on activation too, so Enter, Space and ArrowRight all reach a
        // submenu that was previously openable only by hovering. Additive for
        // the mouse: hover still opens it, and clicking a parent used to do
        // nothing at all.
        el.addEventListener('click', function (ev) {
          ev.stopPropagation();
          showSubmenu(el, item.submenu);
          const subItems = subMenuEl.querySelectorAll('.fulc-ctx-item:not(.disabled)');
          if (subItems.length) subItems[0].focus({ preventScroll: true });
        });

        el.addEventListener('mouseenter', function () {
          clearTimeout(subTimer);
          subTimer = setTimeout(function () {
            // A click or ArrowRight already opened this parent's submenu, and
            // focus is inside it. Rebuilding it here would replace the element
            // under the user and drop that focus.
            if (subMenuEl && subMenuParentEl === el) return;
            showSubmenu(el, item.submenu);
          }, 200);
        });
        el.addEventListener('mouseleave', function () {
          clearTimeout(subTimer);
          setTimeout(function () {
            if (subMenuEl && !subMenuEl.matches(':hover')) {
              subMenuEl.remove();
              subMenuEl = null;
            }
          }, 100);
        });
      } else if (!item.disabled) {
        el.addEventListener('click', function (e) {
          e.stopPropagation();
          hide();
          if (item.action) item.action();
        });
      }

      menu.appendChild(el);
    });

    return menu;
  }

  function showSubmenu(parentEl, items) {
    if (subMenuEl) { subMenuEl.remove(); subMenuEl = null; }

    subMenuParentEl = parentEl;
    subMenuEl = buildMenu(items);
    subMenuEl.setAttribute('aria-label', 'Submenu');
    document.body.appendChild(subMenuEl);

    const parentRect = parentEl.getBoundingClientRect();
    let x = parentRect.right + 2;
    let y = parentRect.top;

    const subRect = subMenuEl.getBoundingClientRect();
    if (x + subRect.width > window.innerWidth) x = parentRect.left - subRect.width - 2;
    // On a narrow viewport flipping left can leave the submenu off-screen too.
    x = Math.max(4, Math.min(x, window.innerWidth - subRect.width - 4));
    if (y + subRect.height > window.innerHeight) y = window.innerHeight - subRect.height - 4;
    if (y < 0) y = 4;

    subMenuEl.style.left = x + 'px';
    subMenuEl.style.top = y + 'px';
  }

  _api.show = show;
  _api.hide = hide;
})();

export const FULCContextMenu = _api;
