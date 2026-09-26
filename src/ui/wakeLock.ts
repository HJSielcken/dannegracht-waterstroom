// Keeps the screen on while the simulation runs, so a phone does not switch its screen off and
// freeze the page. Uses the Screen Wake Lock API where available (not in older browsers or on
// insecure origins; then this does nothing). The browser drops the lock whenever the page is
// hidden, so it is requested again when the page becomes visible.

export class ScreenWakeLock {
  private wanted = false;
  private sentinel: WakeLockSentinel | null = null;
  /** Syncs run one after another, so overlapping requests cannot leak a lock. */
  private queue: Promise<void> = Promise.resolve();

  constructor() {
    document.addEventListener('visibilitychange', () => this.sync());
  }

  /** Hold the lock (while the page is visible) or release it. */
  set(wanted: boolean): void {
    this.wanted = wanted;
    this.sync();
  }

  private sync(): void {
    this.queue = this.queue.then(() => this.syncNow());
  }

  private async syncNow(): Promise<void> {
    const want = this.wanted && document.visibilityState === 'visible';
    if (!want) {
      const s = this.sentinel;
      this.sentinel = null;
      await s?.release().catch(() => {});
      return;
    }
    if (this.sentinel && !this.sentinel.released) return;
    if (!('wakeLock' in navigator)) return;
    try {
      this.sentinel = await navigator.wakeLock.request('screen');
    } catch {
      // Refused (e.g. battery saver); the simulation just runs without it.
    }
  }
}
