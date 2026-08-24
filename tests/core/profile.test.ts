/**
 * `src/core/profile.ts` — learning *when* the user burns quota.
 *
 * Two behaviours carry the whole module. First, segmentation: a delta is only
 * meaningful inside one 5-hour window, and the window has to be found from
 * `resets` when a point carries it and from a *drop* in utilization when it does
 * not — every point recorded before the session planner existed lacks `resets`,
 * so the backward-compatible path is load-bearing, not a nicety. Second, hour
 * attribution: an interval straddling 09:30-10:15 says something about both
 * hours, and which local hours those are depends on a `tzOffsetMin` parameter
 * rather than on the host's zone.
 *
 * Every instant is built from a fixed local midnight plus an offset, so the
 * expectations read as clock times and hold in whatever zone the suite runs in.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LOOKBACK_DAYS,
  MIN_ACTIONABLE_CONFIDENCE,
  PLANNER_WINDOW_KEY,
  boundarySignal,
  buildProfile,
  emptyProfile,
  flatProfile,
  localDayIndex,
  localDayKey,
  localHourAt,
  localWeekday,
  normalizeMinute,
  segmentByWindow,
  spanLengthMin,
} from '@core/profile';
import { FIVE_HOUR_MS } from '@shared/types';
import type { BoundarySignal } from '@core/profile';
import type { HistoryPoint } from '@shared/types';

import { DAY, HOUR, MINUTE, makeHistoryPoint } from '../helpers/fixtures';

// ---------------------------------------------------------------------------
// A fixed day, in a negative-offset zone so a sign error shows up as a wrong hour
// ---------------------------------------------------------------------------

/** UTC-5. Negative on purpose: the sign of the shift is easy to get backwards. */
const TZ = -300;

/** Monday 2026-08-24, 00:00 UTC. */
const MONDAY_UTC = Date.parse('2026-08-24T00:00:00.000Z');

/** Local midnight of that Monday for a zone `tzOffsetMin` from UTC. */
const midnight = (tzOffsetMin: number): number => MONDAY_UTC - tzOffsetMin * MINUTE;

const DAY_START = midnight(TZ);

/** A local clock time on `dayStart`, as epoch ms. */
const at = (h: number, m = 0, dayStart: number = DAY_START): number =>
  dayStart + h * HOUR + m * MINUTE;

interface PointSpec {
  at: number;
  pct?: number;
  slot?: number;
  /** Epoch ms this point reported as the 5h window's reset instant. */
  resets?: number;
  windows?: Record<string, number>;
}

/**
 * `resets` postdates the shared builder, so it is layered on here rather than
 * assuming another slice has already taught `makeHistoryPoint` about it.
 */
function pt(spec: PointSpec): HistoryPoint {
  const base = makeHistoryPoint({
    t: spec.at,
    slot: spec.slot ?? 1,
    windows: spec.windows ?? { [PLANNER_WINDOW_KEY]: spec.pct ?? 0 },
  });
  if (spec.resets === undefined) return base;
  return { ...base, resets: { [PLANNER_WINDOW_KEY]: spec.resets } };
}

/** Points every `stepMin` from local `fromHour` to `toHour`, rising steadily. */
function ramp(opts: {
  dayStart?: number;
  fromHour: number;
  toHour: number;
  stepMin: number;
  pctPerStep: number;
  startPct?: number;
  slot?: number;
}): HistoryPoint[] {
  const dayStart = opts.dayStart ?? DAY_START;
  const steps = ((opts.toHour - opts.fromHour) * 60) / opts.stepMin;
  const points: HistoryPoint[] = [];
  for (let i = 0; i <= steps; i += 1) {
    points.push(
      pt({
        at: at(opts.fromHour, i * opts.stepMin, dayStart),
        pct: (opts.startPct ?? 0) + i * opts.pctPerStep,
        slot: opts.slot,
      }),
    );
  }
  return points;
}

/** The hours that carry a non-zero rate, as `[hour, rate]` pairs. */
function busyHours(hourly: number[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let hour = 0; hour < hourly.length; hour += 1) {
    const rate = hourly[hour] ?? 0;
    if (rate !== 0) out.push([hour, rate]);
  }
  return out;
}

// ---------------------------------------------------------------------------

describe('local-time helpers', () => {
  it.each([
    ['UTC reads straight through', Date.parse('2026-08-24T14:00:00Z'), 0, 14],
    ['a negative offset pulls the hour back', Date.parse('2026-08-24T14:00:00Z'), TZ, 9],
    ['a half-hour offset lands on the hour', Date.parse('2026-08-24T03:30:00Z'), 330, 9],
    ['crossing back over midnight', Date.parse('2026-08-24T02:00:00Z'), TZ, 21],
    ['before the epoch, floor-mod not sign-mod', Date.parse('1969-12-31T23:30:00Z'), 0, 23],
  ])('localHourAt: %s', (_label, t, tz, expected) => {
    expect(localHourAt(t, tz)).toBe(expected);
  });

  it('localHourAt answers 0 rather than NaN for a junk instant', () => {
    expect(localHourAt(Number.NaN, TZ)).toBe(0);
  });

  it('localDayIndex separates two instants the offset puts on different days', () => {
    const lateEvening = Date.parse('2026-08-24T02:00:00Z'); // 21:00 on the 23rd at UTC-5
    const nextMorning = Date.parse('2026-08-24T14:00:00Z'); // 09:00 on the 24th
    expect(localDayIndex(nextMorning, TZ) - localDayIndex(lateEvening, TZ)).toBe(1);
    // In UTC both are the same calendar day, so the offset is doing real work.
    expect(localDayIndex(nextMorning, 0)).toBe(localDayIndex(lateEvening, 0));
  });

  it.each([
    [Date.parse('2026-08-24T14:00:00Z'), TZ, '2026-08-24'],
    [Date.parse('2026-08-24T02:00:00Z'), TZ, '2026-08-23'],
    [Date.parse('2026-08-23T18:30:00Z'), 330, '2026-08-24'],
  ])('localDayKey(%i, %i) is %s', (t, tz, expected) => {
    expect(localDayKey(t, tz)).toBe(expected);
  });

  it('localDayKey falls back to the epoch for a junk instant', () => {
    expect(localDayKey(Number.NaN, TZ)).toBe('1970-01-01');
  });

  it.each([
    ['Monday morning', Date.parse('2026-08-24T14:00:00Z'), TZ, 1],
    ['still Sunday locally', Date.parse('2026-08-24T02:00:00Z'), TZ, 0],
    ['Monday in UTC', MONDAY_UTC, 0, 1],
  ])('localWeekday: %s', (_label, t, tz, expected) => {
    expect(localWeekday(t, tz)).toBe(expected);
  });

  it.each([
    [-30, 1410],
    [1440, 0],
    [1441, 1],
    [90.4, 90],
    [Number.NaN, 0],
  ])('normalizeMinute(%s) is %i', (input, expected) => {
    expect(normalizeMinute(input)).toBe(expected);
  });

  it.each([
    ['a same-day span', { start: 9 * 60, end: 18 * 60 }, 540],
    ['a span past midnight', { start: 22 * 60, end: 6 * 60 }, 480],
    ['equal endpoints, read as a whole day', { start: 9 * 60, end: 9 * 60 }, 1440],
  ])('spanLengthMin: %s', (_label, span, expected) => {
    expect(spanLengthMin(span)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------

describe('emptyProfile', () => {
  it('is 24 zeroed hours with no confidence and no days', () => {
    const profile = emptyProfile();
    expect(profile.hourly).toHaveLength(24);
    expect(profile.samples).toHaveLength(24);
    expect(profile.hourly.every((v) => v === 0)).toBe(true);
    expect(profile.samples.every((v) => v === 0)).toBe(true);
    expect(profile.confidence).toBe(0);
    expect(profile.days).toEqual([]);
  });

  it('hands back a fresh array each call, so a caller cannot poison the next one', () => {
    const first = emptyProfile();
    first.hourly[9] = 99;
    expect(emptyProfile().hourly[9]).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('boundarySignal', () => {
  const RESET = at(14);
  const LATER_RESET = at(19);

  const cases: Array<[string, HistoryPoint, HistoryPoint, BoundarySignal | null]> = [
    [
      'an unchanged reset instant is the same window',
      pt({ at: at(10), pct: 20, resets: RESET }),
      pt({ at: at(11), pct: 30, resets: RESET }),
      null,
    ],
    [
      'a changed reset instant is the window rolling over',
      pt({ at: at(13, 55), pct: 90, resets: RESET }),
      pt({ at: at(14, 5), pct: 5, resets: LATER_RESET }),
      'reset',
    ],
    [
      'an unchanged reset outranks a utilization cliff',
      pt({ at: at(10), pct: 90, resets: RESET }),
      pt({ at: at(11), pct: 5, resets: RESET }),
      null,
    ],
    [
      'an unchanged reset outranks a long silence',
      pt({ at: at(9), pct: 10, resets: RESET }),
      // The reset instant *is* the window's identity, so a 6-hour gap inside one
      // window is still one window, however unlikely the polling schedule.
      pt({ at: at(15), pct: 20, resets: RESET }),
      null,
    ],
    [
      'only the new point knows its reset, and the old one predates the anchor',
      pt({ at: at(8, 55), pct: 90 }),
      pt({ at: at(10), pct: 5, resets: RESET }),
      'anchor',
    ],
    [
      'only the new point knows its reset, and the old one sits inside the window',
      pt({ at: at(10), pct: 5 }),
      pt({ at: at(11), pct: 20, resets: RESET }),
      null,
    ],
    [
      'only the old point knows its reset, and the new one is past it',
      pt({ at: at(13, 55), pct: 90, resets: RESET }),
      pt({ at: at(14), pct: 95 }),
      'anchor',
    ],
    [
      'only the old point knows its reset, and the new one is before it',
      pt({ at: at(13), pct: 90, resets: RESET }),
      pt({ at: at(13, 59), pct: 95 }),
      null,
    ],
    [
      'no resets at all: a drop past the rounding allowance is the boundary',
      pt({ at: at(10), pct: 40 }),
      pt({ at: at(10, 30), pct: 5 }),
      'drop',
    ],
    [
      'no resets at all: a one-point dip is rounding, not a reset',
      pt({ at: at(10), pct: 40 }),
      pt({ at: at(10, 30), pct: 39 }),
      null,
    ],
    [
      'no resets at all: a silence longer than the window must contain one',
      pt({ at: at(9), pct: 10 }),
      pt({ at: at(9) + FIVE_HOUR_MS + MINUTE, pct: 20 }),
      'gap',
    ],
    [
      'no resets at all: a silence of exactly one window is not yet a boundary',
      pt({ at: at(9), pct: 10 }),
      pt({ at: at(9) + FIVE_HOUR_MS, pct: 20 }),
      null,
    ],
    [
      'two accounts never share a window, whatever their resets say',
      pt({ at: at(10), pct: 20, resets: RESET, slot: 1 }),
      pt({ at: at(10, 5), pct: 30, resets: RESET, slot: 2 }),
      'slot',
    ],
  ];

  it.each(cases)('%s', (_label, prev, cur, expected) => {
    expect(boundarySignal(prev, cur, PLANNER_WINDOW_KEY)).toBe(expected);
  });

  it('reports nothing for a window key neither point carries', () => {
    const prev = pt({ at: at(10), pct: 90 });
    const cur = pt({ at: at(11), pct: 5 });
    expect(boundarySignal(prev, cur, '7d')).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('segmentByWindow', () => {
  it('splits where the reported reset instant changes', () => {
    const points = [
      pt({ at: at(10), pct: 40, resets: at(14) }),
      pt({ at: at(13), pct: 80, resets: at(14) }),
      pt({ at: at(14, 5), pct: 3, resets: at(19) }),
      pt({ at: at(15), pct: 12, resets: at(19) }),
    ];
    const segments = segmentByWindow(points, PLANNER_WINDOW_KEY);
    expect(segments.map((s) => s.length)).toEqual([2, 2]);
    expect(segments[0]?.map((p) => p.t)).toEqual([at(10), at(13)]);
    expect(segments[1]?.map((p) => p.t)).toEqual([at(14, 5), at(15)]);
  });

  it('keeps one segment when the reset instant holds across a utilization cliff', () => {
    // A cliff with an unchanged reset is a reporting artefact, not a rollover.
    const points = [
      pt({ at: at(10), pct: 90, resets: at(14) }),
      pt({ at: at(11), pct: 4, resets: at(14) }),
      pt({ at: at(12), pct: 20, resets: at(14) }),
    ];
    expect(segmentByWindow(points, PLANNER_WINDOW_KEY)).toHaveLength(1);
  });

  it('splits on a drop when no point carries a reset — the pre-planner history path', () => {
    const points = [
      pt({ at: at(10), pct: 60 }),
      pt({ at: at(11), pct: 95 }),
      pt({ at: at(12), pct: 6 }),
      pt({ at: at(13), pct: 18 }),
    ];
    const segments = segmentByWindow(points, PLANNER_WINDOW_KEY);
    expect(segments.map((s) => s.map((p) => p.t))).toEqual([
      [at(10), at(11)],
      [at(12), at(13)],
    ]);
  });

  it('does not split for a dip inside the rounding allowance', () => {
    const points = [
      pt({ at: at(10), pct: 60 }),
      pt({ at: at(10, 30), pct: 59 }),
      pt({ at: at(11), pct: 62 }),
    ];
    expect(segmentByWindow(points, PLANNER_WINDOW_KEY)).toHaveLength(1);
  });

  it('splits on a silence longer than the window itself', () => {
    const points = [
      pt({ at: at(9), pct: 10 }),
      pt({ at: at(9) + FIVE_HOUR_MS + MINUTE, pct: 20 }),
    ];
    expect(segmentByWindow(points, PLANNER_WINDOW_KEY).map((s) => s.length)).toEqual([1, 1]);
  });

  it('sorts before segmenting, and leaves the input array alone', () => {
    const shuffled = [
      pt({ at: at(12), pct: 30 }),
      pt({ at: at(10), pct: 10 }),
      pt({ at: at(11), pct: 20 }),
    ];
    const order = shuffled.map((p) => p.t);
    const segments = segmentByWindow(shuffled, PLANNER_WINDOW_KEY);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.map((p) => p.t)).toEqual([at(10), at(11), at(12)]);
    expect(shuffled.map((p) => p.t)).toEqual(order);
  });

  it.each([
    ['a point with no 5h reading', pt({ at: at(11), windows: { '7d': 12 } })],
    ['a non-finite reading', pt({ at: at(11), pct: Number.NaN })],
    ['an infinite reading', pt({ at: at(11), pct: Number.POSITIVE_INFINITY })],
    ['a non-finite timestamp', pt({ at: Number.NaN, pct: 30 })],
  ])('drops %s instead of throwing', (_label, junk) => {
    const points = [pt({ at: at(10), pct: 10 }), junk, pt({ at: at(12), pct: 20 })];
    const segments = segmentByWindow(points, PLANNER_WINDOW_KEY);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.map((p) => p.t)).toEqual([at(10), at(12)]);
  });

  it.each([
    ['an empty history', [] as HistoryPoint[], []],
    ['a single point', [pt({ at: at(10), pct: 10 })], [1]],
  ])('handles %s', (_label, points, expected) => {
    expect(segmentByWindow(points, PLANNER_WINDOW_KEY).map((s) => s.length)).toEqual(expected);
  });

  it('shreds interleaved slots rather than mixing two accounts into one window', () => {
    const points = [
      pt({ at: at(10), pct: 10, slot: 1 }),
      pt({ at: at(10, 5), pct: 70, slot: 2 }),
      pt({ at: at(10, 10), pct: 12, slot: 1 }),
    ];
    expect(segmentByWindow(points, PLANNER_WINDOW_KEY).map((s) => s.length)).toEqual([1, 1, 1]);
  });
});

// ---------------------------------------------------------------------------

describe('buildProfile', () => {
  it('turns one morning of polling into a per-hour demand curve', () => {
    // 09:00-12:00, 30 minutes apart, +5 points each: 10 points per hour.
    const points = ramp({ fromHour: 9, toHour: 12, stepMin: 30, pctPerStep: 5 });
    const profile = buildProfile(points, at(13), { tzOffsetMin: TZ });

    expect(busyHours(profile.hourly)).toEqual([
      [9, 10],
      [10, 10],
      [11, 10],
    ]);
    expect(profile.samples[9]).toBe(2);
    expect(profile.samples[11]).toBe(2);
    expect(profile.samples[12]).toBe(0);
    expect(profile.days).toEqual([1]);
  });

  it('attributes an interval spanning an hour boundary pro-rata to both hours', () => {
    // 09:30-10:15 gains 9 points across 45 minutes: 30 of them in hour 9 and 15
    // in hour 10, so hour 9 takes 6 and hour 10 takes 3. The flanking idle
    // intervals only exist to bring both hours up to full coverage.
    const points = [
      pt({ at: at(9), pct: 0 }),
      pt({ at: at(9, 30), pct: 0 }),
      pt({ at: at(10, 15), pct: 9 }),
      pt({ at: at(11), pct: 9 }),
    ];
    const profile = buildProfile(points, at(12), { tzOffsetMin: TZ });

    expect(profile.hourly[9]).toBe(6);
    expect(profile.hourly[10]).toBe(3);
    expect(profile.samples[9]).toBe(2);
    expect(profile.samples[10]).toBe(2);
  });

  it('never subtracts a negative delta from an hour total', () => {
    // The reset instant does not move, so the 30-point fall is noise inside one
    // window. Counting it would report hour 9 as *refunding* quota.
    const points = [
      pt({ at: at(9), pct: 30, resets: at(14) }),
      pt({ at: at(9, 30), pct: 10, resets: at(14) }),
      pt({ at: at(10), pct: 20, resets: at(14) }),
    ];
    const profile = buildProfile(points, at(11), { tzOffsetMin: TZ });

    expect(profile.hourly[9]).toBe(10);
    expect(profile.samples[9]).toBe(2);
  });

  it('never subtracts a sub-epsilon dip from an hour total either', () => {
    const points = [
      pt({ at: at(9), pct: 10 }),
      pt({ at: at(9, 20), pct: 9.5 }),
      pt({ at: at(9, 40), pct: 9.5 }),
      pt({ at: at(10), pct: 10.5 }),
    ];
    const profile = buildProfile(points, at(11), { tzOffsetMin: TZ });

    // 0 + 0 + 1, not -0.5 + 0 + 1.
    expect(profile.hourly[9]).toBe(1);
    expect(profile.samples[9]).toBe(3);
  });

  it('does not carry a delta across a window boundary it inferred from a drop', () => {
    // Pre-planner history: no `resets` anywhere, so 95 -> 6 is the boundary. The
    // 11:00-12:00 interval therefore contributes nothing at all, which is why
    // hour 9 reads 10 (one half-hour of +5, normalized) rather than 5.
    const points = [
      pt({ at: at(9), pct: 90 }),
      pt({ at: at(9, 30), pct: 95 }),
      pt({ at: at(10), pct: 6 }),
      pt({ at: at(10, 30), pct: 16 }),
    ];
    const profile = buildProfile(points, at(11), { tzOffsetMin: TZ });

    expect(profile.hourly[9]).toBe(10);
    expect(profile.hourly[10]).toBe(20);
  });

  it('honours a negative tzOffsetMin when placing the hours', () => {
    const points = ramp({ fromHour: 9, toHour: 12, stepMin: 30, pctPerStep: 5 });
    const local = buildProfile(points, at(13), { tzOffsetMin: TZ });
    const utc = buildProfile(points, at(13), { tzOffsetMin: 0 });

    expect(busyHours(local.hourly).map(([hour]) => hour)).toEqual([9, 10, 11]);
    // The same instants are the early afternoon in UTC: five hours later.
    expect(busyHours(utc.hourly).map(([hour]) => hour)).toEqual([14, 15, 16]);
  });

  it('honours a half-hour positive offset', () => {
    const dayStart = midnight(330);
    const points = [
      pt({ at: at(9, 0, dayStart), pct: 0 }),
      pt({ at: at(9, 30, dayStart), pct: 5 }),
      pt({ at: at(10, 0, dayStart), pct: 10 }),
    ];
    const profile = buildProfile(points, at(11, 0, dayStart), { tzOffsetMin: 330 });

    expect(busyHours(profile.hourly)).toEqual([[9, 10]]);
  });

  it('scales a partly-watched hour up to a full hour once it is worth trusting', () => {
    // 24 minutes is exactly the coverage floor: 4 points in 0.4h is a 10/hour
    // rate, and reporting it as 4 would understate a busy hour.
    const profile = buildProfile(
      [pt({ at: at(9), pct: 0 }), pt({ at: at(9, 24), pct: 4 })],
      at(10),
      { tzOffsetMin: TZ },
    );
    expect(profile.hourly[9]).toBe(10);
  });

  it('refuses to scale a sliver of an hour into a burn rate', () => {
    // 09:50-10:10 watches 10 minutes of each hour. Both stay at zero rather
    // than being multiplied by six, but the observations are still recorded.
    const profile = buildProfile(
      [pt({ at: at(9, 50), pct: 0 }), pt({ at: at(10, 10), pct: 12 })],
      at(11),
      { tzOffsetMin: TZ },
    );

    expect(profile.hourly[9]).toBe(0);
    expect(profile.hourly[10]).toBe(0);
    expect(profile.samples[9]).toBe(1);
    expect(profile.samples[10]).toBe(1);
    expect(profile.confidence).toBe(0);
    expect(profile.days).toEqual([1]);
  });

  it('sums two accounts into one fleet-wide curve when no slot is named', () => {
    // Whichever account is active absorbs the demand, so parallel polling must
    // add up rather than average out.
    const points = [
      pt({ at: at(9), pct: 0, slot: 1 }),
      pt({ at: at(10), pct: 5, slot: 1 }),
      pt({ at: at(9), pct: 20, slot: 2 }),
      pt({ at: at(10), pct: 25, slot: 2 }),
    ];
    const fleet = buildProfile(points, at(11), { tzOffsetMin: TZ });
    const one = buildProfile(points, at(11), { tzOffsetMin: TZ, slot: 1 });

    expect(fleet.hourly[9]).toBe(10);
    expect(fleet.samples[9]).toBe(2);
    expect(one.hourly[9]).toBe(5);
    expect(one.samples[9]).toBe(1);
  });

  it('keeps only the weekdays asked for', () => {
    const sunday = ramp({
      dayStart: DAY_START - DAY,
      fromHour: 14,
      toHour: 16,
      stepMin: 30,
      pctPerStep: 5,
    });
    const monday = ramp({ fromHour: 9, toHour: 11, stepMin: 30, pctPerStep: 5 });
    const points = [...sunday, ...monday];

    const weekdays = buildProfile(points, at(12), { tzOffsetMin: TZ, days: [1] });
    expect(busyHours(weekdays.hourly).map(([hour]) => hour)).toEqual([9, 10]);
    expect(weekdays.days).toEqual([1]);

    const weekend = buildProfile(points, at(12), { tzOffsetMin: TZ, days: [0] });
    expect(busyHours(weekend.hourly).map(([hour]) => hour)).toEqual([14, 15]);
    expect(weekend.days).toEqual([0]);
  });

  it('reports nothing when the day filter excludes every day', () => {
    const points = ramp({ fromHour: 9, toHour: 12, stepMin: 30, pctPerStep: 5 });
    expect(buildProfile(points, at(13), { tzOffsetMin: TZ, days: [] })).toEqual(emptyProfile());
  });

  it('leaves idle days out of the mean, so a quiet day cannot flatten the curve', () => {
    const busyDay = ramp({ fromHour: 9, toHour: 11, stepMin: 30, pctPerStep: 5 });
    const idleDay = ramp({
      dayStart: DAY_START - DAY,
      fromHour: 14,
      toHour: 16,
      stepMin: 30,
      pctPerStep: 0,
    });
    const profile = buildProfile([...idleDay, ...busyDay], at(12), { tzOffsetMin: TZ });

    expect(profile.hourly[9]).toBe(10);
    expect(profile.hourly[14]).toBe(0);
    // The idle day contributed no observations either: it was never an active day.
    expect(profile.samples[14]).toBe(0);
    expect(profile.days).toEqual([1]);
  });

  it('reports an empty profile when every day was idle', () => {
    const flat = ramp({ fromHour: 9, toHour: 17, stepMin: 30, pctPerStep: 0, startPct: 40 });
    expect(buildProfile(flat, at(18), { tzOffsetMin: TZ })).toEqual(emptyProfile());
  });

  it('profiles the 5h window only, ignoring a weekly window that is climbing', () => {
    const points = [
      pt({ at: at(9), windows: { '5h': 20, '7d': 10 } }),
      pt({ at: at(10), windows: { '5h': 20, '7d': 30 } }),
    ];
    expect(buildProfile(points, at(11), { tzOffsetMin: TZ })).toEqual(emptyProfile());
  });

  it('scores a thin history as thin, and a week of it as trustworthy', () => {
    const thin = buildProfile(ramp({ fromHour: 9, toHour: 12, stepMin: 30, pctPerStep: 5 }), at(13), {
      tzOffsetMin: TZ,
    });
    // Three hours of one day: 0.375 * (0.2 + 3h/7d) / 2.
    expect(thin.confidence).toBe(0.041);
    expect(thin.confidence).toBeLessThan(MIN_ACTIONABLE_CONFIDENCE);
    expect(thin.samples.filter((s) => s > 0)).toHaveLength(3);

    const week = Array.from({ length: 7 }, (_, d) =>
      ramp({
        dayStart: DAY_START - (6 - d) * DAY,
        fromHour: 9,
        toHour: 17,
        stepMin: 30,
        pctPerStep: 5,
      }),
    ).flat();
    const rich = buildProfile(week, at(18), { tzOffsetMin: TZ });

    // Eight hours covered, seven active days, a 152-hour span: 1 * (1 + 152/168) / 2.
    expect(rich.confidence).toBe(0.952);
    expect(rich.confidence).toBeGreaterThan(MIN_ACTIONABLE_CONFIDENCE);
    expect(rich.hourly[9]).toBe(10);
    expect(rich.hourly[16]).toBe(10);
    expect(rich.hourly[17]).toBe(0);
    expect(rich.samples[9]).toBe(14);
    expect(rich.days).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('ignores points older than the lookback window', () => {
    const old = ramp({
      dayStart: DAY_START - 5 * DAY,
      fromHour: 9,
      toHour: 12,
      stepMin: 30,
      pctPerStep: 5,
    });
    expect(buildProfile(old, at(13), { tzOffsetMin: TZ, lookbackDays: 1 })).toEqual(emptyProfile());
    // The same points are inside the default lookback.
    expect(buildProfile(old, at(13), { tzOffsetMin: TZ }).hourly[9]).toBe(10);
    expect(DEFAULT_LOOKBACK_DAYS).toBe(21);
  });

  it('ignores points from the future, which are clock skew rather than data', () => {
    const points = [
      pt({ at: at(9), pct: 0 }),
      pt({ at: at(10), pct: 10 }),
      pt({ at: at(15), pct: 60 }),
    ];
    const profile = buildProfile(points, at(11), { tzOffsetMin: TZ });
    expect(busyHours(profile.hourly)).toEqual([[9, 10]]);
  });

  it('gives the same answer whatever order the points arrive in', () => {
    const points = ramp({ fromHour: 9, toHour: 12, stepMin: 30, pctPerStep: 5 });
    const shuffled = [...points].reverse();
    expect(buildProfile(shuffled, at(13), { tzOffsetMin: TZ })).toEqual(
      buildProfile(points, at(13), { tzOffsetMin: TZ }),
    );
  });

  it.each([
    ['an empty history', [] as HistoryPoint[], at(13)],
    ['a single point', [pt({ at: at(9), pct: 20 })], at(13)],
    ['points with no 5h reading', [pt({ at: at(9), windows: {} }), pt({ at: at(10), windows: {} })], at(13)],
    [
      'non-finite readings',
      [pt({ at: at(9), pct: Number.NaN }), pt({ at: at(10), pct: Number.POSITIVE_INFINITY })],
      at(13),
    ],
    ['a non-finite now', ramp({ fromHour: 9, toHour: 12, stepMin: 30, pctPerStep: 5 }), Number.NaN],
  ])('answers with an empty profile for %s', (_label, points, now) => {
    expect(buildProfile(points, now, { tzOffsetMin: TZ })).toEqual(emptyProfile());
  });

  it('survives junk options without throwing', () => {
    const points = ramp({ fromHour: 9, toHour: 12, stepMin: 30, pctPerStep: 5 });
    expect(() =>
      buildProfile(points, at(13), {
        tzOffsetMin: Number.NaN,
        lookbackDays: -5,
        slot: Number.NaN,
      }),
    ).not.toThrow();
    // A negative lookback is clamped to zero, which leaves nothing in range.
    expect(buildProfile(points, at(13), { lookbackDays: -5 })).toEqual(emptyProfile());
  });

  it('tolerates readings outside 0-100 rather than rejecting the series', () => {
    const points = [
      pt({ at: at(9), pct: -10 }),
      pt({ at: at(10), pct: 0 }),
      pt({ at: at(11), pct: 140 }),
    ];
    const profile = buildProfile(points, at(12), { tzOffsetMin: TZ });
    expect(profile.hourly[9]).toBe(10);
    expect(profile.hourly[10]).toBe(140);
  });
});

// ---------------------------------------------------------------------------

describe('flatProfile', () => {
  it('spreads a rate across the working day and nowhere else', () => {
    const profile = flatProfile(10, { start: 9 * 60, end: 18 * 60 });
    expect(busyHours(profile.hourly)).toEqual([
      [9, 10],
      [10, 10],
      [11, 10],
      [12, 10],
      [13, 10],
      [14, 10],
      [15, 10],
      [16, 10],
      [17, 10],
    ]);
    expect(profile.hourly.reduce((a, b) => a + b, 0)).toBe(90);
  });

  it('bills a half-covered hour half the rate', () => {
    const profile = flatProfile(12, { start: 9 * 60 + 30, end: 18 * 60 });
    expect(profile.hourly[9]).toBe(6);
    expect(profile.hourly[10]).toBe(12);
    expect(profile.hourly.reduce((a, b) => a + b, 0)).toBe(102);
  });

  it('wraps a night shift around midnight', () => {
    const profile = flatProfile(10, { start: 22 * 60, end: 6 * 60 });
    expect(busyHours(profile.hourly).map(([hour]) => hour)).toEqual([0, 1, 2, 3, 4, 5, 22, 23]);
    expect(profile.hourly[21]).toBe(0);
  });

  it('reads equal endpoints as a whole day', () => {
    const profile = flatProfile(1, { start: 9 * 60, end: 9 * 60 });
    expect(profile.hourly.every((v) => v === 1)).toBe(true);
  });

  it('is honest about being a placeholder: no samples, no confidence', () => {
    const profile = flatProfile(10, { start: 9 * 60, end: 18 * 60 });
    expect(profile.samples.every((v) => v === 0)).toBe(true);
    expect(profile.confidence).toBe(0);
    expect(profile.confidence).toBeLessThan(MIN_ACTIONABLE_CONFIDENCE);
    expect(profile.days).toEqual([]);
  });

  it.each([
    ['zero', 0],
    ['negative', -5],
    ['not a number', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
  ])('returns an empty profile for a %s rate', (_label, rate) => {
    expect(flatProfile(rate, { start: 9 * 60, end: 18 * 60 })).toEqual(emptyProfile());
  });
});
