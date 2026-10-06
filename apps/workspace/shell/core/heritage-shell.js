export const FULCHeritage = {
  _current: null,
  _adapters: {},

  register(id, adapter) {
    this._adapters[id] = adapter;
  },

  activate(id) {
    if (this._current) this.deactivate();
    const adapter = this._adapters[id];
    if (!adapter) return;
    document.body.dataset.heritage = id;
    // D#37 WS-TH1 (C19b criterion 4): _current is set BEFORE adapter.activate()
    // runs, not after -- so if activate() throws partway through building its
    // DOM/stylesheet, deactivate() below still knows which adapter to tear
    // down. The old order (_current set only on a successful return) left
    // _current at its previous value on a throw, so a later deactivate()
    // (e.g. switching to a theme with no heritage adapter at all) saw a
    // falsy/stale _current and silently skipped cleanup -- the observed
    // "Aero kept orchard" leak. The throw itself is also caught here so it
    // never escapes the `fulc-theme-change` listener this runs from.
    this._current = id;
    try {
      adapter.activate();
    } catch (err) {
      console.error('FULCHeritage: adapter "' + id + '" failed to activate', err);
      this.deactivate();
    }
  },

  deactivate() {
    if (!this._current) return;
    const adapter = this._adapters[this._current];
    // A throwing deactivate() (e.g. tearing down state a partially-thrown
    // activate() never fully built) must not stop the dataset/_current
    // cleanup below from running -- that cleanup is the whole guarantee
    // activate()'s catch block relies on.
    if (adapter) {
      try {
        adapter.deactivate();
      } catch (err) {
        console.error('FULCHeritage: adapter "' + this._current + '" failed to deactivate', err);
      }
    }
    delete document.body.dataset.heritage;
    this._current = null;
  }
};

document.addEventListener('fulc-theme-change', (e) => {
  const theme = e.detail && e.detail.current;
  if (theme && theme['heritage-adapter']) {
    FULCHeritage.activate(theme['heritage-adapter']);
  } else {
    FULCHeritage.deactivate();
  }
});
