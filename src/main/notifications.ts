/**
 * Native desktop notifications, filtered by `NotificationConfig` and debounced.
 *
 * Quota percentages hover: an account parked at 90.4% would otherwise fire a
 * warning on every poll, forever. So each alert latches — it fires once on the
 * way up and re-arms only after the number falls meaningfully back below the
 * line (or climbs a lot further, which is genuinely new information).
 *
 * Nothing that reaches `Notification` is allowed to contain secret material.
 * Callers pass accounts, not credentials, and `scrubSecrets` is a second net in
 * case an upstream error string carries a token in it.
 */

import { Notification } from 'electron';
import type {
  Account,
  NotificationConfig,
  PlannerConfig,
  Result,
  SessionPlan,
} from '@shared/types';
import { FIVE_HOUR_MS } from '@shared/types';
// Pure, no `electron`: the same span arithmetic the schedule editor uses, so
// "inside your peak" means exactly what the user configured it to mean.
import { spanContains } from '@core/schedule';

export interface DeckNotification {
  title: string;
  body: string;
  /** Exhaustion is worth a sound; routine threshold warnings are not. */
  urgent?: boolean;
}

export interface NotifierDeps {
  now?(): number;
  /** Injected so tests (and headless CI) can observe without a desktop session. */
  present?(notification: DeckNotification): void;
  supported?(): boolean;
}

export interface DeckNotifier {
  configure(config: NotificationConfig): void;
  /** The active account crossed `warnAtPct` on its binding window. */
  thresholdCrossed(account: Account, pct: number, windowLabel: string): void;
  /**
   * A recommended anchor is about to come due.
   *
   * Called with the current plan as often as the caller likes — once a minute is
   * the intent. Fires `PlannerConfig.remindLeadMin` ahead of an anchor, at most
   * once for each (slot, anchor) pair, so a per-minute poll cannot repeat it.
   */
  anchorDue(plan: SessionPlan, planner: PlannerConfig): void;
  switched(from: Account | undefined, to: Account, reason: string): void;
  quarantined(account: Account, reason: string): void;
  /** Every rotatable account is above threshold; there is nowhere left to go. */
  allExhausted(candidates: readonly Account[]): void;
  /** Forget the latch for one slot (or all), e.g. after a window resets. */
  rearm(slot?: number): void;
  dispose(): void;
}

/** Minimum gap between two notifications sharing a key. */
const MIN_INTERVAL_MS = {
  threshold: 10 * 60 * 1000,
  switched: 5 * 1000,
  quarantined: 60 * 60 * 1000,
  exhausted: 30 * 60 * 1000,
  anchor: 30 * 60 * 1000,
} as const;

/**
 * How late a missed anchor is still worth mentioning.
 *
 * The reminder is driven by a poll, so the lead moment can be stepped straight
 * over — the app was asleep, or the tick landed a minute after. A short grace
 * keeps the nudge useful; much beyond it the advice has expired, and telling
 * someone they should have started an hour ago is noise.
 */
const ANCHOR_GRACE_MS = 5 * 60 * 1000;

/** How often `startAnchorWatch` re-reads the plan. */
export const ANCHOR_WATCH_INTERVAL_MS = 60 * 1000;

const MINUTE_MS = 60 * 1000;

/** How far a latched percentage must fall before the warning re-arms. */
const REARM_MARGIN = 5;

/** A latched warning still re-fires if usage climbs this much further. */
const ESCALATION_STEP = 8;

const TOKEN_PATTERN = /sk-ant-[A-Za-z0-9_-]{6,}/g;

/** Belt and braces: no token shape ever reaches a notification body. */
export function scrubSecrets(text: string): string {
  return text.replace(TOKEN_PATTERN, '[redacted]');
}

/** Alias when the user set one, otherwise the address — never a token. */
export function accountLabel(account: Account): string {
  return account.alias ?? account.email;
}

export function createNotifier(
  initial: NotificationConfig,
  deps: NotifierDeps = {},
): DeckNotifier {
  const now = deps.now ?? (() => Date.now());
  const supported = deps.supported ?? (() => safeIsSupported());
  const present = deps.present ?? defaultPresent;

  let config = initial;
  /** key -> epoch ms of the last delivery. */
  const lastSent = new Map<string, number>();
  /** slot -> percentage at which the threshold warning latched. */
  const latched = new Map<number, number>();
  /**
   * slot -> the anchor instant already announced for it.
   *
   * Keyed by slot rather than by anchor so the map stays the size of the fleet
   * instead of growing by one entry per plan the app ever computed; keyed *to*
   * the instant so a genuinely new anchor can still be announced.
   */
  const announced = new Map<number, number>();

  /** Returns whether the notification actually reached the desktop. */
  function deliver(key: string, minGap: number, notification: DeckNotification): boolean {
    if (!config.enabled) return false;
    if (!supported()) return false;
    const previous = lastSent.get(key);
    const stamp = now();
    if (previous !== undefined && stamp - previous < minGap) return false;
    lastSent.set(key, stamp);
    present({
      title: scrubSecrets(notification.title),
      body: scrubSecrets(notification.body),
      urgent: notification.urgent,
    });
    return true;
  }

  return {
    configure(next) {
      // A lower threshold should be able to fire immediately rather than wait
      // out a latch set under the old, higher one.
      if (next.warnAtPct !== config.warnAtPct) latched.clear();
      config = next;
    },

    thresholdCrossed(account, pct, windowLabel) {
      const previous = latched.get(account.slot);

      if (pct < config.warnAtPct) {
        if (previous !== undefined && pct <= config.warnAtPct - REARM_MARGIN) {
          latched.delete(account.slot);
        }
        return;
      }

      const escalated = previous !== undefined && pct >= previous + ESCALATION_STEP;
      if (previous !== undefined && !escalated) return;

      const sent = deliver(`threshold:${account.slot}`, MIN_INTERVAL_MS.threshold, {
        title: `${accountLabel(account)} at ${Math.round(pct)}%`,
        body: `The ${windowLabel} window is ${Math.round(pct)}% used. ClaudeDeck will rotate at ${config.warnAtPct}% if auto-switch is on.`,
      });
      // Latch only on a delivery that happened. Advancing it after a
      // rate-limited call would swallow the escalation entirely: the user would
      // hear about 90% and never about the 99% that followed a minute later.
      if (sent) latched.set(account.slot, pct);
    },

    anchorDue(plan, planner) {
      if (!planner.enabled || !planner.remind) return;
      // A plan that recommends exactly what would happen anyway is not advice,
      // and a daily toast saying "start when you start" is how a user turns
      // notifications off for good.
      if (planIsIdle(plan)) return;

      const stamp = now();
      const lead = Math.max(0, planner.remindLeadMin) * MINUTE_MS;

      for (const account of plan.accounts) {
        const anchorAt = account.outcome.anchorAt;
        if (!Number.isFinite(anchorAt)) continue;
        if (stamp < anchorAt - lead) continue;
        if (stamp > anchorAt + ANCHOR_GRACE_MS) continue;
        if (announced.get(account.slot) === anchorAt) continue;

        // The window's own end when the simulation produced one, so the time we
        // quote is the same time the plan's timeline draws.
        const resetsAt = account.outcome.windows[0]?.end ?? anchorAt + FIVE_HOUR_MS;
        const label = account.alias ?? account.email;
        const buys = spanContains(plan.schedule.peak, minuteOfDay(resetsAt))
          ? `a fresh window at ${clock(resetsAt)}, inside your peak hours`
          : `a fresh window at ${clock(resetsAt)}`;

        const sent = deliver(`anchor:${account.slot}`, MIN_INTERVAL_MS.anchor, {
          title: `Anchor slot ${account.slot} at ${clock(anchorAt)}`,
          body: `Send your first message on ${label} (slot ${account.slot}) around ${clock(anchorAt)}. That buys ${buys} — the 5-hour window starts when you send it, not on the clock.`,
        });
        // Latch only on a delivery that happened, so a suppressed reminder is
        // retried on the next tick rather than silently lost.
        if (sent) announced.set(account.slot, anchorAt);
      }
    },

    switched(from, to, reason) {
      if (!config.onSwitch) return;
      const origin = from ? `${accountLabel(from)} -> ` : '';
      deliver(`switch:${from?.slot ?? 'none'}:${to.slot}`, MIN_INTERVAL_MS.switched, {
        title: 'Switched Claude Code account',
        body: `${origin}${accountLabel(to)} (slot ${to.slot}). ${reason}`.trim(),
      });
    },

    quarantined(account, reason) {
      if (!config.onQuarantine) return;
      deliver(`quarantine:${account.slot}`, MIN_INTERVAL_MS.quarantined, {
        title: `${accountLabel(account)} needs attention`,
        body: `Slot ${account.slot} was quarantined and will be skipped: ${reason}`,
        urgent: true,
      });
    },

    allExhausted(candidates) {
      if (!config.onExhausted) return;
      const soonest = earliestReset(candidates);
      deliver('exhausted', MIN_INTERVAL_MS.exhausted, {
        title: 'All accounts are out of headroom',
        body: soonest
          ? `${candidates.length} accounts are above the threshold. The first window resets ${soonest}.`
          : `${candidates.length} accounts are above the threshold and there is nowhere to rotate.`,
        urgent: true,
      });
    },

    rearm(slot) {
      if (slot === undefined) {
        latched.clear();
        lastSent.clear();
        announced.clear();
        return;
      }
      latched.delete(slot);
      // The anchor latch is deliberately left alone. `rearm(slot)` means "this
      // account has a fresh window", which is exactly what happens on a switch —
      // and a switch does not change where the plan wants the anchor, so
      // clearing it here would repeat the same reminder minutes later. A genuinely
      // new anchor re-arms it by itself, because the latch stores the instant.
      lastSent.delete(`threshold:${slot}`);
    },

    dispose() {
      latched.clear();
      lastSent.clear();
      announced.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Anchor reminders
// ---------------------------------------------------------------------------

export interface AnchorWatchDeps {
  notifier: DeckNotifier;
  /**
   * The plan for today. A failure is skipped in silence: a plan we could not
   * compute is not something to interrupt someone about.
   */
  plan(): Promise<Result<SessionPlan>>;
  /** Read every tick, so switching the reminder off takes effect immediately. */
  planner(): PlannerConfig;
  /** Poll cadence; `ANCHOR_WATCH_INTERVAL_MS` when omitted. */
  intervalMs?: number;
  /** Repeating timer returning its own cancel. Injected to drive tests. */
  schedule?(ms: number, fn: () => void): () => void;
}

/**
 * Drive `anchorDue` on a timer.
 *
 * A reminder is the one notification nothing else in the app would trigger:
 * every other alert hangs off a poll or a switch, but an anchor comes due
 * because the clock reached it. Returns its own stop function; call it on quit.
 */
export function startAnchorWatch(deps: AnchorWatchDeps): () => void {
  const intervalMs = deps.intervalMs ?? ANCHOR_WATCH_INTERVAL_MS;
  let inFlight = false;

  const tick = (): void => {
    // One plan at a time. Stacking simulations behind a slow disk would only
    // queue up advice that is already stale by the time it arrives.
    if (inFlight) return;
    inFlight = true;
    void deps
      .plan()
      .then((result) => {
        if (result.ok) deps.notifier.anchorDue(result.value, deps.planner());
      })
      .catch(() => {
        // Same reasoning as a failed plan: never surface this as a toast.
      })
      .finally(() => {
        inFlight = false;
      });
  };

  const cancel = (deps.schedule ?? defaultSchedule)(intervalMs, tick);
  // Checked once up front too: launching at 08:55 for a 09:00 anchor should not
  // have to wait out a whole interval to say so.
  tick();
  return cancel;
}

function defaultSchedule(ms: number, fn: () => void): () => void {
  const handle: NodeJS.Timeout = setInterval(fn, ms);
  // A reminder timer must never be the reason the process stays alive.
  handle.unref();
  return () => clearInterval(handle);
}

/**
 * True when the plan recommends nothing the user would not have done anyway:
 * every anchor sits where simply starting work would put it, and no minutes are
 * saved by it.
 */
function planIsIdle(plan: SessionPlan): boolean {
  const planned = plan.accounts[0]?.outcome;
  if (planned === undefined) return true;
  return (
    plan.peakMinutesSaved <= 0 &&
    planned.blockedWorkMin >= plan.baseline.blockedWorkMin &&
    plan.accounts.every((account) => account.outcome.anchorAt === plan.baseline.anchorAt)
  );
}

/** Minutes from local midnight, for comparing an instant against a `DaySpan`. */
function minuteOfDay(at: number): number {
  const clockAt = new Date(at);
  return clockAt.getHours() * 60 + clockAt.getMinutes();
}

/** `HH:MM` on the user's own clock, in their own locale's shape. */
function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ---------------------------------------------------------------------------
// Electron edge
// ---------------------------------------------------------------------------

function safeIsSupported(): boolean {
  try {
    return Notification.isSupported();
  } catch {
    // Notification touches the platform layer; on a headless CI box it throws.
    return false;
  }
}

function defaultPresent(notification: DeckNotification): void {
  try {
    new Notification({
      title: notification.title,
      body: notification.body,
      silent: notification.urgent !== true,
    }).show();
  } catch {
    // A failed toast must never take the app down with it.
  }
}

/** Human phrasing for the nearest reset across a set of accounts. */
function earliestReset(accounts: readonly Account[]): string | null {
  let soonest: number | null = null;
  for (const account of accounts) {
    const usage = account.usage ?? account.lastGoodUsage;
    if (!usage) continue;
    for (const window of [usage.fiveHour, usage.sevenDay, ...usage.scoped]) {
      if (!window?.resetsAt) continue;
      const at = Date.parse(window.resetsAt);
      if (Number.isNaN(at)) continue;
      if (soonest === null || at < soonest) soonest = at;
    }
  }
  if (soonest === null) return null;
  return new Date(soonest).toLocaleString();
}
