// Decides *when* to sync. Pure logic with an injected clock/timer so it can be unit-tested.
//
//   paused   — window unfocused or graph not visible: nothing runs.
//   idle     — focused and visible, no recent interaction: every `idleIntervalMs`.
//   cooldown — after a user action: first sync `debounceMs` after the last action, then every
//              `cooldownIntervalMs` until `cooldownMs` have passed without new actions.

export interface SyncTiming {
  idleIntervalMs: number;
  debounceMs: number;
  cooldownMs: number;
  cooldownIntervalMs: number;
}

export const DEFAULT_TIMING: SyncTiming = {
  idleIntervalMs: 60_000,
  debounceMs: 2_000,
  cooldownMs: 180_000,
  cooldownIntervalMs: 10_000,
};

export type SyncPhase = 'paused' | 'idle' | 'cooldown';

export interface SchedulerDeps {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  run(): Promise<void>;
  onPhase?(phase: SyncPhase, nextRunAt: number | undefined): void;
}

export class SyncScheduler {
  private focused = true;
  private visible = true;
  private enabled = true;
  private lastActivity = Number.NEGATIVE_INFINITY;
  private lastRun: number;
  /** Pending debounced sync: when it fires, and when the first un-synced action happened. */
  private debounce: { at: number; since: number } | undefined;
  private timer: unknown;
  private running = false;
  private rerun = false;
  private disposed = false;

  constructor(
    private timing: SyncTiming,
    private readonly deps: SchedulerDeps,
  ) {
    this.lastRun = deps.now();
    this.reschedule();
  }

  get phase(): SyncPhase {
    if (!this.enabled || !this.focused || !this.visible) return 'paused';
    return this.deps.now() - this.lastActivity < this.timing.cooldownMs ? 'cooldown' : 'idle';
  }

  setTiming(timing: SyncTiming) {
    this.timing = timing;
    this.reschedule();
  }

  setEnabled(v: boolean) {
    this.enabled = v;
    this.reschedule();
  }

  setFocused(v: boolean) {
    const resumed = v && !this.focused;
    this.focused = v;
    // Coming back to the window counts as a user action: catch up quickly, then stay responsive.
    if (resumed) this.resume();
    else this.reschedule();
  }

  setVisible(v: boolean) {
    const resumed = v && !this.visible;
    this.visible = v;
    if (resumed) this.resume();
    else this.reschedule();
  }

  /** Returning counts as a user action; the interval clock restarts so the debounce rule applies. */
  private resume() {
    if (this.phase === 'paused') return this.reschedule();
    this.lastRun = this.deps.now();
    this.activity();
  }

  /** A user action: debounce, but never starve — continuous interaction still syncs every cooldown interval. */
  activity() {
    const now = this.deps.now();
    this.lastActivity = now;
    const since = this.debounce?.since ?? now;
    const maxWait = Math.max(this.timing.debounceMs, this.timing.cooldownIntervalMs);
    this.debounce = { since, at: Math.min(now + this.timing.debounceMs, since + maxWait) };
    this.reschedule();
  }

  /** Sync as soon as possible (manual refresh, expand, …). */
  now() {
    this.debounce = { since: this.deps.now(), at: this.deps.now() };
    this.reschedule();
  }

  dispose() {
    this.disposed = true;
    if (this.timer !== undefined) this.deps.clearTimer(this.timer);
    this.timer = undefined;
  }

  nextRunAt(): number | undefined {
    const phase = this.phase;
    if (phase === 'paused') return undefined;
    const interval = phase === 'cooldown' ? this.timing.cooldownIntervalMs : this.timing.idleIntervalMs;
    let at = this.lastRun + interval;
    if (this.debounce) at = Math.min(at, this.debounce.at);
    return Math.max(at, this.deps.now());
  }

  private reschedule() {
    if (this.disposed) return;
    if (this.timer !== undefined) this.deps.clearTimer(this.timer);
    this.timer = undefined;
    const at = this.nextRunAt();
    this.deps.onPhase?.(this.phase, at);
    if (at === undefined || this.running) return;
    this.timer = this.deps.setTimer(() => void this.fire(), at - this.deps.now());
  }

  private async fire() {
    this.timer = undefined;
    if (this.disposed || this.phase === 'paused') return;
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.running = true;
    this.debounce = undefined;
    try {
      await this.deps.run();
    } finally {
      this.running = false;
      this.lastRun = this.deps.now();
      if (this.rerun) {
        this.rerun = false;
        this.debounce = { since: this.lastRun, at: this.lastRun };
      }
      this.reschedule();
    }
  }
}
