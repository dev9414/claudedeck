/**
 * `src/core/forecast.ts` — burn rate, exhaustion projection, pace.
 *
 * Pure math, so these tests are all table-driven. Two behaviours carry the
 * weight: the fit must restart at a window reset (otherwise it averages a cliff
 * into the slope), and it must refuse to name an exhaustion instant when the
 * data does not support one. A confident-looking lie is worse than "not enough
 * data yet".
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LOOKBACK_MS,
  MIN_PROJECTION_CONFIDENCE,
  burnRate,
  expectedPace,
  forecast,
  forecastWindows,
  seriesFor,
  summarize,
  windowLengthMs,
  type Sample,
} from '@core/forecast';
import type { Forecast, HistoryPoint, UsageWindow } from '@shared/types';

import { DAY, HOUR, MINUTE, T0, isoAt, makeWindow } from '../helpers/fixtures';

/** `count` samples ending at `T0`, `stepMs` apart, rising at `pctPerHour`. */
function ramp(opts: {
  count: number;
  startPct: number;
  pctPerHour: number;
  stepMs: number;
  endAt?: number;
}): Sample[] {
  const endAt = opts.endAt ?? T0;
  const first = endAt - (opts.count - 1) * opts.stepMs;
  return Array.from({ length: opts.count }, (_, i) => {
    const t = first + i * opts.stepMs;
    return { t, pct: opts.startPct + ((t - first) / HOUR) * opts.pctPerHour };
  });
}

// ---------------------------------------------------------------------------

describe('burnRate', () => {
  it.each([
    ['no samples', []],
    ['one sample', [{ t: T0, pct: 50 }]],
  ])('reports zero burn and zero confidence for %s', (_label, points) => {
    const burn = burnRate(points as Sample[], T0);
    expect(burn.pctPerHour).toBe(0);
    expect(burn.confidence).toBe(0);
  });

  it('reports zero when every sample shares one instant', () => {
    const burn = burnRate(
      [
        { t: T0, pct: 10 },
        { t: T0, pct: 20 },
        { t: T0, pct: 30 },
      ],
      T0,
    );
    expect(burn).toEqual({ pctPerHour: 0, samples: 3, confidence: 0 });
  });

  it('fits a clean straight line exactly', () => {
    const burn = burnRate(ramp({ count: 7, startPct: 10, pctPerHour: 12, stepMs: 30 * MINUTE }), T0);
    expect(burn.pctPerHour).toBeCloseTo(12, 3);
    expect(burn.samples).toBe(7);
    // A perfect fit over three hours with seven samples: nothing to doubt.
    expect(burn.confidence).toBeGreaterThan(0.95);
  });

  it('reports a negative slope for a window that is being credited back', () => {
    // A gentle decline is not a reset (see RESET_DROP_PCT); it is just a fit.
    const points = ramp({ count: 6, startPct: 50, pctPerHour: -0.9, stepMs: 20 * MINUTE });
    expect(burnRate(points, T0).pctPerHour).toBeLessThan(0);
  });

  describe('segmenting at a window reset', () => {
    it('ignores everything before the reset cliff', () => {
      const before = ramp({ count: 5, startPct: 60, pctPerHour: 20, stepMs: 20 * MINUTE, endAt: T0 - 3 * HOUR });
      const after = ramp({ count: 5, startPct: 2, pctPerHour: 6, stepMs: 20 * MINUTE });

      const burn = burnRate([...before, ...after], T0, { lookbackMs: 12 * HOUR });

      expect(burn.samples).toBe(after.length);
      expect(burn.pctPerHour).toBeCloseTo(6, 2);
    });

    it('uses only the most recent segment when two resets are in range', () => {
      const points: Sample[] = [
        { t: T0 - 5 * HOUR, pct: 80 },
        { t: T0 - 4.5 * HOUR, pct: 90 },
        { t: T0 - 4 * HOUR, pct: 3 }, // first reset
        { t: T0 - 3.5 * HOUR, pct: 40 },
        { t: T0 - 3 * HOUR, pct: 1 }, // second reset
        { t: T0 - 2 * HOUR, pct: 11 },
        { t: T0 - HOUR, pct: 21 },
        { t: T0, pct: 31 },
      ];
      const burn = burnRate(points, T0, { lookbackMs: 12 * HOUR });

      expect(burn.samples).toBe(4);
      expect(burn.pctPerHour).toBeCloseTo(10, 1);
    });

    it('does not treat a sub-1-point dip as a reset', () => {
      const points: Sample[] = [
        { t: T0 - 3 * HOUR, pct: 30 },
        { t: T0 - 2 * HOUR, pct: 29.5 }, // API rounding, not a rollover
        { t: T0 - HOUR, pct: 40 },
        { t: T0, pct: 50 },
      ];
      expect(burnRate(points, T0, { lookbackMs: 12 * HOUR }).samples).toBe(4);
    });

    it('does treat a drop larger than a point as a reset', () => {
      const points: Sample[] = [
        { t: T0 - 3 * HOUR, pct: 30 },
        { t: T0 - 2 * HOUR, pct: 28.5 },
        { t: T0 - HOUR, pct: 40 },
        { t: T0, pct: 50 },
      ];
      expect(burnRate(points, T0, { lookbackMs: 12 * HOUR }).samples).toBe(3);
    });
  });

  describe('what is excluded from the fit', () => {
    it('drops samples older than the lookback', () => {
      const old = ramp({ count: 5, startPct: 0, pctPerHour: 1, stepMs: HOUR, endAt: T0 - 10 * HOUR });
      const recent = ramp({ count: 4, startPct: 0, pctPerHour: 20, stepMs: 30 * MINUTE });

      expect(burnRate([...old, ...recent], T0).samples).toBe(4);
    });

    it('honours an explicit lookback', () => {
      const points = ramp({ count: 13, startPct: 0, pctPerHour: 5, stepMs: HOUR });
      expect(burnRate(points, T0, { lookbackMs: 2 * HOUR }).samples).toBe(3);
      expect(burnRate(points, T0, { lookbackMs: 12 * HOUR }).samples).toBe(13);
    });

    it('drops samples from the future — that is clock skew, not data', () => {
      const points = [...ramp({ count: 4, startPct: 0, pctPerHour: 5, stepMs: 30 * MINUTE }),
        { t: T0 + HOUR, pct: 999 }];
      const burn = burnRate(points, T0);
      expect(burn.samples).toBe(4);
      expect(burn.pctPerHour).toBeCloseTo(5, 2);
    });

    it.each([
      ['a NaN timestamp', { t: Number.NaN, pct: 50 }],
      ['an Infinity timestamp', { t: Number.POSITIVE_INFINITY, pct: 50 }],
      ['a NaN percentage', { t: T0 - MINUTE, pct: Number.NaN }],
    ])('drops a sample with %s', (_label, junk) => {
      const points = [...ramp({ count: 4, startPct: 0, pctPerHour: 5, stepMs: 30 * MINUTE }), junk];
      expect(burnRate(points as Sample[], T0).samples).toBe(4);
    });

    it('sorts unordered input before fitting', () => {
      const ordered = ramp({ count: 6, startPct: 0, pctPerHour: 8, stepMs: 20 * MINUTE });
      const shuffled = [ordered[3]!, ordered[0]!, ordered[5]!, ordered[1]!, ordered[4]!, ordered[2]!];
      expect(burnRate(shuffled, T0).pctPerHour).toBeCloseTo(burnRate(ordered, T0).pctPerHour, 6);
    });

    it('returns zeros when `now` is not a finite instant', () => {
      const points = ramp({ count: 5, startPct: 0, pctPerHour: 5, stepMs: 30 * MINUTE });
      expect(burnRate(points, Number.NaN)).toEqual({ pctPerHour: 0, samples: 0, confidence: 0 });
    });
  });

  describe('confidence honesty', () => {
    it('stays under the projection floor for two distant samples', () => {
      const burn = burnRate(
        [
          { t: T0 - HOUR, pct: 10 },
          { t: T0, pct: 30 },
        ],
        T0,
      );
      expect(burn.pctPerHour).toBeCloseTo(20, 3);
      expect(burn.confidence).toBeGreaterThan(0);
      expect(burn.confidence).toBeLessThan(MIN_PROJECTION_CONFIDENCE);
    });

    it('collapses to zero once the newest sample is stale', () => {
      const points = ramp({
        count: 6,
        startPct: 0,
        pctPerHour: 10,
        stepMs: 20 * MINUTE,
        endAt: T0 - 3 * HOUR,
      });
      expect(burnRate(points, T0, { lookbackMs: 12 * HOUR }).confidence).toBe(0);
    });

    it('is lower for a noisy series than for a clean one of the same shape', () => {
      const clean = ramp({ count: 8, startPct: 0, pctPerHour: 10, stepMs: 20 * MINUTE });
      const noisy = clean.map((p, i) => ({ t: p.t, pct: p.pct + (i % 2 === 0 ? 8 : -8) }));

      expect(burnRate(noisy, T0).confidence).toBeLessThan(burnRate(clean, T0).confidence);
    });

    it('is lower for a short span than for a long one', () => {
      const short = ramp({ count: 6, startPct: 0, pctPerHour: 10, stepMs: MINUTE });
      const long = ramp({ count: 6, startPct: 0, pctPerHour: 10, stepMs: 20 * MINUTE });
      expect(burnRate(short, T0).confidence).toBeLessThan(burnRate(long, T0).confidence);
    });

    it('is always within 0..1', () => {
      for (const points of [
        ramp({ count: 40, startPct: 0, pctPerHour: 100, stepMs: 5 * MINUTE }),
        ramp({ count: 2, startPct: 99, pctPerHour: 0.001, stepMs: 10 * MINUTE }),
      ]) {
        const c = burnRate(points, T0).confidence;
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
      }
    });
  });

  it('defaults to a six-hour lookback', () => {
    expect(DEFAULT_LOOKBACK_MS).toBe(6 * HOUR);
    const points = ramp({ count: 20, startPct: 0, pctPerHour: 1, stepMs: 30 * MINUTE });
    // 6h of 30-minute samples is 13 points inclusive of both ends.
    expect(burnRate(points, T0).samples).toBe(13);
  });
});

// ---------------------------------------------------------------------------

describe('windowLengthMs', () => {
  it.each([
    ['5h', 5 * HOUR],
    ['  5H  ', 5 * HOUR],
    ['7d', 7 * DAY],
    ['spend', 30 * DAY],
    ['Fable', 7 * DAY],
    ['', 7 * DAY],
  ])('%s -> %d ms', (key, expected) => {
    expect(windowLengthMs(key)).toBe(expected);
  });
});

describe('expectedPace', () => {
  it('is undefined without a reset instant', () => {
    expect(expectedPace(makeWindow('5h', 10), T0)).toBeUndefined();
  });

  it('is undefined for an unparseable reset instant', () => {
    expect(expectedPace(makeWindow('5h', 10, 'never'), T0)).toBeUndefined();
  });

  it('is undefined when the snapshot predates its own rollover', () => {
    expect(expectedPace(makeWindow('5h', 10, isoAt(-MINUTE)), T0)).toBeUndefined();
  });

  it.each([
    ['at the very start of a 5h window', 5 * HOUR, 0],
    ['halfway through a 5h window', 2.5 * HOUR, 50],
    ['four fifths through a 5h window', HOUR, 80],
    ['at the last instant of a 5h window', 0, 100],
  ])('%s reports %d%%', (_label, msToReset, expected) => {
    expect(expectedPace(makeWindow('5h', 0, isoAt(msToReset)), T0)).toBe(expected);
  });

  it('uses the weekly length for 7d and for a scoped model window', () => {
    expect(expectedPace(makeWindow('7d', 0, isoAt(3.5 * DAY)), T0)).toBe(50);
    expect(expectedPace(makeWindow('Fable', 0, isoAt(3.5 * DAY)), T0)).toBe(50);
  });

  it('returns undefined when now is not finite', () => {
    expect(expectedPace(makeWindow('5h', 0, isoAt(HOUR)), Number.NaN)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe('forecast', () => {
  const confidentClimb = (pctPerHour: number, startPct = 0): Sample[] =>
    ramp({ count: 8, startPct, pctPerHour, stepMs: 20 * MINUTE });

  it('treats an already-spent window as an observation, not a projection', () => {
    const out = forecast(makeWindow('5h', 100, isoAt(HOUR)), [], T0);
    expect(out.exhaustionAt).toBe(new Date(T0).toISOString());
    expect(out.lastsToReset).toBe(false);
  });

  it('names no instant when the slope is polling noise', () => {
    const out = forecast(makeWindow('5h', 20, isoAt(HOUR)), confidentClimb(0.01, 20), T0);
    expect(out.exhaustionAt).toBeNull();
    expect(out.lastsToReset).toBe(true);
  });

  it('names no instant when confidence is below the floor', () => {
    const sparse: Sample[] = [
      { t: T0 - 30 * MINUTE, pct: 10 },
      { t: T0, pct: 40 },
    ];
    const out = forecast(makeWindow('5h', 40, isoAt(HOUR)), sparse, T0);
    expect(out.burn.confidence).toBeLessThan(MIN_PROJECTION_CONFIDENCE);
    expect(out.exhaustionAt).toBeNull();
  });

  it('projects the exhaustion instant from the live percentage', () => {
    const out = forecast(makeWindow('5h', 50, isoAt(4 * HOUR)), confidentClimb(25, 10), T0);

    expect(out.burn.pctPerHour).toBeCloseTo(25, 2);
    // 50 points left at 25/h = two hours.
    expect(Date.parse(out.exhaustionAt ?? '')).toBeCloseTo(T0 + 2 * HOUR, -2);
    expect(out.lastsToReset).toBe(false);
  });

  it('says the window survives when the projection lands after the reset', () => {
    const out = forecast(makeWindow('5h', 50, isoAt(HOUR)), confidentClimb(25, 10), T0);
    // Exhaustion in two hours, reset in one: the window rolls over first.
    expect(out.lastsToReset).toBe(true);
  });

  it('will not claim survival when the reset instant is unknown', () => {
    const out = forecast(makeWindow('5h', 50), confidentClimb(25, 10), T0);
    expect(out.exhaustionAt).not.toBeNull();
    expect(out.lastsToReset).toBe(false);
  });

  it('refuses to extrapolate past a month', () => {
    // A confident but glacial 0.06 pct/h would take 1666 hours to spend.
    const out = forecast(makeWindow('7d', 0, isoAt(7 * DAY)), confidentClimb(0.06), T0);
    expect(out.burn.confidence).toBeGreaterThan(MIN_PROJECTION_CONFIDENCE);
    expect(out.exhaustionAt).toBeNull();
  });

  it('falls back to the newest history sample when the live pct is not finite', () => {
    const points = confidentClimb(10, 30);
    const out = forecast({ key: '5h', label: '5h', pct: Number.NaN }, points, T0);
    expect(out.exhaustionAt).not.toBeNull();
  });

  describe('pace', () => {
    it('flags usage meaningfully above the even-spread line', () => {
      // Halfway through the window (expected 50%) but sitting at 90%.
      const out = forecast(makeWindow('5h', 90, isoAt(2.5 * HOUR)), [], T0);
      expect(out.expectedPct).toBe(50);
      expect(out.aheadOfPace).toBe(true);
    });

    it('does not flag usage inside the margin', () => {
      // 15% relative slack on an expected 50 is 7.5 points.
      const out = forecast(makeWindow('5h', 57, isoAt(2.5 * HOUR)), [], T0);
      expect(out.aheadOfPace).toBe(false);
    });

    it('applies the absolute floor early in a window', () => {
      // Expected 10%; the 5-point floor beats the 1.5-point relative slack.
      expect(forecast(makeWindow('5h', 14, isoAt(4.5 * HOUR)), [], T0).aheadOfPace).toBe(false);
      expect(forecast(makeWindow('5h', 16, isoAt(4.5 * HOUR)), [], T0).aheadOfPace).toBe(true);
    });

    it('cannot be ahead of pace without a reset instant to measure against', () => {
      const out = forecast(makeWindow('5h', 99), [], T0);
      expect(out.expectedPct).toBeUndefined();
      expect(out.aheadOfPace).toBe(false);
    });
  });

  it('carries the window key through', () => {
    expect(forecast(makeWindow('Fable', 10), [], T0).windowKey).toBe('Fable');
  });
});

// ---------------------------------------------------------------------------

describe('seriesFor', () => {
  const points: HistoryPoint[] = [
    { t: T0, slot: 1, windows: { '5h': 30, '7d': 8 } },
    { t: T0 - HOUR, slot: 1, windows: { '5h': 20 } },
    { t: T0 - 2 * HOUR, slot: 1, windows: { '7d': 6 } },
    { t: T0 - 3 * HOUR, slot: 1, windows: { '5h': Number.NaN } },
  ];

  it('pulls one window out, oldest first', () => {
    expect(seriesFor(points, '5h')).toEqual([
      { t: T0 - HOUR, pct: 20 },
      { t: T0, pct: 30 },
    ]);
  });

  it('returns an empty series for a window nobody recorded', () => {
    expect(seriesFor(points, 'Nonexistent')).toEqual([]);
    expect(seriesFor([], '5h')).toEqual([]);
  });
});

describe('forecastWindows', () => {
  it('forecasts each window against its own series', () => {
    const points: HistoryPoint[] = Array.from({ length: 8 }, (_, i) => ({
      t: T0 - (7 - i) * 20 * MINUTE,
      slot: 1,
      windows: { '5h': i * 5, '7d': i },
    }));

    const out = forecastWindows([makeWindow('5h', 40), makeWindow('7d', 8)], points, T0);

    expect(out.map((f) => f.windowKey)).toEqual(['5h', '7d']);
    expect(out[0]!.burn.pctPerHour).toBeGreaterThan(out[1]!.burn.pctPerHour);
  });

  it('returns nothing for no windows', () => {
    expect(forecastWindows([], [], T0)).toEqual([]);
  });
});

describe('summarize', () => {
  const at = (iso: string | null, pctPerHour = 1, aheadOfPace = false): Forecast => ({
    windowKey: iso ?? 'none',
    burn: { pctPerHour, samples: 5, confidence: 0.9 },
    exhaustionAt: iso,
    lastsToReset: iso === null,
    aheadOfPace,
  });

  it('reports no worst window when nothing is projected to run out', () => {
    expect(summarize([at(null), at(null)])).toEqual({ worst: null, anyAheadOfPace: false });
  });

  it('picks the soonest projected exhaustion', () => {
    const soon = at(isoAt(HOUR));
    const later = at(isoAt(5 * HOUR));
    expect(summarize([later, soon, at(null)]).worst).toBe(soon);
  });

  it('breaks a tie on the faster burn', () => {
    const slow = at(isoAt(HOUR), 3);
    const fast = at(isoAt(HOUR), 30);
    expect(summarize([slow, fast]).worst).toBe(fast);
    expect(summarize([fast, slow]).worst).toBe(fast);
  });

  it('ignores an unparseable exhaustion instant', () => {
    expect(summarize([at('not a date')]).worst).toBeNull();
  });

  it('raises the pace flag if any window is ahead', () => {
    expect(summarize([at(null), at(null, 1, true)]).anyAheadOfPace).toBe(true);
  });

  it('handles an empty list', () => {
    expect(summarize([])).toEqual({ worst: null, anyAheadOfPace: false });
  });
});
