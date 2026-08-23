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
import type { Account, NotificationConfig } from '@shared/types';

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
} as const;

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
        return;
      }
      latched.delete(slot);
      lastSent.delete(`threshold:${slot}`);
    },

    dispose() {
      latched.clear();
      lastSent.clear();
    },
  };
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
