// ── fulcrumaxe-os Overlay System ──────────────────────────────────────────────
// Confirmation, success, and discard overlays.
// Exposes globals: showConfirmationOverlay, showSuccessOverlay, showDiscardOverlay,
//   overlayFocused, handleOverlayYes, handleOverlayNo
(function () {
  'use strict';

  let currentOverlayCallback = null;
  window.overlayFocused = false;
  let overlayYesFocused = true;

  window.showConfirmationOverlay = function (message, onYes, onNo) {
    document.getElementById('overlay-message').innerText = message;
    const overlay = document.getElementById('confirmation-overlay');
    overlay.classList.remove('hidden');
    overlay.focus();
    currentOverlayCallback = { onYes, onNo };
    window.overlayFocused = true;
    overlayYesFocused = true;
    updateOverlayButtonFocus();
  };

  window.showSuccessOverlay = function (message) {
    document.getElementById('success-message').innerText = message;
    document.getElementById('success-overlay').classList.remove('hidden');
    setTimeout(() => {
      document.getElementById('success-overlay').classList.add('hidden');
    }, 2000);
  };

  window.showDiscardOverlay = function (message) {
    document.getElementById('discard-message').innerText = message;
    document.getElementById('discard-overlay').classList.remove('hidden');
    setTimeout(() => {
      document.getElementById('discard-overlay').classList.add('hidden');
    }, 2000);
  };

  function hideConfirmationOverlay() {
    document.getElementById('confirmation-overlay').classList.add('hidden');
    window.overlayFocused = false;
  }

  function updateOverlayButtonFocus() {
    const yesBtn = document.getElementById('overlay-yes');
    const noBtn = document.getElementById('overlay-no');
    yesBtn.classList.remove('focused');
    noBtn.classList.remove('focused');
    if (overlayYesFocused) {
      yesBtn.classList.add('focused');
    } else {
      noBtn.classList.add('focused');
    }
  }

  window.handleOverlayYes = function () {
    const cb = currentOverlayCallback;
    hideConfirmationOverlay();
    currentOverlayCallback = null;
    if (cb && cb.onYes) cb.onYes();
  };

  window.handleOverlayNo = function () {
    const cb = currentOverlayCallback;
    hideConfirmationOverlay();
    currentOverlayCallback = null;
    if (cb && cb.onNo) cb.onNo();
  };

  document.getElementById('overlay-yes').onclick = window.handleOverlayYes;
  document.getElementById('overlay-no').onclick = window.handleOverlayNo;

  // Overlay keyboard navigation
  document.addEventListener('keydown', (e) => {
    if (!window.overlayFocused) return;
    e.preventDefault();
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      overlayYesFocused = true;
      updateOverlayButtonFocus();
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      overlayYesFocused = false;
      updateOverlayButtonFocus();
    } else if (e.key === 'Enter') {
      if (overlayYesFocused) {
        window.handleOverlayYes();
      } else {
        window.handleOverlayNo();
      }
    }
  });
})();

export {};
