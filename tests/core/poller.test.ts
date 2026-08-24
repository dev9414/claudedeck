/**
 * `src/main/poller.ts` — keeping displayed usage current.
 *
 * The defect this replaces was simple and total: usage was fetched once at boot
 * and never again unless the auto-switch engine happened to be running. So the
 * tests that matter are about *when* it polls, not about the fetch itself:
 *   - does it poll at all when nothing else does,
 *   - does it stand down when the engine is already polling,
 *   - does attention change the cadence,
 *   - does a failure back off instead of hammering a rate-limited endpoint.
 *
 * `AppServices` is large and Electron-bound, so it is faked down to the two
 * members the poller touches. The window is faked structurally, which is why
 * `PollWindow` exists.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  FOCUSED_INTERVAL_MS,
  HIDDEN_INTERVAL_MS,
  MAX_BACKOFF_MS,
  STANDBY_INTERVAL_MS,
  VISIBLE_INTERVAL_MS,
  type PollWindow,
  type UsagePollerDeps,
  createUsagePoller,
} from '../../src/main/poller';
import type { AppServices } from '../../src/main/services';
import { err, ok } from '@shared/types';

const T0 = Date.UTC(2026, 7, 24, 12, 0, 0);

interface Harness {
  deps: UsagePollerDeps;
  /** Run the pending timer, as if its delay had elapsed. */
  fire(): Promise<void>;
  pendingDelay(): number | null;
  refreshCalls(): number;
  setRunning(next: boolean): void;
  setResult(next: 'ok' | 'error' | 'throw'): void;
  setFetchedAt(next: number | undefined): void;
  window: FakeWindow;
  listeners: Map<string, Array<() => void>>;
}

class FakeWindow implements PollWindow {
  destroyed = false;
  visible = true;
  minimized = false;
  focused = true;

  constructor(private readonly listeners: Map<string, Array<() => void>>) {}

  isDestroyed(): boolean {
    return this.destroyed;
  }
  isVisible(): boolean {
    return this.visible;
  }
  isMinimized(): boolean {
    return this.minimized;
  }
  isFocused(): boolean {
    return this.focused;
  }
  on(event: string, listener: () => void): unknown {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }
  removeListener(event: string, listener: () => void): unknown {
    this.listeners.set(event, (this.listeners.get(event) ?? []).filter((l) => l !== listener));
    return this;
  }
}

function harness(): Harness {
  const listeners = new Map<string, Array<() => void>>();
  const window = new FakeWindow(listeners);

  let autoSwitchRunning = false;
  let mode: 'ok' | 'error' | 'throw' = 'ok';
  let fetchedAt: number | undefined = T0;
  let refreshCalls = 0;

  let pending: { fn: () => void; ms: number } | null = null;

  const services = {
    currentState: () => ({ autoSwitchRunning, accounts: [{ usage: fetchedAt === undefined ? undefined : { fetchedAt } }] }),
    refreshUsage: async () => {
      refreshCalls += 1;
      if (mode === 'throw') throw new Error('boom');
      return mode === 'ok' ? ok([]) : err('usage endpoint said no');
    },
  } as unknown as AppServices;

  const deps: UsagePollerDeps = {
    services,
    getWindow: () => window,
    now: () => T0,
    setTimer: ((fn: () => void, ms: number) => {
      pending = { fn, ms };
      return 1 as unknown as NodeJS.Timeout;
    }) as UsagePollerDeps['setTimer'],
    clearTimer: (() => {
      pending = null;
    }) as UsagePollerDeps['clearTimer'],
  };

  return {
    deps,
    window,
    listeners,
    pendingDelay: () => pending?.ms ?? null,
    async fire() {
      const current = pending;
      pending = null;
      current?.fn();
      // The tick is async; let its microtasks drain.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
    refreshCalls: () => refreshCalls,
    setRunning: (next) => {
      autoSwitchRunning = next;
    },
    setResult: (next) => {
      mode = next;
    },
    setFetchedAt: (next) => {
      fetchedAt = next;
    },
  };
}

describe('createUsagePoller: it polls at all', () => {
  it('arms a timer on start, which is the whole point', () => {
    const h = harness();
    const poller = createUsagePoller(h.deps);
    expect(h.pendingDelay()).toBeNull();
    poller.start();
    expect(h.pendingDelay()).toBe(FOCUSED_INTERVAL_MS);
    poller.stop();
  });

  it('refreshes when the timer fires, and re-arms', async () => {
    const h = harness();
    const poller = createUsagePoller(h.deps);
    poller.start();
    await h.fire();
    expect(h.refreshCalls()).toBe(1);
    expect(h.pendingDelay()).toBe(FOCUSED_INTERVAL_MS);
    poller.stop();
  });

  it('does nothing after stop', async () => {
    const h = harness();
    const poller = createUsagePoller(h.deps);
    poller.start();
    poller.stop();
    expect(h.pendingDelay()).toBeNull();
    expect(await poller.refreshNow('manual')).toBe(false);
    expect(h.refreshCalls()).toBe(0);
  });

  it('start is idempotent', () => {
    const h = harness();
    const poller = createUsagePoller(h.deps);
    poller.start();
    poller.start();
    expect(h.pendingDelay()).toBe(FOCUSED_INTERVAL_MS);
    poller.stop();
  });
});

describe('createUsagePoller: it stands down for the engine', () => {
  it('uses the standby interval while auto-switch is running', () => {
    const h = harness();
    h.setRunning(true);
    const poller = createUsagePoller(h.deps);
    poller.start();
    expect(h.pendingDelay()).toBe(STANDBY_INTERVAL_MS);
    poller.stop();
  });

  it('does not double-poll: a tick while the engine runs fetches nothing', async () => {
    const h = harness();
    h.setRunning(true);
    const poller = createUsagePoller(h.deps);
    poller.start();
    await h.fire();
    expect(h.refreshCalls()).toBe(0);
    // ...but it re-arms, so it notices when the engine stops.
    expect(h.pendingDelay()).toBe(STANDBY_INTERVAL_MS);
    poller.stop();
  });

  it('takes over once the engine stops', async () => {
    const h = harness();
    h.setRunning(true);
    const poller = createUsagePoller(h.deps);
    poller.start();
    await h.fire();
    expect(h.refreshCalls()).toBe(0);

    h.setRunning(false);
    await h.fire();
    expect(h.refreshCalls()).toBe(1);
    poller.stop();
  });

  it('refuses an explicit refresh while the engine owns polling', async () => {
    const h = harness();
    h.setRunning(true);
    const poller = createUsagePoller(h.deps);
    poller.start();
    expect(await poller.refreshNow('manual')).toBe(false);
    expect(h.refreshCalls()).toBe(0);
    poller.stop();
  });
});

describe('createUsagePoller: cadence follows attention', () => {
  it('slows down when the window is open but not focused', async () => {
    const h = harness();
    const poller = createUsagePoller(h.deps);
    poller.start();
    h.window.focused = false;
    await h.fire();
    expect(h.pendingDelay()).toBe(VISIBLE_INTERVAL_MS);
    poller.stop();
  });

  it.each([
    ['hidden', (w: FakeWindow) => (w.visible = false)],
    ['minimised', (w: FakeWindow) => (w.minimized = true)],
    ['destroyed', (w: FakeWindow) => (w.destroyed = true)],
  ])('drops to the slow interval when %s', async (_label, mutate) => {
    const h = harness();
    const poller = createUsagePoller(h.deps);
    poller.start();
    mutate(h.window);
    await h.fire();
    expect(h.pendingDelay()).toBe(HIDDEN_INTERVAL_MS);
    poller.stop();
  });

  it('uses the slow interval with no window at all (tray only)', () => {
    const h = harness();
    const poller = createUsagePoller({ ...h.deps, getWindow: () => null });
    poller.start();
    expect(h.pendingDelay()).toBe(HIDDEN_INTERVAL_MS);
    poller.stop();
  });

  it('refreshes on focus when the data is stale', async () => {
    const h = harness();
    h.setFetchedAt(T0 - 10 * 60_000);
    const poller = createUsagePoller(h.deps);
    poller.start();

    const onFocus = h.listeners.get('focus') ?? [];
    expect(onFocus.length).toBe(1);
    onFocus[0]?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(h.refreshCalls()).toBe(1);
    poller.stop();
  });

  it('does not refresh on focus when the data is already fresh', async () => {
    const h = harness();
    // Fetched one second ago: looking at the window should not re-fetch.
    h.setFetchedAt(T0 - 1_000);
    const poller = createUsagePoller(h.deps);
    poller.start();
    expect(await poller.refreshNow('window-focus', 30_000)).toBe(false);
    expect(h.refreshCalls()).toBe(0);
    poller.stop();
  });

  it('refreshes on focus when nothing has ever been fetched', async () => {
    const h = harness();
    h.setFetchedAt(undefined);
    const poller = createUsagePoller(h.deps);
    poller.start();
    expect(await poller.refreshNow('window-focus', 30_000)).toBe(true);
    expect(h.refreshCalls()).toBe(1);
    poller.stop();
  });

  it('removes its window listeners on stop', () => {
    const h = harness();
    const poller = createUsagePoller(h.deps);
    poller.start();
    expect((h.listeners.get('focus') ?? []).length).toBe(1);
    poller.stop();
    expect((h.listeners.get('focus') ?? []).length).toBe(0);
  });
});

describe('createUsagePoller: failures back off', () => {
  it('doubles the delay per consecutive failure', async () => {
    const h = harness();
    h.setResult('error');
    const poller = createUsagePoller(h.deps);
    poller.start();

    await h.fire();
    expect(h.pendingDelay()).toBe(FOCUSED_INTERVAL_MS * 2);
    await h.fire();
    expect(h.pendingDelay()).toBe(FOCUSED_INTERVAL_MS * 4);
    poller.stop();
  });

  it('backs off on a thrown error too, not just a failed Result', async () => {
    const h = harness();
    h.setResult('throw');
    const poller = createUsagePoller(h.deps);
    poller.start();
    await h.fire();
    expect(h.pendingDelay()).toBe(FOCUSED_INTERVAL_MS * 2);
    poller.stop();
  });

  it('caps the backoff so a long outage still recovers', async () => {
    const h = harness();
    h.setResult('error');
    const poller = createUsagePoller(h.deps);
    poller.start();
    for (let i = 0; i < 12; i += 1) await h.fire();
    expect(h.pendingDelay()).toBe(MAX_BACKOFF_MS);
    poller.stop();
  });

  it('returns to the normal interval after a success', async () => {
    const h = harness();
    h.setResult('error');
    const poller = createUsagePoller(h.deps);
    poller.start();
    await h.fire();
    await h.fire();
    expect(h.pendingDelay()).toBeGreaterThan(FOCUSED_INTERVAL_MS);

    h.setResult('ok');
    await h.fire();
    expect(h.pendingDelay()).toBe(FOCUSED_INTERVAL_MS);
    poller.stop();
  });

  it('does not surface a background failure as a user-facing throw', async () => {
    const h = harness();
    h.setResult('throw');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const poller = createUsagePoller(h.deps);
    poller.start();
    await expect(h.fire()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    poller.stop();
  });
});
