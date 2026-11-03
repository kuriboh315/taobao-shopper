import type { StopReason } from '../shared/messages';

/** What the driver needs from the page; injected so the loop can run on a fake clock in tests. */
export interface DriverDeps {
  /** Opens the review view (at most one click); true when a scrollable review list is showing. */
  openReviews(): Promise<boolean>;
  /** One careful load step; true when it made progress (scrolled further or new reviews arrived). */
  loadMore(): Promise<boolean>;
  /** Reviews collected so far. */
  count(): number;
  /** True while a captcha, verification or anomaly notice is showing (DOM or intercepted response). */
  captchaVisible(): boolean;
  sleep(ms: number): Promise<void>;
  random(): number;
  now(): number;
  onProgress(n: number): void;
  onCaptcha(): void;
}

export const REVIEW_CAP = 80;
export const TIME_LIMIT_MS = 180_000;
export const MIN_DELAY_MS = 1500;
export const MAX_DELAY_MS = 4000;
/** Consecutive failed loads that mean the source has nothing more. */
const MAX_FAILED_LOADS = 2;

/**
 * Collects reviews at a human pace: a randomised pause before every load, a hard cap, a time limit, and a
 * full stop on any captcha until the user resumes or finishes. Captcha is checked before every page action.
 */
export class ReviewDriver {
  private finished = false;
  private wake: (() => void) | null = null;
  private pausedMs = 0;
  private lastProgress = -1;

  constructor(private readonly deps: DriverDeps) {}

  /** Continues after a captcha pause (the user says it's solved). */
  resume(): void {
    this.wakeUp();
  }

  /** Stops the run; it resolves with 'user' at the next check, including during a captcha pause. */
  finish(): void {
    this.finished = true;
    this.wakeUp();
  }

  async run(): Promise<StopReason> {
    const { deps } = this;
    const start = deps.now();
    const elapsed = () => deps.now() - start - this.pausedMs;

    if (!(await this.clearOfCaptcha())) return 'user';
    await deps.openReviews();

    let failed = 0;
    for (;;) {
      if (!(await this.clearOfCaptcha())) return 'user';
      const n = deps.count();
      if (n !== this.lastProgress) {
        this.lastProgress = n;
        deps.onProgress(n);
      }
      if (n >= REVIEW_CAP) return 'cap';
      if (failed >= MAX_FAILED_LOADS) return 'exhausted';
      if (elapsed() >= TIME_LIMIT_MS) return 'timeout';

      await deps.sleep(this.delay());
      // The captcha check comes right before the action, after the pause.
      if (!(await this.clearOfCaptcha())) return 'user';
      if (elapsed() >= TIME_LIMIT_MS) return 'timeout';
      failed = (await deps.loadMore()) ? 0 : failed + 1;
    }
  }

  private delay(): number {
    const r = Math.min(Math.max(this.deps.random(), 0), 1);
    return Math.round(MIN_DELAY_MS + r * (MAX_DELAY_MS - MIN_DELAY_MS));
  }

  /**
   * False when the run is finished. While a captcha shows, reports it once per pause and waits for
   * resume() or finish(); paused time doesn't count toward the time limit.
   */
  private async clearOfCaptcha(): Promise<boolean> {
    while (!this.finished && this.deps.captchaVisible()) {
      const pausedAt = this.deps.now();
      this.deps.onCaptcha();
      await new Promise<void>((resolve) => { this.wake = resolve; });
      this.pausedMs += this.deps.now() - pausedAt;
    }
    return !this.finished;
  }

  private wakeUp(): void {
    const w = this.wake;
    this.wake = null;
    w?.();
  }
}
