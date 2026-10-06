import { FULCPhoneMode } from "./core/phone-mode.js";

(function () {
  const canvas = document.getElementById('rain-bg');
  const ctx = canvas.getContext('2d');

  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789$+-*/=%&_(),.;:?!|{}<>[]^~';
  const characterSet = characters.split('');
  const fontSize = 16;
  let columns = Math.floor(canvas.width / fontSize);
  let drops = [];

  let rainColor = '#1aff80';

  for (let x = 0; x < columns; x++) {
    drops[x] = 1;
  }

  function drawRain() {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.05)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = rainColor;
    ctx.font = fontSize + 'px monospace';

    for (let i = 0; i < drops.length; i++) {
      const text = characterSet[Math.floor(Math.random() * characterSet.length)];
      ctx.fillText(text, i * fontSize, drops[i] * fontSize);

      if (drops[i] * fontSize > canvas.height && Math.random() > 0.975) {
        drops[i] = 0;
      }
      drops[i]++;
    }
  }

  // D#37 WS-E criterion 5: rain stops when document.hidden, does not start
  // under prefers-reduced-motion, and never runs on phones at all.
  //
  // This stayed a setTimeout-driven loop rather than moving to
  // requestAnimationFrame. requestAnimationFrame is tied to the browser's
  // real paint pipeline -- under Playwright's fake clock (page.clock),
  // e2e/idle-network.spec.ts fast-forwards a 10-REAL-minute idle window in
  // one runFor() call, and re-registering a requestAnimationFrame callback
  // on that cadence (tried both at the display's own ~16ms refresh rate and
  // gated to this loop's own 33ms tick) made that single runFor() call pump
  // a real paint tick per callback, timing out the test on both the
  // "desktop" and "tablet" Playwright projects (reproduced both ways;
  // removing requestAnimationFrame entirely was the only fix that held). A
  // plain setTimeout has no such tie to painting and already fast-forwards
  // correctly -- proven by this exact idle-network scenario, which this
  // loop's own predecessor (a setInterval) already passed. Stopping and
  // restarting the timer chain itself (not a flag checked inside an
  // always-scheduled callback) is what "stops" means here: no timer is
  // pending at all while hidden/reduced-motion/phone, which is the
  // testable, real difference from before.
  const reducedMotionMq = window.matchMedia('(prefers-reduced-motion: reduce)');

  function shouldRun() {
    return !document.hidden
      && !reducedMotionMq.matches
      && !(FULCPhoneMode && FULCPhoneMode.isPhone());
  }

  let timerId = null;
  const FRAME_INTERVAL_MS = 33; // ~30fps, matching the original setInterval cadence

  function tick() {
    timerId = null;
    if (!shouldRun()) return;
    drawRain();
    timerId = setTimeout(tick, FRAME_INTERVAL_MS);
  }

  function ensureRunning() {
    if (timerId === null && shouldRun()) {
      tick();
    }
  }

  document.addEventListener('visibilitychange', ensureRunning);
  if (reducedMotionMq.addEventListener) reducedMotionMq.addEventListener('change', ensureRunning);
  else if (reducedMotionMq.addListener) reducedMotionMq.addListener(ensureRunning);
  if (FULCPhoneMode) FULCPhoneMode.onChange(ensureRunning);

  ensureRunning();

  window.addEventListener('resize', () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    columns = Math.floor(canvas.width / fontSize);
    drops = [];
    for (let x = 0; x < columns; x++) {
      drops[x] = 1;
    }
  });

  window.updateRainColor = function (color) {
    rainColor = color;
  };
})();

export const updateRainColor = window.updateRainColor;
