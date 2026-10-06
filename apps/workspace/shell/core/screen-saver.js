// D#37 WS-C2 fix round item 3 (W2, CWE-359): persisted under
// storage-ns.js's fx:<ns>: namespace, not a raw localStorage key.
import { getItem, setItem } from "./storage-ns.js";

export const FULCScreenSaver = {};
(function () {
  'use strict';

  const IDLE_TIMEOUT_KEY = 'fulc-screensaver-timeout';
  const DEFAULT_TIMEOUT = 0; // 0 = disabled, value in minutes

  let overlay = null;
  let canvas = null;
  let ctx = null;
  let animFrame = null;
  let active = false;
  let idleTimer = null;
  let columns = [];
  let drops = [];

  function getIdleTimeout() {
    try {
      var val = parseInt(getItem(IDLE_TIMEOUT_KEY), 10);
      return isNaN(val) ? DEFAULT_TIMEOUT : val;
    } catch (e) { return DEFAULT_TIMEOUT; }
  }

  function setIdleTimeout(minutes) {
    setItem(IDLE_TIMEOUT_KEY, String(minutes));
    resetIdleTimer();
  }

  function resetIdleTimer() {
    clearTimeout(idleTimer);
    var timeout = getIdleTimeout();
    if (timeout > 0 && !active) {
      idleTimer = setTimeout(function () {
        start();
      }, timeout * 60 * 1000);
    }
  }

  function start() {
    if (active) return;
    active = true;

    overlay = document.createElement('div');
    overlay.className = 'screensaver-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:90000;cursor:none;background:#000;';

    canvas = document.createElement('canvas');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    overlay.appendChild(canvas);
    document.body.appendChild(overlay);

    ctx = canvas.getContext('2d');

    // Matrix rain setup
    var fontSize = 14;
    var colCount = Math.floor(canvas.width / fontSize);
    columns = [];
    drops = [];
    for (var i = 0; i < colCount; i++) {
      columns.push(i);
      drops.push(Math.random() * -100);
    }

    // Get theme color
    var themeColor = getComputedStyle(document.body).getPropertyValue('--theme-primary').trim() || '#1aff80';

    function draw() {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.05)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.fillStyle = themeColor;
      ctx.font = fontSize + 'px monospace';

      for (var i = 0; i < columns.length; i++) {
        // Random katakana-like characters + ASCII
        var charCode = Math.random() > 0.5
          ? Math.floor(Math.random() * 94) + 33           // ASCII printable
          : Math.floor(Math.random() * 96) + 0x30A0;      // Katakana
        var text = String.fromCharCode(charCode);

        var x = i * fontSize;
        var y = drops[i] * fontSize;

        ctx.fillText(text, x, y);

        if (y > canvas.height && Math.random() > 0.975) {
          drops[i] = 0;
        }
        drops[i]++;
      }

      animFrame = requestAnimationFrame(draw);
    }

    draw();

    // Add a clock overlay in the center
    var clockEl = document.createElement('div');
    clockEl.className = 'screensaver-clock';
    clockEl.style.cssText =
      'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);' +
      'font-family:"Courier New",Courier,monospace;font-size:4rem;' +
      'color:' + themeColor + ';opacity:0.4;letter-spacing:8px;pointer-events:none;' +
      'text-shadow:0 0 20px ' + themeColor + ';';
    overlay.appendChild(clockEl);

    var clockInterval = setInterval(function () {
      if (!active) { clearInterval(clockInterval); return; }
      var tz = (window.userPreferences && window.userPreferences.timezone) || 'UTC';
      try {
        clockEl.textContent = new Date().toLocaleTimeString('en-US', {
          timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
        });
      } catch (e) {
        clockEl.textContent = new Date().toLocaleTimeString('en-US', {
          hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
        });
      }
    }, 1000);

    // Dismiss on any input — use a slight delay so the triggering event doesn't immediately dismiss
    setTimeout(function () {
      document.addEventListener('mousemove', dismissHandler);
      document.addEventListener('mousedown', dismissHandler);
      document.addEventListener('keydown', dismissHandler);
    }, 500);
  }

  function dismissHandler() {
    stop();
  }

  function stop() {
    if (!active) return;
    active = false;

    cancelAnimationFrame(animFrame);
    document.removeEventListener('mousemove', dismissHandler);
    document.removeEventListener('mousedown', dismissHandler);
    document.removeEventListener('keydown', dismissHandler);

    if (overlay) {
      overlay.remove();
      overlay = null;
    }
    canvas = null;
    ctx = null;

    resetIdleTimer();
  }

  // ── Idle activity tracking ────────────────────────────────────────────

  ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'].forEach(function (evt) {
    document.addEventListener(evt, function () {
      if (!active) resetIdleTimer();
    }, { passive: true });
  });

  // ── Keyboard shortcut: Ctrl+Alt+S ─────────────────────────────────

  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && e.altKey && e.key === 's') {
      e.preventDefault();
      if (active) {
        stop();
      } else {
        start();
      }
    }
  });

  // ── Init ──────────────────────────────────────────────────────────────

  resetIdleTimer();

  Object.assign(FULCScreenSaver, {
    start: start,
    stop: stop,
    isActive: function () { return active; },
    getIdleTimeout: getIdleTimeout,
    setIdleTimeout: setIdleTimeout
  });
})();
