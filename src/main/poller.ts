/**
 * Keeps the displayed usage current.
 *
 * This exists because it did not. `refreshUsage()` was called exactly once, at
 * boot, and after that the only thing that polled was the auto-switch engine's
 * own loop. Auto-switch is off by default — and cannot even start with a single
 * account — so for most users the dashboard showed the boot-time snapshot
 * forever. The age line said "read 3h ago", which was honest, but a dashboard
 * that is honest about being stale is still stale.
 *
 * Two ideas shape the cadence:
 *
 *   - **Poll for the person, not for the timer.** Quota only matters when
 *     someone is looking at it or about to be told about it. So the interval
 *     follows attention: brisk when the window is focused, slower when it is
 *     merely open, slow when it is hidden and only the tray is reading.
 *   - **Never poll twice for the same data.** When the auto-switch engine is
 *     running it already polls on its own adaptive schedule, and a second
 *     poller would double this app's API traffic for no new information. The
 *     engine wins; this one stands down and only re-arms.
 *
 * Failures back off exponentially. Anthropic's usage endpoint is rate limited
 * and a tight retry loop against a 429 is how a well-meaning dashboard gets an
 * account throttled.
 */

import type { AppServices } from './services';

/**
 * Just the window facts the cadence depends on.
 *
 * Structural rather than `BrowserWindow` so the schedule can be tested without
 * an Electron runtime; a real `BrowserWindow` satisfies it as-is.
 */
export interface PollWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  isFocused(): boolean;
  on(event: string, listener: () => void): unknown;
  removeListener(event: string, listener: () => void): unknown;
}

/** Focused and visible: someone is reading the numbers right now. */
export const FOCUSED_INTERVAL_MS = 60_000;
/** Open but in the background. */
export const VISIBLE_INTERVAL_MS = 180_000;
/** Hidden or minimised — only the tray icon and tooltip are reading. */
export const HIDDEN_INTERVAL_MS = 600_000;
/** While the auto-switch engine polls, this only re-checks that it still is. */
export const STANDBY_INTERVAL_MS = 120_000;
/** A refresh triggered by focus is skipped if the data is fresher than this. */
export const FOCUS_REFRESH_MAX_AGE_MS = 30_000;
/** Ceiling on the backoff, so a long outage still recovers within the hour. */
export const MAX_BACKOFF_MS = 900_000;

export interface UsagePollerDeps {
  services: AppServices;
  /** The live window, or null when running tray-only. */
  getWindow(): PollWindow | null;
  /** Injected for tests. */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (handle: NodeJS.Timeout) => void;
}

export interface UsagePoller {
  start(): void;
  stop(): void;
  /** Poll now unless the data is already fresh. Returns whether it polled. */
  refreshNow(reason: string, maxAgeMs?: number): Promise<boolean>;
  /** The delay the next tick is currently scheduled at, for tests and logs. */
  nextDelayMs(): number;
}

/** Age of the freshest usage reading across all accounts, or null if none. */
function freshestAge(services: AppServices, now: number): number | null {
  let newest: number | null = null;
  for (const account of services.currentState().accounts) {
    const at = account.usage?.fetchedAt;
    if (at === undefined) continue;
    if (newest === null || at > newest) newest = at;
  }
  return newest === null ? null : now - newest;
}

export function createUsagePoller(deps: UsagePollerDeps): UsagePoller {
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h));

  let handle: NodeJS.Timeout | null = null;
  let running = false;
  let inFlight = false;
  let failures = 0;
  let delay = FOCUSED_INTERVAL_MS;
  let detach: Array<() => void> = [];

  function baseInterval(): number {
    // The engine already polls; standing down is the whole point.
    if (deps.services.currentState().autoSwitchRunning) return STANDBY_INTERVAL_MS;

    const win = deps.getWindow();
    if (win === null || win.isDestroyed() || !win.isVisible() || win.isMinimized()) {
      return HIDDEN_INTERVAL_MS;
    }
    return win.isFocused() ? FOCUSED_INTERVAL_MS : VISIBLE_INTERVAL_MS;
  }

  function nextDelay(): number {
    const base = baseInterval();
    if (failures === 0) return base;
    // 2^n on top of the base, capped. A transient network blip costs one extra
    // interval; a dead endpoint settles at the ceiling instead of hammering it.
    return Math.min(base * 2 ** failures, MAX_BACKOFF_MS);
  }

  function schedule(): void {
    if (!running) return;
    if (handle !== null) clearTimer(handle);
    delay = nextDelay();
    handle = setTimer(() => void tick(), delay);
  }

  async function poll(reason: string): Promise<boolean> {
    if (inFlight) return false;
    inFlight = true;
    try {
      const result = await deps.services.refreshUsage();
      if (result.ok) {
        failures = 0;
      } else {
        failures += 1;
        // Deliberately not surfaced to the user: a failed background refresh is
        // not an event, and the age line already shows the data going stale.
        console.warn(`[claudedeck] usage refresh (${reason}) failed: ${result.error}`);
      }
      return true;
    } catch (cause) {
      failures += 1;
      console.warn(`[claudedeck] usage refresh (${reason}) threw: ${String(cause)}`);
      return true;
    } finally {
      inFlight = false;
    }
  }

  async function tick(): Promise<void> {
    if (!running) return;
    // Re-check rather than trusting the schedule: the engine may have started
    // since this tick was armed.
    if (!deps.services.currentState().autoSwitchRunning) await poll('interval');
    schedule();
  }

  async function refreshNow(reason: string, maxAgeMs = 0): Promise<boolean> {
    if (!running) return false;
    if (deps.services.currentState().autoSwitchRunning) return false;
    if (maxAgeMs > 0) {
      const age = freshestAge(deps.services, now());
      if (age !== null && age < maxAgeMs) return false;
    }
    const polled = await poll(reason);
    schedule();
    return polled;
  }

  function attachWindow(): void {
    const win = deps.getWindow();
    if (win === null || win.isDestroyed()) return;

    // Looking at the window is the strongest possible signal that the numbers
    // matter right now, so it refreshes on sight rather than waiting out the
    // interval the user cannot see.
    const onAttention = () => {
      void refreshNow('window-focus', FOCUS_REFRESH_MAX_AGE_MS);
    };
    // Losing or gaining attention also changes the cadence.
    const onBlur = () => schedule();

    win.on('focus', onAttention);
    win.on('show', onAttention);
    win.on('restore', onAttention);
    win.on('blur', onBlur);
    win.on('hide', onBlur);
    win.on('minimize', onBlur);

    detach.push(() => {
      if (win.isDestroyed()) return;
      win.removeListener('focus', onAttention);
      win.removeListener('show', onAttention);
      win.removeListener('restore', onAttention);
      win.removeListener('blur', onBlur);
      win.removeListener('hide', onBlur);
      win.removeListener('minimize', onBlur);
    });
  }

  return {
    start() {
      if (running) return;
      running = true;
      failures = 0;
      attachWindow();
      schedule();
    },

    stop() {
      running = false;
      if (handle !== null) {
        clearTimer(handle);
        handle = null;
      }
      for (const off of detach) off();
      detach = [];
    },

    refreshNow,
    nextDelayMs: () => delay,
  };
}
