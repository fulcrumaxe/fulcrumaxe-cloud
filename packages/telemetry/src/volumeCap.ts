export const VOLUME_CAP_LIMIT = 200;
export const VOLUME_CAP_WINDOW_MS = 60_000;
/** The most keys (accounts) tracked at once. */
export const VOLUME_CAP_MAX_KEYS = 10_000;

interface Window {
  start: number;
  admitted: number;
  dropped: number;
}

/**
 * A fixed-window cap on `info` events per key (the account id). The window opens
 * at a key's first event; there are no timers -- a window that has ended is
 * noticed by the key's next call (or by `drain`).
 *
 * The map is bounded: when full, the oldest-started window is evicted in O(1). An evicted
 * window forgets its count, so a flood over more than `maxKeys` accounts can buy a fresh
 * allowance per eviction; bounded memory is the priority.
 */
export class VolumeCap {
  private readonly windows = new Map<string, Window>();

  constructor(
    private readonly now: () => number,
    private readonly limit = VOLUME_CAP_LIMIT,
    private readonly windowMs = VOLUME_CAP_WINDOW_MS,
    private readonly maxKeys = VOLUME_CAP_MAX_KEYS,
  ) {}

  /** Number of keys currently tracked. */
  get size(): number {
    return this.windows.size;
  }

  /** If `key`'s window has ended, close it and return how many events it dropped (0 if none). */
  roll(key: string): number {
    const win = this.windows.get(key);
    if (!win || this.now() - win.start < this.windowMs) return 0;
    this.windows.delete(key);
    return win.dropped;
  }

  /** Count one `info` event; false means drop it. Call `roll` first. */
  admit(key: string): boolean {
    let win = this.windows.get(key);
    if (!win) {
      if (this.windows.size >= this.maxKeys) this.makeRoom();
      win = { start: this.now(), admitted: 0, dropped: 0 };
      this.windows.set(key, win);
    }
    if (win.admitted < this.limit) {
      win.admitted += 1;
      return true;
    }
    win.dropped += 1;
    return false;
  }

  /** Close every ended window and return the ones that dropped events. */
  drain(): Array<{ key: string; dropped: number }> {
    const out: Array<{ key: string; dropped: number }> = [];
    for (const key of [...this.windows.keys()]) {
      const dropped = this.roll(key);
      if (dropped > 0) out.push({ key, dropped });
    }
    return out;
  }

  private makeRoom(): void {
    while (this.windows.size >= this.maxKeys) {
      const oldest = this.windows.keys().next();
      if (oldest.done) return;
      this.windows.delete(oldest.value);
    }
  }
}
