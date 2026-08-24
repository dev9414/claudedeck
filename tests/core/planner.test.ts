/**
 * `src/core/planner.ts` — where to place the 5-hour anchor.
 *
 * The property everything else serves is at the top of this file: because the
 * window starts at your first message, an earlier anchor can drop a reset
 * *inside* the stretch you most need capacity for, instead of just after it.
 * That only pays off when the reset genuinely lands inside the peak, so the
 * table below pins both halves of the mechanism -- the reset instant and the
 * blocked peak minutes it buys.
 *
 * Everything is derived by hand from the simulator's own rules: 5-minute steps,
 * one account in use at a time, a window spent at 100 points, and no demand
 * charged while the fleet is blocked (a stall consumes nothing). The numbers in
 * the expectations are therefore arithmetic, not recordings -- if the simulator
 * changes shape, they should fail.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  ANCHOR_LOOKBACK_MIN,
  DEFAULT_MAX_PASSES,
  STEP_MIN,
  candidateAnchors,
  fleetCost,
  planDay,
  scoredPeakMinutes,
  simulateFleet,
} from '@core/planner';
import { MIN_ACTIONABLE_CONFIDENCE, emptyProfile } from '@core/profile';
import { FIVE_HOUR_MS } from '@shared/types';
import type { PlanAccount, PlanInput, SimInput } from '@core/planner';
import type { PlanOutcome, UsageProfile, WorkSchedule } from '@shared/types';

import { HOUR, MINUTE } from '../helpers/fixtures';

// ---------------------------------------------------------------------------
// A fixed local day: Monday 2026-08-24 at UTC-5
// ---------------------------------------------------------------------------

/** Negative on purpose: a dropped sign would show up as a shifted clock. */
const TZ = -300;

/** Local midnight of Monday 2026-08-24 in that zone. */
const DAY_START = Date.parse('2026-08-24T00:00:00.000Z') - TZ * MINUTE;

/** A local clock time on the planned day, as epoch ms. */
const at = (h: number, m = 0): number => DAY_START + h * HOUR + m * MINUTE;

const DAY = 24 * HOUR;

/** The same clock time on the day after the planned one. */
const nextDayAt = (h: number, m = 0): number => at(h, m) + DAY;

/** A local clock time as minutes from midnight, for a `DaySpan`. */
const hm = (h: number, m = 0): number => h * 60 + m;

/** Index an array where a missing element is a test failure, not a maybe. */
function only<T>(items: readonly T[], index = 0): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`expected an element at index ${index}, found ${items.length}`);
  }
  return item;
}

/** A profile whose named local hours burn at the given rate, and no others. */
function burn(rates: Record<number, number>, over: Partial<UsageProfile> = {}): UsageProfile {
  const hourly = new Array<number>(24).fill(0);
  for (const [hour, rate] of Object.entries(rates)) hourly[Number(hour)] = rate;
  return {
    hourly,
    samples: hourly.map((rate) => (rate > 0 ? 12 : 0)),
    confidence: 0.9,
    days: [1],
    ...over,
  };
}

/** Every hour burning at the same rate. */
function flat(rate: number, over: Partial<UsageProfile> = {}): UsageProfile {
  const hourly = new Array<number>(24).fill(rate);
  return { hourly, samples: hourly.map(() => 12), confidence: 0.9, days: [1], ...over };
}

function sched(over: Partial<WorkSchedule> = {}): WorkSchedule {
  return {
    label: 'Weekdays',
    days: [1, 2, 3, 4, 5],
    work: { start: hm(9), end: hm(18) },
    peak: { start: hm(11), end: hm(15) },
    ...over,
  };
}

function acct(slot: number, profile: UsageProfile, alias?: string): PlanAccount {
  const account: PlanAccount = { slot, email: `slot${slot}@example.test`, profile };
  return alias === undefined ? account : { ...account, alias };
}

function simInput(over: Partial<SimInput> = {}): SimInput {
  return {
    dayStartMs: DAY_START,
    schedule: sched(),
    profiles: [PEAK_HEAVY],
    peakWeight: 3,
    tzOffsetMin: TZ,
    ...over,
  };
}

/**
 * `nowMs` defaults to the night before the planned day, which is what makes the
 * expectations below arithmetic rather than a recording: every anchor on the day
 * is still ahead, so nothing is clamped away. Omitting it would hand the plan
 * the machine's wall clock, and the same test would pass or fail depending on
 * the hour it ran at -- which is exactly the bug the clamping exists to fix,
 * seen from the other side.
 */
function planInput(over: Partial<PlanInput> = {}): PlanInput {
  return {
    dayStartMs: DAY_START,
    tzOffsetMin: TZ,
    schedule: sched(),
    accounts: [acct(1, PEAK_HEAVY)],
    peakWeight: 3,
    scheduleConfigured: true,
    nowMs: DAY_START - HOUR,
    ...over,
  };
}

/**
 * Ten points an hour before 11:00 and forty through the afternoon: 09:00-14:00
 * holds exactly 140 points of demand, so a window anchored at 09:00 dies at
 * 13:00 -- an hour before its own reset.
 */
const PEAK_HEAVY = burn({ 9: 10, 10: 10, 11: 40, 12: 40, 13: 40, 14: 40, 15: 10, 16: 10, 17: 10 });

/** The same morning, against the user's own 11:00-14:00 peak. */
const USER_PEAK = burn({ 9: 10, 10: 10, 11: 40, 12: 40, 13: 40, 14: 10, 15: 10, 16: 10, 17: 10 });

/** Forty-five points across a nine-hour day: no window can be exhausted. */
const LIGHT = flat(5);

// ---------------------------------------------------------------------------
// The core property
// ---------------------------------------------------------------------------

interface CoreCase {
  label: string;
  schedule: WorkSchedule;
  profile: UsageProfile;
  /** The anchor that puts a reset inside the peak. */
  early: number;
  /** The anchor that looks natural -- start when the peak starts. */
  late: number;
  earlyWork: number;
  earlyPeak: number;
  lateWork: number;
  latePeak: number;
}

const coreCases: CoreCase[] = [
  {
    // Anchor 09:00 -> reset 14:00, an hour inside the peak. The window dies at
    // 13:00 and the reset revives it at 14:00, so only 13:00-14:00 is lost.
    // Anchor 11:00 -> reset 16:00, past the peak entirely: the window dies at
    // 13:30 and nothing arrives until the peak is over.
    label: 'a peak that outlasts the reset: anchoring at 09:00 beats anchoring at 11:00',
    schedule: sched({ work: { start: hm(9), end: hm(18) }, peak: { start: hm(11), end: hm(15) } }),
    profile: PEAK_HEAVY,
    early: at(9),
    late: at(11),
    earlyWork: 60,
    earlyPeak: 60,
    // 09:00-11:00 is blocked too: an account cannot be used before its anchor.
    lateWork: 270,
    latePeak: 90,
  },
  {
    // The user's own hours. A peak ending at 14:00 makes the 14:00 reset land on
    // the peak's exclusive edge, so the anchor has to move back an hour further
    // for the reset (13:00) to fall *inside* the peak -- and then the day costs
    // nothing at all.
    label: 'the user hours (peak 11:00-14:00): the reset has to land inside, so 08:00 wins',
    schedule: sched({ work: { start: hm(9), end: hm(18) }, peak: { start: hm(11), end: hm(14) } }),
    profile: USER_PEAK,
    early: at(8),
    late: at(11),
    earlyWork: 0,
    earlyPeak: 0,
    lateWork: 270,
    latePeak: 30,
  },
];

describe('simulateFleet: an earlier anchor moves the reset into the peak', () => {
  it.each(coreCases)('$label', (testCase) => {
    const input = simInput({ schedule: testCase.schedule, profiles: [testCase.profile] });
    const early = only(simulateFleet([testCase.early], input));
    const late = only(simulateFleet([testCase.late], input));

    const peakStart = DAY_START + testCase.schedule.peak.start * MINUTE;
    const peakEnd = DAY_START + testCase.schedule.peak.end * MINUTE;

    // The mechanism: the early anchor's first reset is inside the peak, the late
    // anchor's is not. Without this the blocked minutes below are a coincidence.
    const earlyReset = only(early.windows).end;
    expect(earlyReset).toBe(testCase.early + FIVE_HOUR_MS);
    expect(earlyReset).toBeGreaterThanOrEqual(peakStart);
    expect(earlyReset).toBeLessThan(peakEnd);
    expect(testCase.late + FIVE_HOUR_MS).toBeGreaterThanOrEqual(peakEnd);

    expect(early.blockedPeakMin).toBe(testCase.earlyPeak);
    expect(late.blockedPeakMin).toBe(testCase.latePeak);
    expect(early.blockedPeakMin).toBeLessThan(late.blockedPeakMin);

    expect(early.blockedWorkMin).toBe(testCase.earlyWork);
    expect(late.blockedWorkMin).toBe(testCase.lateWork);
    expect(early.cost).toBeLessThan(late.cost);
  });
});

describe('planDay: the recommended anchor', () => {
  it('moves the anchor earlier and reports the peak minutes that buys', () => {
    const input = planInput();
    const plan = planDay(input);
    const planned = only(plan.accounts).outcome;

    // Baseline: everyone starts when work starts, so the reset lands at 14:00
    // and 13:00-14:00 of the peak is lost.
    expect(plan.baseline.anchorAt).toBe(at(9));
    expect(plan.baseline.blockedWorkMin).toBe(60);
    expect(plan.baseline.blockedPeakMin).toBe(60);
    expect(plan.baseline.cost).toBe(240);

    // 08:15 splits the day into 09:00-13:15 and 13:15-18:15: the first window
    // stalls for a quarter of an hour, the second covers the rest of the day.
    expect(planned.anchorAt).toBe(at(8, 15));
    expect(planned.anchorAt).toBeLessThan(at(11));
    expect(planned.blockedWorkMin).toBe(15);
    expect(planned.blockedPeakMin).toBe(15);
    expect(planned.cost).toBe(60);
    expect(plan.peakMinutesSaved).toBe(45);

    expect(only(plan.rationale)).toMatch(/inside your 11:00-15:00 peak/);
    expect(only(plan.accounts).note).toMatch(/Anchor at 08:15, resetting 13:15 and 18:15/);
    expect(only(plan.accounts).note).toMatch(/15 minutes blocked/);
  });

  it('echoes the day, schedule, profile and account identity it was given', () => {
    const schedule = sched();
    const plan = planDay(planInput({ schedule, accounts: [acct(2, PEAK_HEAVY, 'work')] }));

    expect(plan.day).toBe('2026-08-24');
    expect(plan.schedule).toBe(schedule);
    expect(plan.profile).toBe(PEAK_HEAVY);
    expect(only(plan.accounts).slot).toBe(2);
    expect(only(plan.accounts).email).toBe('slot2@example.test');
    expect(only(plan.accounts).alias).toBe('work');
    expect(plan.lowConfidence).toBe(false);
    expect(plan.usingDefaultSchedule).toBe(false);
  });

  it('invents no benefit when the load fits inside the windows anyway', () => {
    const plan = planDay(planInput({ accounts: [acct(1, LIGHT)] }));
    const planned = only(plan.accounts).outcome;

    expect(planned.anchorAt).toBe(at(9));
    expect(planned.blockedWorkMin).toBe(0);
    expect(planned.blockedPeakMin).toBe(0);
    expect(planned.cost).toBe(0);
    expect(plan.peakMinutesSaved).toBe(0);
    expect(only(plan.rationale)).toMatch(/anchoring changes nothing/);
    expect(only(plan.accounts).note).toMatch(/Nothing to do differently/);

    // The baseline really is the optimum here: a later anchor withholds the
    // account through the morning, which is strictly worse.
    const later = only(simulateFleet([at(11)], simInput({ profiles: [LIGHT] })));
    expect(later.blockedWorkMin).toBe(120);
  });

  it('says so plainly when a day is blocked whatever the anchor', () => {
    // A working day that starts at midnight is the one shape no anchor can
    // improve: the search cannot reach back past the day it is planning, so no
    // candidate can drop a second reset inside the five hours, and delaying the
    // anchor only moves the stall around. Fifty points an hour spends the single
    // window by 02:00, and 180 of the 300 minutes are lost whichever anchor is
    // chosen -- so the plan is the baseline and says so.
    const schedule = sched({ work: { start: hm(0), end: hm(5) }, peak: { start: hm(0), end: hm(5) } });
    const plan = planDay(planInput({ schedule, accounts: [acct(1, flat(50))] }));
    const planned = only(plan.accounts).outcome;

    expect(plan.baseline.blockedWorkMin).toBe(180);
    expect(plan.baseline.blockedPeakMin).toBe(180);
    expect(plan.baseline.cost).toBe(720);
    expect(planned.anchorAt).toBe(DAY_START);
    expect(planned.blockedWorkMin).toBe(180);
    expect(planned.cost).toBe(720);
    expect(plan.peakMinutesSaved).toBe(0);
    expect(plan.rationale).toHaveLength(2);
    expect(only(plan.rationale)).toMatch(
      /No anchor beats simply starting at 00:00: 180 minutes come out blocked either way/,
    );
    expect(only(plan.accounts).note).toMatch(/Nothing to do differently/);
  });

  it('breaks a tie toward the later anchor', () => {
    const input = simInput();
    // Four anchors score exactly sixty: 08:00 loses an hour at the end of the
    // day, 08:15 loses a quarter of an hour of peak, and the two between trade
    // one for the other. Only the latest of them should be recommended, because
    // asking the user to start earlier than the numbers require is a worse plan.
    for (const candidate of [at(8), at(8, 5), at(8, 10), at(8, 15)]) {
      expect(fleetCost(simulateFleet([candidate], input), 3)).toBe(60);
    }
    expect(fleetCost(simulateFleet([at(8, 20)], input), 3)).toBe(80);

    expect(only(planDay(planInput()).accounts).outcome.anchorAt).toBe(at(8, 15));
  });

  it('gives the identical plan twice, without Math.random or the ambient clock', () => {
    // The clock assertion is about `nowMs`: given the instant, nothing reads
    // `Date.now()`, so a plan on screen never shifts under the user between two
    // renders of the same input.
    const random = vi.spyOn(Math, 'random');
    const clock = vi.spyOn(Date, 'now');
    const first = planDay(planInput());
    const randomCalls = random.mock.calls.length;
    const clockCalls = clock.mock.calls.length;
    random.mockRestore();
    clock.mockRestore();

    const second = planDay(planInput());
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(randomCalls).toBe(0);
    expect(clockCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

/**
 * The planner used to answer "when do I send my first message today" with a
 * time that had passed hours ago: the candidate set was built from the schedule
 * alone. An anchor is a message the user has to actually send, so the tests
 * below pin the two honest answers -- the earliest anchor still open, and, when
 * there is none, tomorrow.
 */
describe('planDay: an anchor in the past is not a recommendation', () => {
  const sweep = [
    { label: 'the moment work starts', nowMs: at(9) },
    { label: 'mid-morning, off-grid', nowMs: at(10, 7) },
    { label: 'the middle of the peak', nowMs: at(12) },
    { label: 'five minutes of peak left', nowMs: at(14, 55) },
    { label: 'the peak is over', nowMs: at(16) },
    { label: 'the working day is over', nowMs: at(19, 30) },
  ];

  it.each(sweep)('never names an anchor before now: $label', ({ nowMs }) => {
    const plan = planDay(planInput({ nowMs }));
    expect(plan.accounts).not.toHaveLength(0);
    for (const account of plan.accounts) {
      expect(account.outcome.anchorAt).toBeGreaterThanOrEqual(nowMs);
    }
  });

  it('leaks no past anchor into a fleet plan that does beat the baseline', () => {
    // Coordinate descent keeps an account where it started when nothing beats
    // it, so a descent that started at 09:00 could hand back 09:00 for one
    // account while the other improved -- a plan that beats the baseline and is
    // still impossible to follow.
    const schedule = sched({
      work: { start: hm(9), end: hm(19) },
      peak: { start: hm(12), end: hm(16) },
    });
    const plan = planDay(
      planInput({
        schedule,
        accounts: [acct(1, flat(50)), acct(2, flat(50))],
        nowMs: at(11),
      }),
    );

    expect(plan.accounts).toHaveLength(2);
    for (const account of plan.accounts) {
      expect(account.outcome.anchorAt).toBeGreaterThanOrEqual(at(11));
    }
  });

  it('recommends the earliest anchor still open once the morning has gone', () => {
    // 11:00 onwards, no anchor beats the 09:00 start that is no longer
    // available: anchoring at 11:00 costs 540 against the baseline's 240. So
    // the plan recommends starting now and says the comparison is moot, rather
    // than printing 08:15 at a user for whom 08:15 has been and gone.
    const plan = planDay(planInput({ nowMs: at(11) }));
    const planned = only(plan.accounts).outcome;

    expect(plan.day).toBe('2026-08-24');
    expect(planned.anchorAt).toBe(at(11));
    expect(plan.baseline.anchorAt).toBe(at(9));
    expect(plan.baseline.blockedPeakMin).toBe(60);
    // Starting now is worse than the 09:00 start would have been, and a saving
    // is never reported as negative -- nor as a benefit.
    expect(plan.peakMinutesSaved).toBe(0);
    expect(only(plan.accounts).note).toMatch(/11:00 is simply the earliest anchor still open/);
    expect(only(plan.rationale)).toMatch(/No anchor still open beats simply starting now/);
    // And no line comparing a from-now figure against a whole-day one.
    expect(plan.rationale.some((line) => /the same as with no anchoring/.test(line))).toBe(false);
  });

  it("plans tomorrow, and says so, once today's anchors have all passed", () => {
    const plan = planDay(planInput({ nowMs: at(15, 1) }));
    const planned = only(plan.accounts).outcome;

    expect(plan.day).toBe('2026-08-25');
    expect(planned.anchorAt).toBe(nextDayAt(8, 15));
    expect(planned.anchorAt).toBeGreaterThan(at(15, 1));
    expect(plan.baseline.anchorAt).toBe(nextDayAt(9));
    // The same plan as the morning's, one day over: nothing about the advice
    // changed, only which day it is for.
    expect(plan.peakMinutesSaved).toBe(45);
    expect(only(plan.rationale)).toMatch(
      /Every start time worth taking on 2026-08-24 has already passed, so this is 2026-08-25's plan/,
    );
  });

  it('names the day it planned even with no accounts to plan for', () => {
    const plan = planDay(planInput({ accounts: [], nowMs: at(19) }));
    expect(plan.day).toBe('2026-08-25');
    expect(only(plan.rationale)).toMatch(/this is 2026-08-25's plan/);
    expect(only(plan.rationale, 1)).toMatch(/No accounts are set up/);
  });

  it('falls back to the wall clock when it is given no instant', () => {
    // Callers that forget the instant must not get a plan for a time that has
    // passed; the wall clock is the safer default, and it is the only thing
    // `Date.now()` is read for.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(at(15, 1));
    try {
      const plan = planDay(planInput({ nowMs: undefined }));
      expect(plan.day).toBe('2026-08-25');
      expect(clock).toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it('plans a day that is already over as history, not as tomorrow', () => {
    // `deck plan --day 2026-08-24` run a week later is analysis, and clamping
    // it would leave nothing to analyse.
    const plan = planDay(planInput({ nowMs: DAY_START + 7 * DAY }));
    expect(plan.day).toBe('2026-08-24');
    expect(only(plan.accounts).outcome.anchorAt).toBe(at(8, 15));
  });
});

describe('candidateAnchors: the clock', () => {
  it('offers nothing earlier than now, on the same five-minute grid', () => {
    const anchors = candidateAnchors(simInput(), at(10, 2));

    expect(only(anchors)).toBe(at(10, 5));
    expect(only(anchors, anchors.length - 1)).toBe(at(15));
    expect(anchors.every((t) => t >= at(10, 2))).toBe(true);
  });

  it('runs out when now is past the last anchor worth taking', () => {
    expect(candidateAnchors(simInput(), at(15))).toHaveLength(1);
    expect(candidateAnchors(simInput(), at(15, 1))).toEqual([]);
  });

  it('leaves a day still ahead, or already over, exactly as it was', () => {
    const unclamped = candidateAnchors(simInput());

    expect(candidateAnchors(simInput(), DAY_START)).toEqual(unclamped);
    expect(candidateAnchors(simInput(), at(48))).toEqual(unclamped);
  });

  it('drops an off-grid start of work that has passed', () => {
    const schedule = sched({
      work: { start: hm(2, 2), end: hm(10) },
      peak: { start: hm(3), end: hm(5) },
    });

    expect(candidateAnchors(simInput({ schedule }))).toContain(at(2, 2));
    const later = candidateAnchors(simInput({ schedule }), at(2, 30));
    expect(later).not.toContain(at(2, 2));
    expect(only(later)).toBe(at(2, 30));
  });
});

// ---------------------------------------------------------------------------
// Peak minutes: the delta and the absolute are different numbers
// ---------------------------------------------------------------------------

describe('scoredPeakMinutes', () => {
  it.each([
    ['a peak inside working hours', sched(), 240],
    ['a peak trimmed to fit', sched({ work: { start: hm(9), end: hm(12) } }), 60],
    [
      'a peak outside working hours',
      sched({ work: { start: hm(9), end: hm(12) }, peak: { start: hm(14), end: hm(16) } }),
      0,
    ],
    [
      'a night shift crossing midnight',
      sched({ work: { start: hm(20), end: hm(4) }, peak: { start: hm(22), end: hm(2) } }),
      240,
    ],
  ])('measures %s', (_label, schedule, expected) => {
    expect(scoredPeakMinutes(schedule, DAY_START)).toBe(expected);
  });

  it('is the denominator peakMinutesSaved is not', () => {
    // `peakMinutesSaved` is a delta against a 09:00 start; the peak the plan
    // protects is the peak minus what stays blocked. Two different numbers, and
    // a UI that prints the smaller as the larger undersells the plan sixfold.
    const plan = planDay(planInput());
    const planned = only(plan.accounts).outcome;

    expect(scoredPeakMinutes(plan.schedule, DAY_START)).toBe(240);
    expect(planned.blockedPeakMin).toBe(15);
    expect(scoredPeakMinutes(plan.schedule, DAY_START) - planned.blockedPeakMin).toBe(225);
    expect(plan.peakMinutesSaved).toBe(45);
  });
});

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

describe('simulateFleet: window boundaries', () => {
  const tenHourDay = sched({ work: { start: hm(9), end: hm(19) } });

  it('resets accumulated utilization to exactly zero at every boundary', () => {
    // Twelve points an hour for ten hours is 120 points of demand. Carried
    // across the boundary the second window would close at 120; reset, both
    // windows close at 60.
    const outcome = only(
      simulateFleet([at(9)], simInput({ schedule: tenHourDay, profiles: [flat(12)] })),
    );

    expect(outcome.windows).toEqual([
      { start: at(9), end: at(14), endPct: 60, exhaustedAt: null, blockedMin: 0 },
      { start: at(14), end: at(19), endPct: 60, exhaustedAt: null, blockedMin: 0 },
    ]);
    expect(outcome.blockedWorkMin).toBe(0);
  });

  it('lets a spent window recover on the far side of its reset', () => {
    // Thirty an hour spends a window in 3h20m, so each window stalls for the
    // remaining 100 minutes -- and the second one stalls at all only because it
    // started again from zero.
    const outcome = only(
      simulateFleet([at(9)], simInput({ schedule: tenHourDay, profiles: [flat(30)] })),
    );

    expect(outcome.windows).toEqual([
      { start: at(9), end: at(14), endPct: 100, exhaustedAt: at(12, 20), blockedMin: 100 },
      { start: at(14), end: at(19), endPct: 100, exhaustedAt: at(17, 20), blockedMin: 100 },
    ]);
    expect(outcome.blockedWorkMin).toBe(200);
    expect(outcome.blockedPeakMin).toBe(100);
  });

  it('charges a stall before the anchor to the fleet but to no window', () => {
    const outcome = only(simulateFleet([at(11)], simInput()));
    expect(outcome.blockedWorkMin).toBe(270);
    // 09:00-11:00 was blocked, but no window of this account existed yet.
    expect(outcome.windows.reduce((sum, w) => sum + w.blockedMin, 0)).toBe(150);
    expect(only(outcome.windows).start).toBe(at(11));
  });
});

// ---------------------------------------------------------------------------
// Multiple accounts
// ---------------------------------------------------------------------------

describe('simulateFleet: multiple accounts', () => {
  const fiveHourDay = sched({
    work: { start: hm(9), end: hm(14) },
    peak: { start: hm(11), end: hm(13) },
  });

  it('counts a minute as blocked only when every account is spent', () => {
    const profiles = [flat(30), flat(30)];
    const pair = simulateFleet([at(9), at(9)], simInput({ schedule: fiveHourDay, profiles }));

    expect(pair).toHaveLength(2);
    expect(only(pair, 0).blockedWorkMin).toBe(0);
    expect(only(pair, 1).blockedWorkMin).toBe(0);
    // The first account is spent at 12:20 and the second carries the remainder.
    expect(only(only(pair, 0).windows).endPct).toBe(100);
    expect(only(only(pair, 1).windows).endPct).toBe(50);

    const solo = only(
      simulateFleet([at(9)], simInput({ schedule: fiveHourDay, profiles: [flat(30)] })),
    );
    expect(solo.blockedWorkMin).toBe(100);
    expect(solo.blockedPeakMin).toBe(40);
  });

  it('beats identical anchors by staggering them across the peak', () => {
    // Fifty an hour over ten hours: 500 points of demand, 400 of capacity, so
    // 120 minutes are blocked whatever happens. The anchors decide *when*.
    const schedule = sched({
      work: { start: hm(9), end: hm(19) },
      peak: { start: hm(12), end: hm(16) },
    });
    const input = simInput({ schedule, profiles: [flat(50), flat(50)] });

    const together = simulateFleet([at(9), at(9)], input);
    const staggered = simulateFleet([at(9), at(12)], input);

    expect(only(together).blockedWorkMin).toBe(120);
    expect(only(staggered).blockedWorkMin).toBe(120);
    // Anchored together, both accounts reset at 14:00 and the fleet runs dry in
    // the middle of the peak. Staggered, the second account's window opens at
    // 12:00 and every blocked minute falls outside the peak.
    expect(only(together).blockedPeakMin).toBe(60);
    expect(only(staggered).blockedPeakMin).toBe(0);
    expect(fleetCost(together, 3)).toBe(300);
    expect(fleetCost(staggered, 3)).toBe(120);
  });

  it('reports the fleet-wide stall on every account and the detail per window', () => {
    const schedule = sched({
      work: { start: hm(9), end: hm(19) },
      peak: { start: hm(12), end: hm(16) },
    });
    const outcomes = simulateFleet(
      [at(9), at(12)],
      simInput({ schedule, profiles: [flat(50), flat(50)] }),
    );

    expect(only(outcomes, 0).blockedWorkMin).toBe(only(outcomes, 1).blockedWorkMin);
    expect(only(outcomes, 0).cost).toBe(only(outcomes, 1).cost);
    expect(only(outcomes, 0).anchorAt).toBe(at(9));
    expect(only(outcomes, 1).anchorAt).toBe(at(12));
    expect(only(outcomes, 0).windows).not.toEqual(only(outcomes, 1).windows);
  });

  it('charges nothing to an account it was given no profile for', () => {
    const schedule = sched({ work: { start: hm(9), end: hm(19) } });
    const outcomes = simulateFleet(
      [at(9), at(9)],
      simInput({ schedule, profiles: [flat(50)] }),
    );

    expect(outcomes).toHaveLength(2);
    expect(only(only(outcomes, 0).windows).endPct).toBe(100);
    expect(only(outcomes, 1).windows.every((w) => w.endPct === 0)).toBe(true);
    // An account that burns nothing is never spent, so nothing is ever blocked.
    expect(only(outcomes, 0).blockedWorkMin).toBe(0);
  });

  it('plans two accounts onto different anchors and reports the peak minutes saved', () => {
    const schedule = sched({
      work: { start: hm(9), end: hm(19) },
      peak: { start: hm(12), end: hm(16) },
    });
    const plan = planDay(
      planInput({ schedule, accounts: [acct(1, flat(50)), acct(2, flat(50))] }),
    );

    expect(plan.baseline.blockedWorkMin).toBe(120);
    expect(plan.baseline.blockedPeakMin).toBe(60);
    expect(plan.baseline.cost).toBe(300);

    const first = only(plan.accounts, 0).outcome;
    const second = only(plan.accounts, 1).outcome;

    // Anchored together the fleet only ever holds two windows over this day, and
    // 500 points of demand cannot fit in 400. Anchored three hours apart, slot 1
    // gets a *third* window inside working hours (07:00, 12:00 and 17:00) while
    // slot 2 covers 10:00 and 15:00 -- five windows, exactly 500 points, nothing
    // blocked at all.
    expect(first.anchorAt).toBe(at(7));
    expect(second.anchorAt).toBe(at(10));
    expect(first.anchorAt).not.toBe(second.anchorAt);
    expect(first.windows.map((w) => w.endPct)).toEqual([100, 100, 100]);
    expect(second.windows.map((w) => w.endPct)).toEqual([100, 100]);
    expect(first.blockedWorkMin).toBe(0);
    expect(first.blockedPeakMin).toBe(0);
    expect(first.cost).toBe(0);
    expect(plan.peakMinutesSaved).toBe(60);
    expect(only(plan.rationale)).toMatch(/Anchoring slot 1 at 07:00 puts its reset at 12:00/);
    expect(only(plan.rationale, 1)).toMatch(/Anchoring slot 2 at 10:00 puts its reset at 15:00/);
  });
});

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

describe('fleetCost', () => {
  const outcome = (work: number, peak: number): PlanOutcome => ({
    anchorAt: at(9),
    windows: [],
    blockedWorkMin: work,
    blockedPeakMin: peak,
    cost: 0,
  });

  it('scores the worst account rather than the sum of the fleet', () => {
    // Both outcomes describe the same simulated day, so adding them would
    // multiply one stall by the number of accounts.
    expect(fleetCost([outcome(10, 5), outcome(30, 0)], 2)).toBe(30);
  });

  it.each([
    ['a sane weight', 3, 25],
    ['no weight at all', 0, 10],
    ['a missing weight', Number.NaN, 15],
    ['a negative weight', -4, 15],
    ['an absurd weight, clamped', 1e9, 5010],
  ])('handles %s', (_label, weight, expected) => {
    expect(fleetCost([outcome(10, 5)], weight)).toBe(expected);
  });

  it.each([
    ['an empty fleet', [] as PlanOutcome[], 0],
    ['non-finite minutes', [outcome(Number.NaN, Number.POSITIVE_INFINITY)], 0],
  ])('scores %s as zero', (_label, outcomes, expected) => {
    expect(fleetCost(outcomes, 3)).toBe(expected);
  });
});

describe('candidateAnchors', () => {
  it('is a five-minute grid from six hours before work to the end of the peak', () => {
    const anchors = candidateAnchors(simInput());

    expect(only(anchors)).toBe(at(3));
    expect(only(anchors, anchors.length - 1)).toBe(at(15));
    expect(anchors).toHaveLength(145);
    expect(anchors).toContain(at(9));
    expect(new Set(anchors).size).toBe(anchors.length);
    for (let i = 1; i < anchors.length; i += 1) {
      expect(only(anchors, i) - only(anchors, i - 1)).toBe(STEP_MIN * MINUTE);
    }
  });

  it('stops at the end of work when the peak lies outside it', () => {
    const schedule = sched({
      work: { start: hm(9), end: hm(12) },
      peak: { start: hm(14), end: hm(16) },
    });
    const anchors = candidateAnchors(simInput({ schedule }));
    expect(only(anchors, anchors.length - 1)).toBe(at(12));
  });

  it('clamps to the planned day and still offers an off-grid start of work', () => {
    const schedule = sched({
      work: { start: hm(2, 2), end: hm(10) },
      peak: { start: hm(3), end: hm(5) },
    });
    const anchors = candidateAnchors(simInput({ schedule }));

    // Six hours before 02:02 is the previous day, so the search starts at midnight.
    expect(only(anchors)).toBe(DAY_START);
    expect(only(anchors, anchors.length - 1)).toBe(at(5));
    expect(anchors).toContain(at(2, 2));
    expect(anchors).toHaveLength(62);
  });

  it('exposes the constants the grid is derived from', () => {
    expect(STEP_MIN).toBe(5);
    expect(ANCHOR_LOOKBACK_MIN).toBe(360);
    expect(DEFAULT_MAX_PASSES).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

describe('planDay: edge cases', () => {
  it('reports an empty account list as a wholly blocked day', () => {
    const plan = planDay(planInput({ accounts: [] }));

    expect(plan.accounts).toEqual([]);
    expect(plan.baseline.anchorAt).toBe(at(9));
    expect(plan.baseline.blockedWorkMin).toBe(540);
    expect(plan.baseline.blockedPeakMin).toBe(240);
    expect(plan.baseline.cost).toBe(1260);
    expect(plan.peakMinutesSaved).toBe(0);
    expect(only(plan.rationale)).toMatch(/No accounts are set up/);
    expect(only(plan.rationale, 1)).toMatch(/540 minutes/);

    expect(simulateFleet([], simInput({ profiles: [] }))).toEqual([]);
    expect(fleetCost([], 3)).toBe(0);
  });

  it('says it has no data, not that it found nothing, when nothing was observed', () => {
    // `emptyProfile()` means no hour was ever watched. Saying "your history
    // shows no quota being burned" would be a finding drawn from an absence, so
    // the plan has to name the absence instead.
    const plan = planDay(planInput({ accounts: [acct(1, emptyProfile())] }));
    const planned = only(plan.accounts).outcome;

    expect(planned.anchorAt).toBe(at(9));
    expect(planned.blockedWorkMin).toBe(0);
    expect(planned.windows.every((w) => w.endPct === 0)).toBe(true);
    expect(plan.peakMinutesSaved).toBe(0);
    expect(plan.lowConfidence).toBe(true);
    expect(only(plan.rationale)).toMatch(/no recorded usage to simulate against/);
    // And it must not quote a minute figure it computed from a placeholder.
    expect(plan.rationale.some((line) => /\d+ minutes? come out blocked/.test(line))).toBe(false);
    expect(plan.rationale.some((line) => /blocked peak minutes:/.test(line))).toBe(false);
  });

  it('distinguishes "watched, and you burned nothing" from "never watched"', () => {
    // Hours observed, all of them idle: that IS a finding about the day, and it
    // should read differently from having no history at all.
    const idle = flat(0, { samples: new Array<number>(24).fill(12), confidence: 0.9 });
    const plan = planDay(planInput({ accounts: [acct(1, idle)] }));

    expect(only(plan.rationale)).toMatch(/no quota being burned/);
    expect(plan.rationale.some((line) => /no recorded usage to simulate against/.test(line))).toBe(
      false,
    );
    expect(plan.peakMinutesSaved).toBe(0);
  });

  it('simulates a working day that crosses midnight', () => {
    const schedule = sched({
      work: { start: hm(20), end: hm(4) },
      peak: { start: hm(22), end: hm(2) },
    });
    const outcome = only(
      simulateFleet([at(20)], simInput({ schedule, profiles: [flat(30)] })),
    );

    expect(outcome.windows).toEqual([
      { start: at(20), end: at(25), endPct: 100, exhaustedAt: at(23, 20), blockedMin: 100 },
      { start: at(25), end: at(30), endPct: 90, exhaustedAt: null, blockedMin: 0 },
    ]);
    expect(outcome.blockedWorkMin).toBe(100);
    expect(outcome.blockedPeakMin).toBe(100);

    const plan = planDay(planInput({ schedule, accounts: [acct(1, flat(30))] }));
    expect(plan.day).toBe('2026-08-24');
    expect(plan.baseline.cost).toBe(400);
    const planned = only(plan.accounts).outcome;
    expect(planned.cost).toBeLessThan(plan.baseline.cost);
    // The night shift's candidates run from 14:00 to the end of the peak, 02:00.
    expect(planned.anchorAt).toBeGreaterThanOrEqual(at(14));
    expect(planned.anchorAt).toBeLessThanOrEqual(at(26));
  });

  it('drops a peak that lies outside working hours instead of relocating it', () => {
    const schedule = sched({
      work: { start: hm(9), end: hm(12) },
      peak: { start: hm(14), end: hm(16) },
    });
    const solo = only(simulateFleet([at(9)], simInput({ schedule, profiles: [flat(40)] })));
    expect(solo.blockedWorkMin).toBe(30);
    expect(solo.blockedPeakMin).toBe(0);

    // With no peak to weight, plain working minutes decide: anchoring at 06:30
    // puts the reset at 11:30, exactly where the first window runs out.
    const plan = planDay(planInput({ schedule, accounts: [acct(1, flat(40))] }));
    const planned = only(plan.accounts).outcome;
    expect(planned.anchorAt).toBe(at(6, 30));
    expect(planned.blockedWorkMin).toBe(0);
    expect(plan.peakMinutesSaved).toBe(0);
    expect(plan.rationale.some((line) => /outside working hours/.test(line))).toBe(true);
    expect(
      plan.rationale.some((line) => /blocked working minutes: 0, down from 30/.test(line)),
    ).toBe(true);
  });

  it('reads a working day whose start equals its end as the whole day', () => {
    const schedule = sched({
      work: { start: hm(0), end: hm(0) },
      peak: { start: hm(12), end: hm(14) },
    });
    const outcome = only(
      simulateFleet([DAY_START], simInput({ schedule, profiles: [flat(30)] })),
    );

    expect(outcome.windows).toEqual([
      { start: at(0), end: at(5), endPct: 100, exhaustedAt: at(3, 20), blockedMin: 100 },
      { start: at(5), end: at(10), endPct: 100, exhaustedAt: at(8, 20), blockedMin: 100 },
      { start: at(10), end: at(15), endPct: 100, exhaustedAt: at(13, 20), blockedMin: 100 },
      { start: at(15), end: at(20), endPct: 100, exhaustedAt: at(18, 20), blockedMin: 100 },
      // The last window is cut short by the end of the day, not by its own reset.
      { start: at(20), end: at(25), endPct: 100, exhaustedAt: at(23, 20), blockedMin: 40 },
    ]);
    expect(outcome.blockedWorkMin).toBe(440);
    expect(outcome.blockedPeakMin).toBe(40);
  });
});

// ---------------------------------------------------------------------------
// What the plan admits about itself
// ---------------------------------------------------------------------------

describe('planDay: caveats', () => {
  it('admits when the hours are the app default rather than the user own', () => {
    const plan = planDay(planInput({ scheduleConfigured: false, accounts: [acct(1, LIGHT)] }));
    expect(plan.usingDefaultSchedule).toBe(true);
    expect(plan.rationale.some((line) => /default hours \(09:00-18:00\)/.test(line))).toBe(true);
  });

  it('admits when the history behind it is thin, and counts what it saw', () => {
    const thin = burn({ 9: 10, 10: 10, 11: 10 }, { confidence: 0.2 });
    const plan = planDay(planInput({ accounts: [acct(1, thin)] }));

    expect(plan.lowConfidence).toBe(true);
    expect(
      plan.rationale.some((line) => /3 hours of the day observed across 1 day/.test(line)),
    ).toBe(true);
  });

  it('treats the actionable-confidence floor as good enough', () => {
    const borderline = burn({ 9: 10 }, { confidence: MIN_ACTIONABLE_CONFIDENCE });
    expect(planDay(planInput({ accounts: [acct(1, borderline)] })).lowConfidence).toBe(false);
  });

  it('takes the weakest confidence in the fleet, but reports the first profile', () => {
    const strong = burn({ 9: 10 }, { confidence: 0.9 });
    const weak = burn({ 9: 10 }, { confidence: 0.1 });
    const plan = planDay(planInput({ accounts: [acct(1, strong), acct(2, weak)] }));

    expect(plan.lowConfidence).toBe(true);
    expect(plan.profile).toBe(strong);
    expect(plan.profile.confidence).toBe(0.9);
  });

  it('admits when it planned a day the schedule does not cover', () => {
    const plan = planDay(
      planInput({ schedule: sched({ days: [0, 6] }), accounts: [acct(1, LIGHT)] }),
    );
    expect(plan.rationale.some((line) => /Monday is not a working day/.test(line))).toBe(true);
  });

  it('keeps the rationale to five lines however much there is to admit', () => {
    const plan = planDay(
      planInput({
        schedule: sched({
          days: [0, 6],
          work: { start: hm(9), end: hm(12) },
          peak: { start: hm(14), end: hm(16) },
        }),
        accounts: [acct(1, flat(40, { confidence: 0, samples: new Array<number>(24).fill(0) }))],
        scheduleConfigured: false,
      }),
    );
    expect(plan.rationale).toHaveLength(5);
    expect(plan.lowConfidence).toBe(true);
    expect(plan.usingDefaultSchedule).toBe(true);
  });
});
