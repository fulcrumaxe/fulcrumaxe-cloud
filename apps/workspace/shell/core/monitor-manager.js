export let FULCMonitors;
(function () {
  'use strict';

  function MonitorManager() {
    this.monitors = [];
    this.ready = false;
  }

  MonitorManager.prototype = {

    init: function () {
      var self = this;

      // Wry path: tao injects FULC_MONITORS_NATIVE at window creation
      if (window.FULC_MONITORS_NATIVE && Array.isArray(window.FULC_MONITORS_NATIVE) && window.FULC_MONITORS_NATIVE.length > 0) {
        self.monitors = self._resolveMonitors(window.FULC_MONITORS_NATIVE);
        self._publish();
        return;
      }

      // Chrome debug path: Window Management API (triggers permission prompt on first use)
      if (typeof window.getScreenDetails === 'function') {
        window.getScreenDetails().then(function (details) {
          self.monitors = self._resolveMonitors(details.screens.map(function (s, i) {
            return {
              id: i,
              name: s.label || ('Monitor ' + (i + 1)),
              x: s.left,
              y: s.top,
              width: s.width,
              height: s.height,
              scaleFactor: s.devicePixelRatio || 1,
              isPrimary: !!s.isPrimary
            };
          }));
          self._publish();
        }).catch(function () {
          self._fallback();
        });
        return;
      }

      self._fallback();
    },

    // A single logical monitor == the current webview viewport. Used whenever
    // we cannot trust absolute multi-monitor geometry (see _resolveMonitors).
    _viewportMonitor: function () {
      return {
        id: 0,
        name: 'Primary',
        x: 0,
        y: 0,
        width: window.innerWidth,
        height: window.innerHeight,
        scaleFactor: window.devicePixelRatio || 1,
        isPrimary: true
      };
    },

    // Decide whether the webview actually SPANS the reported monitors.
    //
    // window-manager.js's multi-monitor placement math assumes the viewport
    // covers ALL monitors and that window.screenX reports the window's true
    // offset. That holds for a browser window explicitly stretched across
    // every screen — but NOT for the normal case:
    //   * A Wry webview is a single OS window on ONE surface, and under
    //     Wayland window.screenX is always 0 (compositors don't expose a
    //     window's absolute position). tao still injects the real physical
    //     monitor list (e.g. three 1920px monitors at x=0/1920/3840), so
    //     monitors.length > 1 and the per-monitor origins (0/1920/3840) — which
    //     the ~1280px viewport never actually covers — push maximised/snapped
    //     windows off-screen to the right. Symptom: only the first monitor's
    //     worth of the UI renders/responds.
    // If the viewport is materially smaller than the combined monitor span, we
    // are NOT spanning: collapse to a single viewport monitor so the correct
    // single-monitor code path runs.
    _resolveMonitors: function (candidates) {
      if (!candidates || candidates.length <= 1) {
        return (candidates && candidates.length) ? candidates : [this._viewportMonitor()];
      }
      var xs = candidates.map(function (m) { return m.x; });
      var tops = candidates.map(function (m) { return m.y; });
      var rights = candidates.map(function (m) { return m.x + m.width; });
      var bottoms = candidates.map(function (m) { return m.y + m.height; });
      var spanW = Math.max.apply(null, rights) - Math.min.apply(null, xs);
      var spanH = Math.max.apply(null, bottoms) - Math.min.apply(null, tops);
      // 16px slack for window borders / rounding. Spanning requires covering
      // both extents of the monitor arrangement.
      var spans = window.innerWidth >= spanW - 16 && window.innerHeight >= spanH - 16;
      return spans ? candidates : [this._viewportMonitor()];
    },

    _fallback: function () {
      this.monitors = [{
        id: 0,
        name: 'Primary',
        x: 0,
        y: 0,
        width: window.screen ? window.screen.width : window.innerWidth,
        height: window.screen ? window.screen.height : window.innerHeight,
        scaleFactor: window.devicePixelRatio || 1,
        isPrimary: true
      }];
      this._publish();
    },

    _publish: function () {
      this.ready = true;
      window.__fulc = window.__fulc || {};
      window.__fulc.monitors = this.monitors;
      document.dispatchEvent(new CustomEvent('fulc:monitors-ready', {
        detail: { monitors: this.monitors }
      }));
    },

    // Monitor containing the fulcrumaxe-os browser window's top-left corner (by screenX/Y)
    getActiveMonitor: function () {
      if (this.monitors.length <= 1) return this.monitors[0] || null;
      var sx = typeof window.screenLeft !== 'undefined' ? window.screenLeft : (window.screenX || 0);
      var sy = typeof window.screenTop !== 'undefined' ? window.screenTop : (window.screenY || 0);
      for (var i = 0; i < this.monitors.length; i++) {
        var m = this.monitors[i];
        if (sx >= m.x && sx < m.x + m.width && sy >= m.y && sy < m.y + m.height) return m;
      }
      return this.getPrimary();
    },

    getActiveMonitorId: function () {
      var m = this.getActiveMonitor();
      return m ? m.id : 0;
    },

    getPrimary: function () {
      for (var i = 0; i < this.monitors.length; i++) {
        if (this.monitors[i].isPrimary) return this.monitors[i];
      }
      return this.monitors[0] || null;
    },

    getById: function (id) {
      for (var i = 0; i < this.monitors.length; i++) {
        if (this.monitors[i].id === id) return this.monitors[i];
      }
      return null;
    },

    // Convert viewport coords to absolute screen coords
    _viewportToScreen: function (vx, vy) {
      var ox = typeof window.screenLeft !== 'undefined' ? window.screenLeft : (window.screenX || 0);
      var oy = typeof window.screenTop !== 'undefined' ? window.screenTop : (window.screenY || 0);
      return { x: ox + vx, y: oy + vy };
    },

    // Monitor containing an absolute screen point
    getMonitorForScreenPoint: function (sx, sy) {
      for (var i = 0; i < this.monitors.length; i++) {
        var m = this.monitors[i];
        if (sx >= m.x && sx < m.x + m.width && sy >= m.y && sy < m.y + m.height) return m;
      }
      return this.getPrimary();
    },

    // Viewport-relative bounds of the monitor containing viewport point (vx, vy).
    // Returns {originX, originY, width, height, monitor} or null when single-monitor
    // (single-monitor callers can use window.innerWidth directly).
    getMonitorViewportArea: function (vx, vy) {
      if (this.monitors.length <= 1) return null;
      var sc = this._viewportToScreen(vx, vy);
      var m = this.getMonitorForScreenPoint(sc.x, sc.y);
      if (!m) return null;
      var ox = typeof window.screenLeft !== 'undefined' ? window.screenLeft : (window.screenX || 0);
      var oy = typeof window.screenTop !== 'undefined' ? window.screenTop : (window.screenY || 0);
      return { originX: m.x - ox, originY: m.y - oy, width: m.width, height: m.height, monitor: m };
    },

    // Viewport-relative bounds for every monitor (used by drag-edge detection).
    // Returns null when single-monitor so callers can fast-path to the simple case.
    getAllMonitorViewportAreas: function () {
      if (this.monitors.length <= 1) return null;
      var ox = typeof window.screenLeft !== 'undefined' ? window.screenLeft : (window.screenX || 0);
      var oy = typeof window.screenTop !== 'undefined' ? window.screenTop : (window.screenY || 0);
      return this.monitors.map(function (m) {
        return { originX: m.x - ox, originY: m.y - oy, width: m.width, height: m.height, monitor: m };
      });
    }
  };

  FULCMonitors = new MonitorManager();
  FULCMonitors.init();
})();
