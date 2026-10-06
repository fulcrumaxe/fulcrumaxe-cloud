// ── fulcrumaxe-os System Tray ─────────────────────────────────────────────────
// Windows-style system tray with icons for wifi, volume, battery, power.
// Only active when FULC_MODE=local.
import { FULCTaskbar } from "./taskbar.js";

export const FULCSystemTray = {};
(function () {
  'use strict';

  var trayEl = null;
  var mode = null;
  var statusData = {};
  var pollTimer = null;
  var powerMenuVisible = false;

  function detectMode() {
    return fetch('/api/mode')
      .then(function (r) { return r.json(); })
      .then(function (d) { return d.mode; })
      .catch(function () { return null; });
  }

  function init() {
    detectMode().then(function (m) {
      mode = m;
      if (mode !== 'local') return;

      var tray = document.getElementById('taskbar-tray');
      if (!tray) return;

      trayEl = document.createElement('span');
      trayEl.id = 'system-tray-indicators';
      trayEl.className = 'system-tray';
      tray.insertBefore(trayEl, tray.firstChild);

      refreshStatus().then(function () { render(); });

      pollTimer = setInterval(function () {
        refreshStatus().then(function () { render(); });
      }, 10000);
    });
  }

  function refreshStatus() {
    return fetch('/api/system/status')
      .then(function (r) { return r.json(); })
      .then(function (d) { statusData = d; })
      .catch(function () { statusData = {}; });
  }

  // ── Icons ──────────────────────────────────────────────────────────

  function wifiIcon(connected, signal) {
    if (!connected) return '\u25CB'; // ○ empty circle
    if (signal >= 75) return '\u25D6'; // ◖ full
    if (signal >= 50) return '\u25D1'; // ◑ half
    return '\u25D4'; // ◔ quarter
  }

  function volIcon(level, muted) {
    if (muted) return '\u2573'; // ╳
    if (level >= 66) return '\u266B'; // ♫
    if (level >= 33) return '\u266A'; // ♪
    if (level > 0) return '\u2022'; // •
    return '\u2573'; // ╳
  }

  function batIcon(capacity, charging) {
    if (charging) return '\u26A1'; // ⚡
    if (capacity >= 80) return '\u2588'; // █
    if (capacity >= 60) return '\u2586'; // ▆
    if (capacity >= 40) return '\u2584'; // ▄
    if (capacity >= 20) return '\u2582'; // ▂
    return '\u2581'; // ▁
  }

  // ── Render ─────────────────────────────────────────────────────────

  function makeIndicator(tag, className, attrs, children) {
    var el = document.createElement(tag);
    el.className = className;
    Object.keys(attrs || {}).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    children.forEach(function (c) { el.appendChild(c); });
    return el;
  }

  function makeIconSpan(className, text, ariaHidden) {
    var span = document.createElement('span');
    span.className = className;
    if (ariaHidden) span.setAttribute('aria-hidden', 'true');
    span.textContent = text;
    return span;
  }

  function render() {
    if (!trayEl) return;

    var children = [];

    // WiFi — only show if a wifi device exists (connected or has ssid)
    if (statusData.wifi && statusData.wifi.hasDevice !== false) {
      var wConn = statusData.wifi.connected;
      var wSsid = statusData.wifi.ssid || '';
      if (wConn || wSsid) {
        var wTip = wConn ? wSsid : 'Not connected';
        // Native <button>, not a <span>: focusability, Enter/Space activation
        // and the announced role all come with the tag (D#649, same choice PR 1
        // made for the dock). The icon is decorative — the accessible name is
        // the aria-label, because a signal-bar glyph reads as nothing useful.
        children.push(makeIndicator('button', 'st-indicator st-wifi', {
          type: 'button',
          title: wTip,
          'aria-label': 'WiFi: ' + wTip,
          'aria-haspopup': 'dialog',
          'aria-expanded': 'false'
        }, [makeIconSpan('st-icon', wifiIcon(wConn, 100), true)]));
      }
    }

    // Volume
    if (statusData.volume !== null && statusData.volume !== undefined) {
      var vl = statusData.volume;
      var vm = statusData.muted;
      children.push(makeIndicator('button', 'st-indicator st-volume', {
        type: 'button',
        title: vm ? 'Muted' : vl + '%',
        'aria-label': 'Volume: ' + (vm ? 'muted' : vl + ' percent'),
        'aria-haspopup': 'dialog',
        'aria-expanded': 'false'
      }, [
        makeIconSpan('st-icon', volIcon(vl, vm), true),
        makeIconSpan('st-label', vm ? 'Mute' : vl + '%', false)
      ]));
    }

    // Battery
    if (statusData.battery) {
      var bat = statusData.battery;
      var bCap = bat.capacity != null ? bat.capacity : 100;
      var bChg = bat.charging;
      children.push(makeIndicator('span', 'st-indicator st-battery', {
        title: 'Battery: ' + bCap + '%' + (bChg ? ' (charging)' : '')
      }, [
        makeIconSpan('st-icon', batIcon(bCap, bChg), false),
        makeIconSpan('st-label', bCap + '%', false)
      ]));
    }

    // Power
    children.push(makeIndicator('button', 'st-indicator st-power', {
      type: 'button',
      title: 'Power',
      'aria-label': 'Power menu',
      'aria-haspopup': 'menu',
      'aria-expanded': 'false'
    }, [makeIconSpan('st-icon', '\u23FB', true)])); // ⏻ power symbol

    trayEl.replaceChildren.apply(trayEl, children);

    // Wire up click events
    var wifiBtn = trayEl.querySelector('.st-wifi');
    if (wifiBtn) wifiBtn.addEventListener('click', showWifiPopup);

    var volBtn = trayEl.querySelector('.st-volume');
    if (volBtn) volBtn.addEventListener('click', showVolumePopup);

    var pwrBtn = trayEl.querySelector('.st-power');
    if (pwrBtn) pwrBtn.addEventListener('click', showPowerMenu);
  }

  // ── Popups ─────────────────────────────────────────────────────────

  // The indicator whose popup is open, so Escape and outside-click can hand
  // focus back to it. A keyboard user who opens a popup and cannot close it is
  // no better off than one who could never open it.
  var popupAnchor = null;
  var popupEscHandler = null;
  var popupClickHandler = null;
  // Bumped on every open. The outside-click handler is registered from a
  // setTimeout, and a popup closed before that timer fires must not leave one
  // behind — see the comment in createPopup.
  var popupGeneration = 0;

  function removePopup(restoreFocus) {
    var existing = document.querySelector('.st-popup');
    if (existing) existing.remove();
    powerMenuVisible = false;
    popupGeneration++;
    if (popupEscHandler) {
      document.removeEventListener('keydown', popupEscHandler, true);
      popupEscHandler = null;
    }
    // Unregister the outside-click dismisser HERE rather than only from inside
    // itself. It used to remove itself only when an outside click actually
    // fired, so any other route out of the popup (Escape, choosing an item,
    // opening a different indicator) left it attached — and the next open then
    // closed itself, because the activating click bubbled to a stale handler
    // whose captured `popup`/`anchorEl` both belonged to the previous popup.
    if (popupClickHandler) {
      document.removeEventListener('click', popupClickHandler);
      popupClickHandler = null;
    }
    if (popupAnchor) {
      popupAnchor.setAttribute('aria-expanded', 'false');
      // Only on an explicit dismissal. A re-render replaces the anchor node, so
      // pulling focus back unconditionally would steal it on every 10s poll.
      if (restoreFocus && popupAnchor.isConnected) popupAnchor.focus();
      popupAnchor = null;
    }
  }

  function createPopup(anchorEl) {
    removePopup();
    var popup = document.createElement('div');
    popup.className = 'st-popup';

    var rect = anchorEl.getBoundingClientRect();
    popup.style.position = 'fixed';
    popup.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
    popup.style.right = (window.innerWidth - rect.right) + 'px';

    document.body.appendChild(popup);

    popupAnchor = anchorEl;
    anchorEl.setAttribute('aria-expanded', 'true');

    // Capture phase, so the popup closes even when a control inside it has
    // focus and stops the event on its way up.
    popupEscHandler = function (ev) {
      if (ev.key === 'Escape') { ev.stopPropagation(); removePopup(true); }
    };
    document.addEventListener('keydown', popupEscHandler, true);

    // Deferred by a tick so the click that opened this popup does not
    // immediately close it. `gen` guards the case where the popup is gone
    // before the tick lands — without it the handler would attach with nothing
    // to dismiss and removePopup() would never see it to clean up.
    var gen = ++popupGeneration;
    setTimeout(function () {
      if (gen !== popupGeneration) return;
      popupClickHandler = function (e) {
        if (!popup.contains(e.target) && !anchorEl.contains(e.target)) removePopup(false);
      };
      document.addEventListener('click', popupClickHandler);
    }, 0);

    return popup;
  }

  // Move focus into a popup once its contents exist. Called after the DOM
  // that builds them, not from createPopup — the wifi list arrives from a fetch.
  function focusFirstControl(popup) {
    var first = popup.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (first) first.focus();
  }

  function showVolumePopup(e) {
    var popup = createPopup(e.currentTarget);
    var vol = statusData.volume || 50;

    var title = document.createElement('div');
    title.className = 'st-popup-title';
    title.textContent = 'VOLUME';

    var volIconSpan = document.createElement('span');
    volIconSpan.className = 'st-vol-icon';
    volIconSpan.textContent = volIcon(vol, statusData.muted);

    var slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.value = String(vol);
    slider.className = 'st-slider';
    slider.id = 'st-vol-slider';

    var volLabel = document.createElement('span');
    volLabel.className = 'st-vol-label';
    volLabel.id = 'st-vol-label';
    volLabel.textContent = vol + '%';

    var volRow = document.createElement('div');
    volRow.className = 'st-vol-row';
    volRow.append(volIconSpan, slider, volLabel);

    var muteBtn = document.createElement('button');
    muteBtn.className = 'st-popup-btn';
    muteBtn.id = 'st-mute-btn';
    muteBtn.textContent = statusData.muted ? 'UNMUTE' : 'MUTE';

    popup.replaceChildren(title, volRow, muteBtn);

    popup.querySelector('#st-vol-slider').addEventListener('input', function () {
      var level = this.value;
      popup.querySelector('#st-vol-label').textContent = level + '%';
      fetch('/api/system/volume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level: parseInt(level) })
      });
      statusData.volume = parseInt(level);
    });

    popup.querySelector('#st-mute-btn').addEventListener('click', function () {
      fetch('/api/system/volume/mute', { method: 'POST' });
      statusData.muted = !statusData.muted;
      // render() rebuilds the tray, so the anchor this popup was opened from is
      // gone; removePopup() skips the focus restore for a disconnected anchor
      // and the new indicator is re-focused here instead.
      render();
      removePopup(false);
      var vb = trayEl && trayEl.querySelector('.st-volume');
      if (vb) vb.focus();
    });

    focusFirstControl(popup);
  }

  function makeTitleDiv(text) {
    var el = document.createElement('div');
    el.className = 'st-popup-title';
    el.textContent = text;
    return el;
  }

  function showWifiPopup(e) {
    var popup = createPopup(e.currentTarget);
    var loading = document.createElement('div');
    loading.className = 'st-loading';
    loading.textContent = 'SCANNING...';
    popup.replaceChildren(makeTitleDiv('WIFI NETWORKS'), loading);

    fetch('/api/system/wifi/list')
      .then(function (r) { return r.json(); })
      .then(function (networks) {
        var children = [makeTitleDiv('WIFI NETWORKS')];
        if (networks.length === 0) {
          var empty = document.createElement('div');
          empty.className = 'st-empty';
          empty.textContent = 'NO NETWORKS FOUND';
          children.push(empty);
        } else {
          for (var i = 0; i < networks.length; i++) {
            var n = networks[i];
            var item = document.createElement('button');
            item.type = 'button';
            item.className = 'st-wifi-item' + (n.active ? ' st-wifi-active' : '');
            item.dataset.ssid = n.ssid;
            item.setAttribute('aria-label', n.ssid + ', signal ' + n.signal + ' percent, ' + n.security + (n.active ? ', connected' : ''));

            var bars = document.createElement('span');
            bars.className = 'st-wifi-bars';
            bars.setAttribute('aria-hidden', 'true');
            bars.textContent = wifiIcon(true, n.signal);

            var nameSpan = document.createElement('span');
            nameSpan.className = 'st-wifi-name';
            // Untrusted value (Wi-Fi SSID) reaches the DOM only through
            // textContent -- never through markup concatenation.
            nameSpan.textContent = n.ssid;

            var signalSpan = document.createElement('span');
            signalSpan.className = 'st-wifi-signal';
            signalSpan.textContent = n.signal + '%';

            var securitySpan = document.createElement('span');
            securitySpan.className = 'st-wifi-security';
            securitySpan.textContent = n.security;

            item.append(bars, nameSpan, signalSpan, securitySpan);
            children.push(item);
          }
        }
        popup.replaceChildren.apply(popup, children);
        focusFirstControl(popup);

        var items = popup.querySelectorAll('.st-wifi-item');
        for (var j = 0; j < items.length; j++) {
          items[j].addEventListener('click', function () {
            var ssid = this.dataset.ssid;
            var security = this.querySelector('.st-wifi-security').textContent;
            var password = null;
            if (security && security !== 'Open' && security !== '--') {
              password = prompt('PASSWORD FOR ' + ssid + ':');
              if (password === null) return;
            }
            var connecting = document.createElement('span');
            connecting.textContent = 'CONNECTING...';
            this.replaceChildren(connecting);
            fetch('/api/system/wifi/connect', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ssid: ssid, password: password })
            }).then(function () {
              refreshStatus().then(function () { render(); });
              removePopup(false);
              var wb = trayEl && trayEl.querySelector('.st-wifi');
              if (wb) wb.focus();
            });
          });
        }
      })
      .catch(function () {
        var empty = document.createElement('div');
        empty.className = 'st-empty';
        empty.textContent = 'UNAVAILABLE';
        popup.replaceChildren(makeTitleDiv('WIFI'), empty);
      });
  }

  function makeActionBtn(className, action, text) {
    var btn = document.createElement('button');
    btn.className = className;
    btn.dataset.action = action;
    btn.textContent = text;
    return btn;
  }

  function showPowerMenu(e) {
    if (powerMenuVisible) { removePopup(true); return; }
    powerMenuVisible = true;

    var popup = createPopup(e.currentTarget);
    popup.replaceChildren(
      makeTitleDiv('POWER'),
      makeActionBtn('st-popup-btn', 'new-window', '\u29C9 New Window'),
      makeActionBtn('st-popup-btn', 'feedback', '\u2709 Send Feedback'),
      document.createElement('div'),
      makeActionBtn('st-popup-btn', 'lock', '\uD83D\uDD12 Lock Screen'),
      makeActionBtn('st-popup-btn', 'logout', '\uD83D\uDEAA Log Out'),
      document.createElement('div'),
      makeActionBtn('st-popup-btn st-danger', 'restart', '\u21BB Restart'),
      makeActionBtn('st-popup-btn st-danger', 'shutdown', '\u23FB Shut Down')
    );
    popup.children[3].className = 'st-popup-divider';
    popup.children[6].className = 'st-popup-divider';

    var btns = popup.querySelectorAll('[data-action]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function () {
        var action = this.dataset.action;
        if (action === 'new-window') {
          window.open(location.origin, '_blank',
            'width=' + (screen.width || 1280) + ',height=' + (screen.height || 800));
          removePopup(true);
          return;
        }
        if (action === 'feedback') {
          // D#901. The Feedback app registers FULCFeedback; fall back to a plain open.
          if (window.FULCFeedback) window.FULCFeedback.open('bug');
          else if (window.FULCWM) window.FULCWM.open('feedback');
          removePopup(true);
          return;
        }
        if (action === 'restart' || action === 'shutdown') {
          var confirmed = confirm(action.toUpperCase() + ' THE SYSTEM?');
          if (!confirmed) return;
        }
        fetch('/api/system/power', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: action })
        });
        removePopup(true);
      });
    }

    focusFirstControl(popup);
  }

  // Initialize after desktop loads
  if (FULCTaskbar) {
    var originalInit = FULCTaskbar.init;
    FULCTaskbar.init = function () {
      if (originalInit) originalInit.call(this);
      init();
    };
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }

  Object.assign(FULCSystemTray, { init: init, refreshStatus: refreshStatus });
})();
