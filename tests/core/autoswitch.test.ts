/**
 * `src/core/autoswitch.ts` — the rotation decision, the poll cadence, and the
 * loop that joins them.
 *
 * `decide` is the single most consequential pure function in the app: it is
 * what rotates a user's account without being asked, so every guard around it
 * (threshold, cooldown, hysteresis, exhaustion, quarantine, API-key exclusion)
 * gets an explicit case, including the case that proves the guard can *stop* a
 * switch, not just permit one.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  BASE_POLL_FLOOR_MS,
  DEFAULT_MAX_USAGE_AGE_MS,
  ESCALATION_MARGIN_PCT,
  EXHAUSTED_POLL_MS,
  IDLE_AFTER_MS,
  IDLE_POLL_MS,
  MAX_POLL_MS,
  MIN_POLL_MS,
  PACE_CONFIDENCE_FLOOR,
  POST_429_FLOOR_MS,
  RATE_LIMIT_MEMORY_MS,
  RESET_SLACK_MS,
  allExhausted,
  createAutoSwitcher,
  decide,
  nextPollDelay,
  type AutoSwitchDeps,
  type AutoSwitchSnapshot,
  type DecideInput,
  type PollState,
} from '@core/autoswitch';
import type { Account, AutoSwitchEvent, Forecast, SwitchResult } from '@shared/types';

import {
  DAY,
  HOUR,
  MINUTE,
  T0,
  fakeClock,
  isoAt,
  makeAccount,
  makeAccounts,
  makeAutoSwitchConfig,
  makeUsage,
} from '../helpers/fixtures';

function input(over: Partial<DecideInput> = {}): DecideInput {
  return {
    accounts: [],
    activeSlot: null,
    config: makeAutoSwitchConfig(),
    now: T0,
    ...over,
  };
}

/** An active account at `pct` with a snapshot fresh as of `T0`. */
function active(slot: number, pct: number, over: Parameters<typeof makeAccount>[0] = {}): Account {
  return makeAccount({
    slot,
    active: true,
    usage: makeUsage({ fiveHourPct: pct, fetchedAt: T0 }),
    ...over,
  });
}

function idle(slot: number, pct: number, over: Parameters<typeof makeAccount>[0] = {}): Account {
  return makeAccount({ slot, usage: makeUsage({ fiveHourPct: pct, fetchedAt: T0 }), ...over });
}

// ===========================================================================
// decide()
// ===========================================================================

describe('decide', () => {
  it('holds when auto-switch is turned off', () => {
    const out = decide(input({ config: makeAutoSwitchConfig({ enabled: false }) }));
    expect(out).toEqual({ action: 'hold', reason: 'auto-switch is turned off' });
  });

  describe('with no active account', () => {
    it('adopts the first candidate as a startup switch', () => {
      const out = decide(input({ accounts: [idle(1, 10), idle(2, 5)], activeSlot: null }));
      expect(out).toEqual({ action: 'switch', target: 2, reason: 'startup' });
    });

    it('is blocked when there is nothing to adopt', () => {
      const out = decide(input({ accounts: [], activeSlot: null }));
      expect(out).toEqual({
        action: 'blocked',
        reason: 'no account is available to auto-switch to',
      });
    });

    it('is blocked when every account is disabled', () => {
      const out = decide(input({ accounts: [idle(1, 5, { disabled: true })] }));
      expect(out.action).toBe('blocked');
      expect(out.reason).toContain('no account is available');
    });
  });

  describe('the threshold trigger', () => {
    it('holds below the threshold and names the binding window', () => {
      const out = decide(input({ accounts: [active(1, 40), idle(2, 5)], activeSlot: 1 }));
      expect(out.action).toBe('hold');
      expect(out.reason).toContain('40%');
      expect(out.reason).toContain('5h');
      expect(out.reason).toContain('under the 80% threshold');
    });

    it('fires at exactly the threshold', () => {
      const out = decide(input({ accounts: [active(1, 80), idle(2, 5)], activeSlot: 1 }));
      expect(out).toEqual({ action: 'switch', target: 2, reason: 'threshold' });
    });

    it('holds one point under', () => {
      expect(decide(input({ accounts: [active(1, 79), idle(2, 5)], activeSlot: 1 })).action).toBe(
        'hold',
      );
    });

    it.each([
      ['a threshold of 0 is clamped up to 1', 0, 1, 'switch'],
      ['a threshold of 0 still holds at 0%', 0, 0, 'hold'],
      ['a threshold above 100 is clamped down', 500, 100, 'switch'],
      ['a clamped 100 threshold holds at 99', 500, 99, 'hold'],
    ])('%s', (_label, threshold, pct, expected) => {
      const out = decide(
        input({
          accounts: [active(1, pct), idle(2, 0)],
          activeSlot: 1,
          config: makeAutoSwitchConfig({ threshold, hysteresisMargin: 0 }),
        }),
      );
      expect(out.action).toBe(expected);
    });

    it('gates on a per-model window when the config names one', () => {
      const accounts = [
        makeAccount({
          slot: 1,
          active: true,
          usage: makeUsage({ fiveHourPct: 5, scoped: [{ key: 'Fable', pct: 95 }], fetchedAt: T0 }),
        }),
        idle(2, 1),
      ];
      expect(decide(input({ accounts, activeSlot: 1 })).action).toBe('hold');
      expect(
        decide(
          input({
            accounts,
            activeSlot: 1,
            config: makeAutoSwitchConfig({ models: ['Fable'] }),
          }),
        ).action,
      ).toBe('switch');
    });
  });

  describe('data freshness', () => {
    it('holds when the active account has never been polled', () => {
      const out = decide(input({ accounts: [makeAccount({ slot: 1, active: true }), idle(2, 5)], activeSlot: 1 }));
      expect(out.action).toBe('hold');
      expect(out.reason).toContain('no usage data for slot 1');
    });

    it('refuses to act on a snapshot older than the freshness bound', () => {
      const stale = makeAccount({
        slot: 1,
        active: true,
        usage: makeUsage({ fiveHourPct: 99, fetchedAt: T0 - DEFAULT_MAX_USAGE_AGE_MS - 1 }),
      });
      const out = decide(input({ accounts: [stale, idle(2, 5)], activeSlot: 1 }));

      expect(out.action).toBe('hold');
      expect(out.reason).toContain('waiting for a fresh reading');
    });

    it('acts on a snapshot right at the bound', () => {
      const account = makeAccount({
        slot: 1,
        active: true,
        usage: makeUsage({ fiveHourPct: 99, fetchedAt: T0 - DEFAULT_MAX_USAGE_AGE_MS }),
      });
      expect(decide(input({ accounts: [account, idle(2, 5)], activeSlot: 1 })).action).toBe('switch');
    });

    it('honours an overridden freshness bound', () => {
      const account = makeAccount({
        slot: 1,
        active: true,
        usage: makeUsage({ fiveHourPct: 99, fetchedAt: T0 - HOUR }),
      });
      const base = { accounts: [account, idle(2, 5)], activeSlot: 1 };
      expect(decide(input({ ...base, maxUsageAgeMs: 2 * HOUR })).action).toBe('switch');
      expect(decide(input({ ...base, maxUsageAgeMs: MINUTE })).action).toBe('hold');
    });

    it('applies a fresher per-slot usage override', () => {
      const stale = makeAccount({
        slot: 1,
        active: true,
        usage: makeUsage({ fiveHourPct: 5, fetchedAt: T0 - HOUR }),
      });
      const out = decide(
        input({
          accounts: [stale, idle(2, 5)],
          activeSlot: 1,
          usage: { 1: makeUsage({ fiveHourPct: 95, fetchedAt: T0 }) },
        }),
      );
      expect(out).toEqual({ action: 'switch', target: 2, reason: 'threshold' });
    });

    it('leaves accounts alone when the override map has no entry for them', () => {
      const out = decide(
        input({
          accounts: [active(1, 20), idle(2, 5)],
          activeSlot: 1,
          usage: { 9: makeUsage({ fiveHourPct: 99 }) },
        }),
      );
      expect(out.action).toBe('hold');
    });
  });

  describe('exhaustion and quarantine', () => {
    it('switches away from an out-of-quota incumbent', () => {
      const out = decide(input({ accounts: [active(1, 100), idle(2, 5)], activeSlot: 1 }));
      expect(out).toEqual({ action: 'switch', target: 2, reason: 'threshold' });
    });

    it('switches away from a quarantined incumbent', () => {
      const out = decide(
        input({ accounts: [active(1, 10, { quarantinedAt: T0 - HOUR }), idle(2, 5)], activeSlot: 1 }),
      );
      expect(out).toEqual({ action: 'switch', target: 2, reason: 'quarantine' });
    });

    it('switches away from an incumbent whose status says quarantined', () => {
      const out = decide(
        input({ accounts: [active(1, 10, { usageStatus: 'quarantined' }), idle(2, 5)], activeSlot: 1 }),
      );
      expect(out.action).toBe('switch');
      expect(out).toMatchObject({ reason: 'quarantine' });
    });

    it('reports all-exhausted with the earliest recovery instant', () => {
      const accounts = [
        makeAccount({
          slot: 1,
          active: true,
          usage: makeUsage({ fiveHourPct: 100, fiveHourResetsAt: isoAt(3 * HOUR), fetchedAt: T0 }),
        }),
        makeAccount({
          slot: 2,
          usage: makeUsage({ fiveHourPct: 100, fiveHourResetsAt: isoAt(90 * MINUTE), fetchedAt: T0 }),
        }),
      ];
      const out = decide(input({ accounts, activeSlot: 1 }));

      expect(out.action).toBe('blocked');
      expect(out.reason).toContain('all 2 eligible accounts are out of quota');
      expect(out.reason).toContain('in 1h 30m');
    });

    it.each([
      ['minutes out', 45 * MINUTE, 'in 45m'],
      ['hours out', 3 * HOUR + 20 * MINUTE, 'in 3h 20m'],
      ['days out', 2 * DAY + 5 * HOUR, 'in 2d 5h'],
    ])('humanizes a recovery %s', (_label, offset, expected) => {
      const accounts = [
        makeAccount({
          slot: 1,
          active: true,
          usage: makeUsage({ fiveHourPct: 100, fiveHourResetsAt: isoAt(offset), fetchedAt: T0 }),
        }),
      ];
      expect(decide(input({ accounts, activeSlot: 1 })).reason).toContain(expected);
    });

    it('says so plainly when no reset instant was reported', () => {
      const accounts = [active(1, 100), idle(2, 100)];
      const out = decide(input({ accounts, activeSlot: 1 }));
      expect(out.reason).toContain('no reset time reported');
    });

    it('ignores a reset instant already in the past', () => {
      const accounts = [
        makeAccount({
          slot: 1,
          active: true,
          usage: makeUsage({ fiveHourPct: 100, fiveHourResetsAt: isoAt(-HOUR), fetchedAt: T0 }),
        }),
      ];
      expect(decide(input({ accounts, activeSlot: 1 })).reason).toContain('no reset time reported');
    });

    it('holds — rather than blocking — when the incumbent is merely over the threshold', () => {
      const out = decide(input({ accounts: [active(1, 85)], activeSlot: 1 }));
      expect(out.action).toBe('hold');
      expect(out.reason).toContain('no other account is eligible');
    });
  });

  describe('who is eligible', () => {
    it('never rotates onto a disabled account', () => {
      const out = decide(
        input({ accounts: [active(1, 95), idle(2, 1, { disabled: true }), idle(3, 50)], activeSlot: 1 }),
      );
      expect(out).toMatchObject({ action: 'switch', target: 3 });
    });

    it('never rotates onto a quarantined account', () => {
      const out = decide(
        input({
          accounts: [active(1, 95), idle(2, 1, { quarantinedAt: T0 }), idle(3, 50)],
          activeSlot: 1,
        }),
      );
      expect(out).toMatchObject({ action: 'switch', target: 3 });
    });

    it('never rotates onto an exhausted account', () => {
      const out = decide(
        input({ accounts: [active(1, 95), idle(2, 100), idle(3, 50)], activeSlot: 1 }),
      );
      expect(out).toMatchObject({ action: 'switch', target: 3 });
    });

    it('excludes api-key accounts by default — rotating onto one changes billing', () => {
      const out = decide(
        input({ accounts: [active(1, 95), makeAccount({ slot: 2, kind: 'api-key' })], activeSlot: 1 }),
      );
      // The incumbent is over the threshold but still usable, so this is a
      // hold ("nowhere better to go"), not the harder `blocked` verdict.
      expect(out.action).toBe('hold');
      expect(out.reason).toContain('no other account is eligible');
    });

    it('includes api-key accounts when the config opts in, ranking them wide open', () => {
      const out = decide(
        input({
          accounts: [active(1, 95), idle(2, 60), makeAccount({ slot: 3, kind: 'api-key' })],
          activeSlot: 1,
          config: makeAutoSwitchConfig({ includeApiKeyAccounts: true }),
        }),
      );
      expect(out).toMatchObject({ action: 'switch', target: 3 });
    });

    it('holds without complaint when the incumbent itself is an api-key account', () => {
      const out = decide(
        input({
          accounts: [makeAccount({ slot: 1, kind: 'api-key', active: true }), idle(2, 5)],
          activeSlot: 1,
        }),
      );
      expect(out.action).toBe('hold');
      expect(out.reason).toContain('no quota to watch');
    });
  });

  describe('the cooldown', () => {
    const recentlySwitched = {
      accounts: [active(1, 95), idle(2, 5)],
      activeSlot: 1,
      config: makeAutoSwitchConfig({ cooldownSec: 300 }),
    };

    it('suppresses a proactive switch inside the window and says how long is left', () => {
      const out = decide(input({ ...recentlySwitched, lastSwitchAt: T0 - 2 * MINUTE }));
      expect(out.action).toBe('hold');
      expect(out.reason).toContain('300s cooldown');
      expect(out.reason).toContain('180s left');
    });

    it('allows the switch once the window has elapsed', () => {
      const out = decide(input({ ...recentlySwitched, lastSwitchAt: T0 - 300_000 }));
      expect(out.action).toBe('switch');
    });

    it('allows the switch when there was no previous one', () => {
      expect(decide(input({ ...recentlySwitched, lastSwitchAt: null })).action).toBe('switch');
      expect(decide(input(recentlySwitched)).action).toBe('switch');
    });

    it('is skipped for an exhausted incumbent — there is nothing to flap between', () => {
      const out = decide(
        input({
          accounts: [active(1, 100), idle(2, 5)],
          activeSlot: 1,
          lastSwitchAt: T0 - 1000,
          config: makeAutoSwitchConfig({ cooldownSec: 3600 }),
        }),
      );
      expect(out).toEqual({ action: 'switch', target: 2, reason: 'threshold' });
    });

    it('is skipped for a quarantined incumbent', () => {
      const out = decide(
        input({
          accounts: [active(1, 10, { quarantinedAt: T0 }), idle(2, 5)],
          activeSlot: 1,
          lastSwitchAt: T0 - 1000,
          config: makeAutoSwitchConfig({ cooldownSec: 3600 }),
        }),
      );
      expect(out.action).toBe('switch');
    });

    it('treats a negative cooldown as zero', () => {
      const out = decide(
        input({
          ...recentlySwitched,
          lastSwitchAt: T0 - 1,
          config: makeAutoSwitchConfig({ cooldownSec: -60 }),
        }),
      );
      expect(out.action).toBe('switch');
    });
  });

  describe('hysteresis, the anti-flap rule', () => {
    it('refuses a candidate that does not beat the incumbent by the margin', () => {
      // Incumbent 85% used -> 15 headroom. Candidate 78% used -> 22 headroom.
      // The 7-point gain is under the 10-point margin.
      const out = decide(
        input({
          accounts: [active(1, 85), idle(2, 78)],
          activeSlot: 1,
          config: makeAutoSwitchConfig({ threshold: 80, hysteresisMargin: 10 }),
        }),
      );
      expect(out.action).toBe('hold');
      expect(out.reason).toContain('10-point margin');
      expect(out.reason).toContain('slot 2');
    });

    it('accepts a candidate that clears the margin exactly', () => {
      // 15 headroom vs 25 headroom: exactly ten points better.
      const out = decide(
        input({
          accounts: [active(1, 85), idle(2, 75)],
          activeSlot: 1,
          config: makeAutoSwitchConfig({ threshold: 80, hysteresisMargin: 10 }),
        }),
      );
      expect(out).toMatchObject({ action: 'switch', target: 2 });
    });

    it('refuses a candidate that is itself at or over the threshold', () => {
      // 100 headroom would clear the margin easily, but the candidate is at
      // 82% — landing there would trip the threshold on the next poll.
      const out = decide(
        input({
          accounts: [active(1, 95), idle(2, 82)],
          activeSlot: 1,
          config: makeAutoSwitchConfig({ threshold: 80, hysteresisMargin: 0 }),
        }),
      );
      expect(out.action).toBe('hold');
    });

    it('does not flap between two accounts hovering either side of the line', () => {
      const a = active(1, 81);
      const b = idle(2, 79);
      const config = makeAutoSwitchConfig({ threshold: 80, hysteresisMargin: 10 });

      // Slot 1 is over the line but slot 2 is only two points better.
      expect(decide(input({ accounts: [a, b], activeSlot: 1, config })).action).toBe('hold');
      // And the mirror image also holds, so no cycle is possible.
      const flipped = [makeAccount({ ...a, active: false }), makeAccount({ ...b, active: true })];
      expect(decide(input({ accounts: flipped, activeSlot: 2, config })).action).toBe('hold');
    });

    it('drops the margin requirement for a reactive switch', () => {
      // Incumbent is spent, so any usable account beats it.
      const out = decide(
        input({
          accounts: [active(1, 100), idle(2, 79)],
          activeSlot: 1,
          config: makeAutoSwitchConfig({ threshold: 80, hysteresisMargin: 40 }),
        }),
      );
      expect(out).toMatchObject({ action: 'switch', target: 2 });
    });

    it('treats a negative margin as zero', () => {
      const out = decide(
        input({
          accounts: [active(1, 85), idle(2, 84)],
          activeSlot: 1,
          config: makeAutoSwitchConfig({ threshold: 90, hysteresisMargin: -50 }),
        }),
      );
      // Still under the 90 threshold, so no trigger at all.
      expect(out.action).toBe('hold');
    });

    it('lets an unpolled candidate through on its neutral score', () => {
      const out = decide(
        input({
          accounts: [active(1, 95), makeAccount({ slot: 2 })],
          activeSlot: 1,
          config: makeAutoSwitchConfig({ threshold: 80, hysteresisMargin: 10 }),
        }),
      );
      // 5 headroom vs a neutral 50: clears the margin, and 50% used is under
      // the threshold.
      expect(out).toMatchObject({ action: 'switch', target: 2 });
    });
  });

  describe('the pace trigger', () => {
    const paceForecast = (over: Partial<Forecast> = {}): Forecast => ({
      windowKey: '5h',
      burn: { pctPerHour: 30, samples: 8, confidence: 0.9 },
      exhaustionAt: isoAt(HOUR),
      lastsToReset: false,
      aheadOfPace: true,
      ...over,
    });

    it('fires below the threshold when a confident forecast says the window dies first', () => {
      const out = decide(
        input({
          accounts: [active(1, 40), idle(2, 5)],
          activeSlot: 1,
          activeForecast: paceForecast(),
        }),
      );
      expect(out).toEqual({ action: 'switch', target: 2, reason: 'pace' });
    });

    it.each([
      ['confidence below the floor', { burn: { pctPerHour: 30, samples: 3, confidence: PACE_CONFIDENCE_FLOOR - 0.01 } }],
      ['no projected exhaustion', { exhaustionAt: null }],
      ['a window that survives to its reset', { lastsToReset: true }],
    ])('does not fire on %s', (_label, over) => {
      const out = decide(
        input({
          accounts: [active(1, 40), idle(2, 5)],
          activeSlot: 1,
          activeForecast: paceForecast(over as Partial<Forecast>),
        }),
      );
      expect(out.action).toBe('hold');
    });

    it('does not fire without a forecast at all', () => {
      expect(decide(input({ accounts: [active(1, 40), idle(2, 5)], activeSlot: 1 })).action).toBe(
        'hold',
      );
    });

    it('still respects the cooldown', () => {
      const out = decide(
        input({
          accounts: [active(1, 40), idle(2, 5)],
          activeSlot: 1,
          activeForecast: paceForecast(),
          lastSwitchAt: T0 - MINUTE,
          config: makeAutoSwitchConfig({ cooldownSec: 600 }),
        }),
      );
      expect(out.action).toBe('hold');
      expect(out.reason).toContain('cooldown');
    });
  });

  it('finds the incumbent through the `active` flag when activeSlot is null', () => {
    const out = decide(input({ accounts: [active(1, 95), idle(2, 5)], activeSlot: null }));
    expect(out).toMatchObject({ action: 'switch', target: 2 });
  });

  it('falls back to the flag when activeSlot names a slot that is gone', () => {
    const out = decide(input({ accounts: [active(1, 95), idle(2, 5)], activeSlot: 99 }));
    expect(out).toMatchObject({ action: 'switch', target: 2 });
  });

  it.each(['next', 'best', 'next-available', 'consume-first'] as const)(
    'never picks an exhausted account under strategy %s',
    (strategy) => {
      const out = decide(
        input({
          accounts: [active(1, 100), idle(2, 100), idle(3, 20)],
          activeSlot: 1,
          config: makeAutoSwitchConfig({ strategy }),
        }),
      );
      expect(out).toMatchObject({ action: 'switch', target: 3 });
    },
  );
});

// ===========================================================================

describe('allExhausted', () => {
  const config = makeAutoSwitchConfig();

  it.each([
    ['an empty list', [], false],
    ['a healthy account', [idle(1, 10)], false],
    ['one spent and one healthy', [idle(1, 100), idle(2, 10)], false],
    ['every account spent', [idle(1, 100), idle(2, 105)], true],
    ['a quarantined account counts as spent', [makeAccount({ slot: 1, quarantinedAt: T0 })], true],
    ['only disabled accounts', [idle(1, 100, { disabled: true })], false],
  ])('%s -> %s', (_label, accounts, expected) => {
    expect(allExhausted(accounts as Account[], config)).toBe(expected);
  });

  it('ignores disabled accounts when judging the rest', () => {
    const accounts = [idle(1, 100), idle(2, 5, { disabled: true })];
    expect(allExhausted(accounts, config)).toBe(true);
  });

  it('ignores api-key accounts unless they are opted in', () => {
    const accounts = [idle(1, 100), makeAccount({ slot: 2, kind: 'api-key' })];
    expect(allExhausted(accounts, config)).toBe(true);
    // Opted in, the api-key account is never exhausted, so the answer flips.
    expect(allExhausted(accounts, makeAutoSwitchConfig({ includeApiKeyAccounts: true }))).toBe(false);
  });
});

// ===========================================================================
// nextPollDelay()
// ===========================================================================

describe('nextPollDelay', () => {
  const config = makeAutoSwitchConfig({ threshold: 80, pollIntervalSec: 300 });

  function state(over: Partial<PollState> = {}): PollState {
    return { accounts: [], activeSlot: null, ...over };
  }

  it('uses the configured interval when nothing special is happening', () => {
    expect(nextPollDelay(state(), config, T0)).toBe(300_000);
  });

  it.each([
    ['a zero interval', 0, BASE_POLL_FLOOR_MS],
    ['a tiny interval', 5, BASE_POLL_FLOOR_MS],
    ['a negative interval', -100, BASE_POLL_FLOOR_MS],
    ['a huge interval', 999_999, MAX_POLL_MS],
  ])('clamps %s to the API budget', (_label, pollIntervalSec, expected) => {
    expect(nextPollDelay(state(), makeAutoSwitchConfig({ pollIntervalSec }), T0)).toBe(expected);
  });

  describe('backoff', () => {
    it.each([
      [1, 600_000],
      [2, 1_200_000],
      [3, MAX_POLL_MS],
      [10, MAX_POLL_MS],
    ])('doubles for %d consecutive errors', (consecutiveErrors, expected) => {
      expect(nextPollDelay(state({ consecutiveErrors }), config, T0)).toBe(expected);
    });

    it('is never shorter than the post-429 floor while a 429 is remembered', () => {
      const delay = nextPollDelay(
        state({ lastRateLimitAt: T0 - MINUTE }),
        makeAutoSwitchConfig({ pollIntervalSec: 180 }),
        T0,
      );
      expect(delay).toBe(POST_429_FLOOR_MS);
    });

    it('honours a longer Retry-After', () => {
      const delay = nextPollDelay(
        state({ lastRateLimitAt: T0, retryAfterSec: 900 }),
        config,
        T0,
      );
      expect(delay).toBe(900_000);
    });

    it('forgets a 429 once it ages out of the memory window', () => {
      const stale = state({ lastRateLimitAt: T0 - RATE_LIMIT_MEMORY_MS });
      expect(nextPollDelay(stale, config, T0)).toBe(300_000);
    });
  });

  describe('cadence for the active account', () => {
    it('escalates to the minimum interval near the threshold', () => {
      const near = active(1, 80 - ESCALATION_MARGIN_PCT);
      expect(nextPollDelay(state({ accounts: [near], activeSlot: 1 }), config, T0)).toBe(MIN_POLL_MS);
    });

    it('stays at the base interval just outside the escalation margin', () => {
      const far = active(1, 80 - ESCALATION_MARGIN_PCT - 1);
      expect(nextPollDelay(state({ accounts: [far], activeSlot: 1 }), config, T0)).toBe(300_000);
    });

    it('slows right down for an exhausted active account', () => {
      const spent = makeAccount({
        slot: 1,
        active: true,
        usage: makeUsage({ fiveHourPct: 100, fetchedAt: T0 }),
      });
      expect(nextPollDelay(state({ accounts: [spent], activeSlot: 1 }), config, T0)).toBe(
        EXHAUSTED_POLL_MS,
      );
    });

    it.each([
      ['the idle flag', { idle: true }],
      ['no movement for a long time', { lastChangeAt: T0 - IDLE_AFTER_MS - 1 }],
    ])('backs off to the idle interval given %s', (_label, over) => {
      const delay = nextPollDelay(
        state({ accounts: [active(1, 10)], activeSlot: 1, ...over }),
        config,
        T0,
      );
      expect(delay).toBe(IDLE_POLL_MS);
    });

    it('does not escalate while an error backoff is in force', () => {
      const near = active(1, 79);
      const delay = nextPollDelay(
        state({ accounts: [near], activeSlot: 1, consecutiveErrors: 2 }),
        config,
        T0,
      );
      // Safety wins: the backoff is not undone by "watch this closely".
      expect(delay).toBe(1_200_000);
    });

    it('does not escalate while rate limited', () => {
      const near = active(1, 79);
      const delay = nextPollDelay(
        state({ accounts: [near], activeSlot: 1, lastRateLimitAt: T0 }),
        config,
        T0,
      );
      expect(delay).toBe(POST_429_FLOOR_MS);
    });
  });

  describe('waking for a reset', () => {
    it('never sleeps past a reset it already knows about', () => {
      const account = makeAccount({
        slot: 1,
        active: true,
        usage: makeUsage({ fiveHourPct: 10, fiveHourResetsAt: isoAt(4 * MINUTE), fetchedAt: T0 }),
      });
      expect(nextPollDelay(state({ accounts: [account], activeSlot: 1 }), config, T0)).toBe(
        4 * MINUTE + RESET_SLACK_MS,
      );
    });

    it('watches an exhausted non-active account for its recovery', () => {
      const accounts = [
        active(1, 10),
        makeAccount({
          slot: 2,
          usage: makeUsage({ fiveHourPct: 100, fiveHourResetsAt: isoAt(3 * MINUTE), fetchedAt: T0 }),
        }),
      ];
      expect(nextPollDelay(state({ accounts, activeSlot: 1 }), config, T0)).toBe(
        3 * MINUTE + RESET_SLACK_MS,
      );
    });

    it('ignores an unrelated healthy account’s reset', () => {
      const accounts = [
        active(1, 10),
        makeAccount({
          slot: 2,
          usage: makeUsage({ fiveHourPct: 5, fiveHourResetsAt: isoAt(MINUTE), fetchedAt: T0 }),
        }),
      ];
      expect(nextPollDelay(state({ accounts, activeSlot: 1 }), config, T0)).toBe(300_000);
    });

    it.each([
      ['a reset in the past', isoAt(-HOUR)],
      ['an unparseable reset', 'whenever'],
    ])('ignores %s', (_label, resetsAt) => {
      const account = makeAccount({
        slot: 1,
        active: true,
        usage: makeUsage({ fiveHourPct: 10, fiveHourResetsAt: resetsAt, fetchedAt: T0 }),
      });
      expect(nextPollDelay(state({ accounts: [account], activeSlot: 1 }), config, T0)).toBe(300_000);
    });

    it('never wakes into a blocked endpoint below the 429 floor', () => {
      const account = makeAccount({
        slot: 1,
        active: true,
        usage: makeUsage({ fiveHourPct: 10, fiveHourResetsAt: isoAt(MINUTE), fetchedAt: T0 }),
      });
      const delay = nextPollDelay(
        state({ accounts: [account], activeSlot: 1, lastRateLimitAt: T0 }),
        config,
        T0,
      );
      expect(delay).toBe(POST_429_FLOOR_MS);
    });
  });

  it('always lands inside the hard bounds', () => {
    const permutations: PollState[] = [
      state(),
      state({ consecutiveErrors: 50 }),
      state({ lastRateLimitAt: T0, retryAfterSec: 100_000 }),
      state({ accounts: [active(1, 99)], activeSlot: 1, idle: true }),
      state({
        accounts: [
          makeAccount({
            slot: 1,
            active: true,
            usage: makeUsage({ fiveHourPct: 50, fiveHourResetsAt: isoAt(1), fetchedAt: T0 }),
          }),
        ],
        activeSlot: 1,
      }),
    ];
    for (const s of permutations) {
      const delay = nextPollDelay(s, config, T0);
      expect(delay).toBeGreaterThanOrEqual(MIN_POLL_MS);
      expect(delay).toBeLessThanOrEqual(MAX_POLL_MS);
    }
  });
});

// ===========================================================================
// createAutoSwitcher()
// ===========================================================================

interface LoopHarness {
  deps: AutoSwitchDeps;
  events: AutoSwitchEvent[];
  switches: unknown[];
  scheduled: Array<{ ms: number; fn: () => void }>;
  clock: ReturnType<typeof fakeClock>;
  /** Run the most recently scheduled callback. */
  fire(): void;
}

function loopHarness(over: Partial<AutoSwitchDeps> = {}, snap?: Partial<AutoSwitchSnapshot>): LoopHarness {
  const clock = fakeClock();
  const events: AutoSwitchEvent[] = [];
  const switches: unknown[] = [];
  const scheduled: Array<{ ms: number; fn: () => void }> = [];

  const snapshot: AutoSwitchSnapshot = {
    accounts: [active(1, 95), idle(2, 5)],
    activeSlot: 1,
    config: makeAutoSwitchConfig(),
    ...snap,
  };

  const deps: AutoSwitchDeps = {
    now: clock.now,
    schedule(ms, fn) {
      const entry = { ms, fn };
      scheduled.push(entry);
      return () => {
        const i = scheduled.indexOf(entry);
        if (i >= 0) scheduled.splice(i, 1);
      };
    },
    async snapshot() {
      return snapshot;
    },
    async pollUsage() {
      return { ok: true, accounts: snapshot.accounts };
    },
    async performSwitch(req) {
      switches.push(req);
      const result: SwitchResult = {
        switched: true,
        dryRun: false,
        reason: 'ok',
        to: { slot: Number(req.target), email: 'x@y.test' },
      };
      return result;
    },
    emit: (e) => events.push(e),
    ...over,
  };

  return {
    deps,
    events,
    switches,
    scheduled,
    clock,
    fire(): void {
      const next = scheduled.pop();
      next?.fn();
    },
  };
}

const kinds = (events: AutoSwitchEvent[]): string[] => events.map((e) => e.kind);

describe('createAutoSwitcher', () => {
  it('polls, decides and switches in one cycle', async () => {
    const h = loopHarness();
    await createAutoSwitcher(h.deps).runOnce();

    expect(h.switches).toEqual([{ target: 2, reason: 'threshold', strategy: 'best' }]);
    expect(kinds(h.events)).toEqual(['poll', 'switch']);
    expect(h.events[0]?.message).toContain('slot 1 at 95%');
  });

  it('reports a hold as a no-switch event with the reason', async () => {
    const h = loopHarness({}, { accounts: [active(1, 10), idle(2, 5)] });
    await createAutoSwitcher(h.deps).runOnce();

    expect(h.switches).toEqual([]);
    expect(kinds(h.events)).toEqual(['poll', 'no-switch']);
    expect(h.events[1]?.message).toContain('under the 80% threshold');
  });

  it('short-circuits when auto-switch is disabled, without polling', async () => {
    const pollUsage = vi.fn(async () => ({ ok: true as const, accounts: [] }));
    const h = loopHarness({ pollUsage }, { config: makeAutoSwitchConfig({ enabled: false }) });

    await createAutoSwitcher(h.deps).runOnce();

    expect(pollUsage).not.toHaveBeenCalled();
    expect(kinds(h.events)).toEqual(['no-switch']);
  });

  it('holds on the last known numbers when the poll fails', async () => {
    const h = loopHarness({ pollUsage: async () => ({ ok: false, error: 'offline' }) });
    await createAutoSwitcher(h.deps).runOnce();

    expect(h.switches).toEqual([]);
    expect(kinds(h.events)).toEqual(['error']);
    expect(h.events[0]?.message).toContain('holding on the last known numbers');
    expect(h.events[0]?.detail).toEqual({ consecutiveErrors: 1 });
  });

  it('treats a throwing poll the same as a failed one', async () => {
    const h = loopHarness({
      pollUsage: async () => {
        throw new Error('socket hang up');
      },
    });
    await createAutoSwitcher(h.deps).runOnce();

    expect(kinds(h.events)).toEqual(['error']);
    expect(h.events[0]?.message).toContain('socket hang up');
  });

  it('reports a failed snapshot without polling or switching', async () => {
    const pollUsage = vi.fn(async () => ({ ok: true as const, accounts: [] }));
    const h = loopHarness({
      pollUsage,
      snapshot: async () => {
        throw new Error('vault unreadable');
      },
    });
    await createAutoSwitcher(h.deps).runOnce();

    expect(pollUsage).not.toHaveBeenCalled();
    expect(kinds(h.events)).toEqual(['error']);
    expect(h.events[0]?.message).toContain('vault unreadable');
  });

  it('logs a dry run instead of acting on it', async () => {
    const h = loopHarness({}, { config: makeAutoSwitchConfig({ dryRun: true }) });
    await createAutoSwitcher(h.deps).runOnce();

    expect(h.switches).toEqual([]);
    expect(kinds(h.events)).toEqual(['poll', 'no-switch']);
    expect(h.events[1]?.message).toContain('dry run: would switch to slot 2');
  });

  it('raises all-exhausted rather than a bare block when nothing is usable', async () => {
    const accounts = [active(1, 100), idle(2, 100)];
    const h = loopHarness({ pollUsage: async () => ({ ok: true, accounts }) }, { accounts });

    await createAutoSwitcher(h.deps).runOnce();
    expect(kinds(h.events)).toEqual(['poll', 'all-exhausted']);
  });

  it('raises a plain block, not all-exhausted, when nothing is even managed', async () => {
    // Every account is held out of rotation, so there is nothing to call
    // exhausted — the user needs "nowhere to go", not "you are out of quota".
    const accounts = [idle(1, 5, { disabled: true }), idle(2, 5, { disabled: true })];
    const h = loopHarness({ pollUsage: async () => ({ ok: true, accounts }) }, {
      accounts,
      activeSlot: null,
    });

    await createAutoSwitcher(h.deps).runOnce();

    expect(kinds(h.events)).toEqual(['poll', 'blocked']);
    expect(h.events[1]?.message).toContain('no account is available');
  });

  it('reports a switch that threw', async () => {
    const h = loopHarness({
      performSwitch: async () => {
        throw new Error('lock wedged');
      },
    });
    await createAutoSwitcher(h.deps).runOnce();

    expect(kinds(h.events)).toEqual(['poll', 'error']);
    expect(h.events[1]?.message).toContain('lock wedged');
  });

  it('reports a switch that declined to happen', async () => {
    const h = loopHarness({
      performSwitch: async () => ({
        switched: false,
        dryRun: false,
        reason: 'target vanished',
        error: 'no stored credential',
      }),
    });
    await createAutoSwitcher(h.deps).runOnce();

    expect(kinds(h.events)).toEqual(['poll', 'error']);
    expect(h.events[1]?.message).toBe('no stored credential');
  });

  it('reports a degraded success as a switch plus an error', async () => {
    const h = loopHarness({
      performSwitch: async () => ({
        switched: true,
        dryRun: false,
        reason: 'ok',
        error: 'the global config still names the old account',
      }),
    });
    await createAutoSwitcher(h.deps).runOnce();

    expect(kinds(h.events)).toEqual(['poll', 'switch', 'error']);
  });

  it('applies its own cooldown across consecutive cycles', async () => {
    const h = loopHarness({}, { config: makeAutoSwitchConfig({ cooldownSec: 600 }) });
    const engine = createAutoSwitcher(h.deps);

    await engine.runOnce();
    expect(h.switches).toHaveLength(1);

    // Same numbers, one minute later: the cooldown the engine just started
    // must suppress the second rotation.
    h.clock.advance(MINUTE);
    h.events.length = 0;
    await engine.runOnce();

    expect(h.switches).toHaveLength(1);
    expect(h.events[1]?.message).toContain('cooldown');
  });

  describe('start / stop', () => {
    it('runs immediately and then reschedules on the adaptive cadence', async () => {
      const h = loopHarness();
      const engine = createAutoSwitcher(h.deps);

      engine.start();
      expect(engine.isRunning()).toBe(true);
      expect(h.scheduled).toHaveLength(1);
      expect(h.scheduled[0]?.ms).toBe(0);

      h.fire();
      await engine.runOnce();
      await Promise.resolve();
      await Promise.resolve();

      expect(h.scheduled.length).toBeGreaterThan(0);
      expect(h.scheduled.at(-1)?.ms).toBeGreaterThanOrEqual(MIN_POLL_MS);
      engine.stop();
    });

    it('is idempotent and cancels the pending timer on stop', () => {
      const h = loopHarness();
      const engine = createAutoSwitcher(h.deps);

      engine.start();
      engine.start();
      expect(h.scheduled).toHaveLength(1);

      engine.stop();
      expect(engine.isRunning()).toBe(false);
      expect(h.scheduled).toHaveLength(0);

      engine.stop();
      expect(kinds(h.events)).toEqual(['poll', 'no-switch']);
    });

    it('does nothing on stop when it was never started', () => {
      const h = loopHarness();
      createAutoSwitcher(h.deps).stop();
      expect(h.events).toEqual([]);
    });

    it('falls back to real timers when no scheduler is injected', () => {
      const h = loopHarness();
      const { schedule: _omitted, ...rest } = h.deps;
      const engine = createAutoSwitcher(rest);

      engine.start();
      expect(engine.isRunning()).toBe(true);
      // Cancelling the pending `setTimeout` must not leave the process alive.
      engine.stop();
      expect(engine.isRunning()).toBe(false);
    });
  });

  it('every event carries the injected clock, not the wall clock', async () => {
    const h = loopHarness();
    await createAutoSwitcher(h.deps).runOnce();
    for (const event of h.events) expect(event.ts).toBe(T0);
  });

  it('describes an account with no quota windows honestly', async () => {
    const accounts = [makeAccount({ slot: 1, active: true, kind: 'api-key' })];
    const h = loopHarness({ pollUsage: async () => ({ ok: true, accounts }) }, { accounts });

    await createAutoSwitcher(h.deps).runOnce();
    expect(h.events[0]?.message).toContain('no quota windows');
  });
});
