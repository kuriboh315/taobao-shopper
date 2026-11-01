import { describe, it, expect, vi } from 'vitest';
import { ReviewDriver, type DriverDeps } from '../../src/collect/driver';

/** Lets pending promise callbacks run. */
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

interface Fake {
  deps: DriverDeps;
  clock: { t: number };
  sleeps: number[];
  calls: { open: number; load: number };
  state: { count: number; captcha: boolean };
}

/** Fake deps on a virtual clock: `sleep` advances time instantly; `load` decides each loadMore result. */
function fake(opts: {
  count?: number;
  load?: (state: Fake['state'], call: number) => boolean;
  random?: () => number;
  loadMs?: number;
} = {}): Fake {
  const clock = { t: 1_000_000 };
  const sleeps: number[] = [];
  const calls = { open: 0, load: 0 };
  const state = { count: opts.count ?? 0, captcha: false };
  const deps: DriverDeps = {
    openReviews: vi.fn(async () => { calls.open++; return true; }),
    loadMore: vi.fn(async () => {
      calls.load++;
      clock.t += opts.loadMs ?? 0;
      return opts.load ? opts.load(state, calls.load) : true;
    }),
    count: () => state.count,
    captchaVisible: () => state.captcha,
    sleep: vi.fn(async (ms: number) => { sleeps.push(ms); clock.t += ms; }),
    random: opts.random ?? (() => 0.5),
    now: () => clock.t,
    onProgress: vi.fn(),
    onCaptcha: vi.fn(),
  };
  return { deps, clock, sleeps, calls, state };
}

describe('ReviewDriver', () => {
  it("stops with 'cap' when the count reaches 80", async () => {
    const f = fake({ load: (s) => { s.count += 20; return true; } });
    expect(await new ReviewDriver(f.deps).run()).toBe('cap');
    expect(f.calls.open).toBe(1);
    expect(f.calls.load).toBe(4);
    expect(f.deps.onProgress).toHaveBeenLastCalledWith(80);
  });

  it("stops with 'exhausted' after two failed loads in a row at 40 or more", async () => {
    const f = fake({ count: 40, load: () => false });
    expect(await new ReviewDriver(f.deps).run()).toBe('exhausted');
    expect(f.calls.load).toBe(2);
  });

  it("stops with 'exhausted' below 40 too when the source has nothing more", async () => {
    const f = fake({ count: 12, load: () => false });
    expect(await new ReviewDriver(f.deps).run()).toBe('exhausted');
    expect(f.calls.load).toBe(2);
  });

  it('a successful load resets the failure streak', async () => {
    const f = fake({ load: (_s, n) => n % 2 === 0 });
    const run = new ReviewDriver(f.deps).run();
    // Alternating fail/success never makes two failures in a row, so only the time limit stops it.
    expect(await run).toBe('timeout');
  });

  it("stops with 'timeout' once 180 s have elapsed", async () => {
    const f = fake({ count: 5, load: () => true, random: () => 0.99 });
    const start = f.clock.t;
    expect(await new ReviewDriver(f.deps).run()).toBe('timeout');
    const elapsed = f.clock.t - start;
    expect(elapsed).toBeGreaterThanOrEqual(180_000);
    expect(elapsed).toBeLessThan(180_000 + 4_000);
  });

  it('every sleep is between 1500 and 4000 ms', async () => {
    const seq = [0, 0.9999, 0.25, 0.5, 0.75, 0.001];
    let i = 0;
    const f = fake({ load: (s) => { s.count += 10; return true; }, random: () => seq[i++ % seq.length]! });
    await new ReviewDriver(f.deps).run();
    expect(f.sleeps.length).toBeGreaterThan(5);
    for (const ms of f.sleeps) {
      expect(ms).toBeGreaterThanOrEqual(1500);
      expect(ms).toBeLessThanOrEqual(4000);
    }
    expect(f.sleeps[0]).toBe(1500);
  });

  it('pauses on a captcha: no loadMore until resume(), onCaptcha exactly once', async () => {
    const f = fake({ load: (s, n) => { s.count += 5; if (n === 2) s.captcha = true; return true; } });
    const driver = new ReviewDriver(f.deps);
    let result: string | undefined;
    void driver.run().then((r) => { result = r; });
    await flush();
    expect(f.calls.load).toBe(2);
    expect(f.deps.onCaptcha).toHaveBeenCalledTimes(1);
    await flush();
    await flush();
    expect(f.calls.load).toBe(2);
    expect(f.deps.onCaptcha).toHaveBeenCalledTimes(1);
    expect(result).toBeUndefined();

    f.state.captcha = false;
    driver.resume();
    await flush();
    expect(f.calls.load).toBeGreaterThan(2);
    expect(f.deps.onCaptcha).toHaveBeenCalledTimes(1);
  });

  it('checks for a captcha before opening the reviews', async () => {
    const f = fake({ load: () => false });
    f.state.captcha = true;
    const driver = new ReviewDriver(f.deps);
    const run = driver.run();
    await flush();
    expect(f.calls.open).toBe(0);
    expect(f.deps.onCaptcha).toHaveBeenCalledTimes(1);
    f.state.captcha = false;
    driver.resume();
    expect(await run).toBe('exhausted');
    expect(f.calls.open).toBe(1);
  });

  it('pauses again if the captcha is still there after resume()', async () => {
    const f = fake({ load: () => false });
    f.state.captcha = true;
    const driver = new ReviewDriver(f.deps);
    const run = driver.run();
    await flush();
    driver.resume();
    await flush();
    expect(f.deps.onCaptcha).toHaveBeenCalledTimes(2);
    expect(f.calls.open).toBe(0);
    driver.finish();
    expect(await run).toBe('user');
  });

  it("finish() during a captcha pause returns 'user'", async () => {
    const f = fake({ load: (s, n) => { s.count += 5; if (n === 1) s.captcha = true; return true; } });
    const driver = new ReviewDriver(f.deps);
    const run = driver.run();
    await flush();
    expect(f.deps.onCaptcha).toHaveBeenCalledTimes(1);
    driver.finish();
    expect(await run).toBe('user');
    expect(f.calls.load).toBe(1);
  });

  it("finish() during a sleep returns 'user' without loading again", async () => {
    const f = fake({ load: (s) => { s.count += 5; return true; } });
    let release: () => void = () => {};
    f.deps.sleep = vi.fn(() => new Promise<void>((r) => { release = r; }));
    const driver = new ReviewDriver(f.deps);
    const run = driver.run();
    await flush();
    driver.finish();
    release();
    expect(await run).toBe('user');
    expect(f.calls.load).toBe(0);
  });

  it('time spent paused on a captcha does not count toward the limit', async () => {
    const f = fake({ load: (s, n) => { s.count += 1; if (n === 1) s.captcha = true; return true; } });
    const driver = new ReviewDriver(f.deps);
    const run = driver.run();
    await flush();
    f.clock.t += 600_000; // the user takes ten minutes to solve it
    f.state.captcha = false;
    driver.resume();
    await flush();
    expect(f.calls.load).toBeGreaterThan(1);
    expect(await run).toBe('timeout');
  });

  it('reports progress only when the count changes', async () => {
    const f = fake({ count: 3, load: () => false });
    await new ReviewDriver(f.deps).run();
    expect(f.deps.onProgress).toHaveBeenCalledTimes(1);
    expect(f.deps.onProgress).toHaveBeenCalledWith(3);
  });
});
