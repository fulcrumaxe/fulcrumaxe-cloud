// ── fulcrumaxe-os Theme Effects ────────────────────────────────────────────────
// Manages visual effect packages driven by active experience token values.
// Consolidates CRT scanlines/curve/flicker, neon glow, grain overlay, and
// animation timing into a single token-driven system.
// Respects prefers-reduced-motion at all times.
import { FULCPhoneMode } from "./phone-mode.js";

export const FULCEffects = {};
(function () {
  'use strict';

  var _reducedMotion = false;
  var _grainRafId = null;
  var _grainCanvas = null;

  function _applyScanlines(intensity) {
    var el = document.querySelector('.scanlines');
    if (!el) return;
    el.style.opacity = intensity;
    el.style.display = intensity > 0 ? 'block' : 'none';
  }

  function _applyCrtCurve(intensity) {
    var el = document.querySelector('.crt-overlay');
    if (!el) return;
    el.style.opacity = intensity;
    el.style.display = intensity > 0 ? 'block' : 'none';
  }

  function _applyFlicker(scanlines) {
    // D#37 WS-E criterion 5 (OPEN OWNER DECISION 1): no flicker on phones.
    var phone = FULCPhoneMode && FULCPhoneMode.isPhone();
    document.documentElement.style.setProperty(
      '--flicker-anim',
      (!phone && scanlines > 0.5) ? 'flicker 0.1s infinite' : 'none'
    );
  }

  function _applyGlow(intensity) {
    // tokens already hold correct glow values; only suppress when intensity = 0
    if (intensity === 0 || intensity === '0') {
      var root = document.documentElement;
      root.style.setProperty('--glow-accent', 'none');
      root.style.setProperty('--glow-bright', 'none');
    }
  }

  // D#37 WS-E criterion 5: grain stops when document.hidden and does not
  // start under prefers-reduced-motion (already covered: apply() below
  // short-circuits entirely on _reducedMotion). "Stops" means the rAF
  // scheduling itself stops -- not just the drawing -- so a Playwright
  // check for "no canvas requestAnimationFrame callbacks" while hidden
  // actually sees none, rather than a throttled trickle of no-op frames.
  function _animateGrain(canvas) {
    var ctx = canvas.getContext('2d');
    function draw(ts) {
      if (document.hidden) { _grainRafId = null; return; }
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      var img = ctx.createImageData(canvas.width, canvas.height);
      for (var i = 0; i < img.data.length; i += 4) {
        var v = Math.random() * 255;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      _grainRafId = requestAnimationFrame(draw);
    }
    draw();
  }

  function _applyGrain(intensity) {
    intensity = parseFloat(intensity) || 0;
    var grain = document.getElementById('fulc-grain');
    // D#37 WS-E criterion 5: no grain on phones.
    var phone = FULCPhoneMode && FULCPhoneMode.isPhone();
    if (intensity <= 0 || phone) {
      if (grain) grain.remove();
      if (_grainRafId) { cancelAnimationFrame(_grainRafId); _grainRafId = null; }
      _grainCanvas = null;
      return;
    }
    if (!grain) {
      grain = document.createElement('canvas');
      grain.id = 'fulc-grain';
      grain.style.cssText = [
        'position:fixed', 'top:0', 'left:0', 'width:100%', 'height:100%',
        'pointer-events:none', 'z-index:99', 'mix-blend-mode:overlay'
      ].join(';');
      document.body.appendChild(grain);
      _animateGrain(grain);
    }
    _grainCanvas = grain;
    grain.style.opacity = intensity * 0.3;
  }

  // Resumes the grain rAF loop when the tab becomes visible again -- draw()
  // above only ever stops it, it never restarts itself.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && _grainCanvas && _grainRafId === null) {
      _animateGrain(_grainCanvas);
    }
  });

  function _applyAnimProfile(duration, easing) {
    var root = document.documentElement;
    root.style.setProperty('--anim-duration', duration);
    root.style.setProperty('--anim-easing', easing);
  }

  Object.assign(FULCEffects, {
    init: function () {
      var self = this;
      var mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      mq.addEventListener('change', function (e) {
        if (e.matches) self.setReducedMotion(true);
      });
      if (mq.matches) this.setReducedMotion(true);
    },

    apply: function (tokens) {
      if (_reducedMotion) return;
      var scanlines = parseFloat(tokens['effect-scanlines']) || 0;
      var glow      = parseFloat(tokens['effect-glow'])      || 0;
      var grain     = parseFloat(tokens['effect-grain'])     || 0;
      var crtCurve  = parseFloat(tokens['effect-crt-curve']) || 0;
      var animDur   = tokens['anim-duration'] || '0.15s';
      var animEase  = tokens['anim-easing']   || 'ease';

      _applyScanlines(scanlines);
      _applyCrtCurve(crtCurve);
      _applyFlicker(scanlines);
      _applyGlow(glow);
      _applyGrain(grain);
      _applyAnimProfile(animDur, animEase);
    },

    setReducedMotion: function (reduced) {
      _reducedMotion = reduced;
      if (reduced) {
        var root = document.documentElement;
        root.style.setProperty('--anim-duration', '0.001s');
        root.style.setProperty('--anim-easing', 'linear');
        root.style.setProperty('--effect-scanlines', '0');
        root.style.setProperty('--flicker-anim', 'none');
        root.style.setProperty('--effect-grain', '0');
        _applyScanlines(0);
        _applyCrtCurve(0);
        _applyGrain(0);
      }
    }
  });

  // Auto-initialize at script load (body exists; scripts are at end of body)
  FULCEffects.init();
})();
