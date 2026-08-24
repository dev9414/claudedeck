/**
 * `src/core/schedule.ts` — the user's declared working hours.
 *
 * Two things get the most attention. First, midnight-crossing spans: a night
 * shift is a real schedule and every helper has to agree on what "inside" means
 * when `end <= start`. Second, the local-time helpers, which are pure integer
 * arithmetic over a timezone offset rather than `Date`, and so are exactly the
 * kind of code that is confidently wrong by one day.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SCHEDULE,
  MINUTES_PER_DAY,
  formatHHMM,
  localDayStart,
  localWeekday,
  normalizeSchedule,
  overlapMin,
  parseHHMM,
  resolveSchedule,
  spanContains,
  spanLengthMin,
  validateSchedule,
} from '@core/schedule';
import type { Weekday, WorkSchedule } from '@shared/types';

const HOUR = 60;
const at = (h: number, m = 0) => h * HOUR + m;

function schedule(over: Partial<WorkSchedule> = {}): WorkSchedule {
  return { ...DEFAULT_SCHEDULE, ...over };
}

describe('parseHHMM', () => {
  it.each([
    ['00:00', 0],
    ['09:30', 570],
    ['9:05', 545],
    ['23:59', 1439],
    ['  10:15  ', 615],
  ])('parses %s', (input, expected) => {
    expect(parseHHMM(input)).toBe(expected);
  });

  it.each(['', 'noon', '24:00', '12:60', '-1:00', '12', '12:5', '1:2:3', '12:0a'])(
    'rejects %s',
    (input) => {
      expect(parseHHMM(input)).toBeNull();
    },
  );
});

describe('formatHHMM', () => {
  it.each([
    [0, '00:00'],
    [570, '09:30'],
    [1439, '23:59'],
  ])('formats %i as %s', (input, expected) => {
    expect(formatHHMM(input)).toBe(expected);
  });

  it('wraps out-of-range values instead of throwing', () => {
    expect(formatHHMM(MINUTES_PER_DAY)).toBe('00:00');
    expect(formatHHMM(-60)).toBe('23:00');
  });

  it('round-trips with parseHHMM across every minute of the day', () => {
    for (let m = 0; m < MINUTES_PER_DAY; m++) {
      expect(parseHHMM(formatHHMM(m))).toBe(m);
    }
  });
});

describe('spanLengthMin', () => {
  it('measures a same-day span', () => {
    expect(spanLengthMin({ start: at(9), end: at(18) })).toBe(9 * HOUR);
  });

  it('measures a span that crosses midnight', () => {
    // 22:00 -> 06:00 is eight hours, not minus sixteen.
    expect(spanLengthMin({ start: at(22), end: at(6) })).toBe(8 * HOUR);
  });

  it('reads equal endpoints as a whole day, so the mistake is visible', () => {
    expect(spanLengthMin({ start: at(9), end: at(9) })).toBe(MINUTES_PER_DAY);
  });
});

describe('spanContains', () => {
  const day = { start: at(9), end: at(18) };
  const night = { start: at(22), end: at(6) };

  it('is half-open on a same-day span', () => {
    expect(spanContains(day, at(9))).toBe(true);
    expect(spanContains(day, at(17, 59))).toBe(true);
    expect(spanContains(day, at(18))).toBe(false);
    expect(spanContains(day, at(8, 59))).toBe(false);
  });

  it('wraps correctly on a midnight-crossing span', () => {
    expect(spanContains(night, at(23))).toBe(true);
    expect(spanContains(night, at(0))).toBe(true);
    expect(spanContains(night, at(5, 59))).toBe(true);
    expect(spanContains(night, at(6))).toBe(false);
    expect(spanContains(night, at(12))).toBe(false);
  });
});

describe('overlapMin', () => {
  it('is the full peak when peak sits inside work', () => {
    const peak = { start: at(10), end: at(13) };
    expect(overlapMin(peak, { start: at(9), end: at(18) })).toBe(3 * HOUR);
  });

  it('counts only the overlapping part when peak spills out', () => {
    // 08:00-10:00 against a 09:00-18:00 day: only the 09:00-10:00 hour counts.
    expect(overlapMin({ start: at(8), end: at(10) }, { start: at(9), end: at(18) })).toBe(HOUR);
  });

  it('is zero when they are disjoint', () => {
    expect(overlapMin({ start: at(1), end: at(2) }, { start: at(9), end: at(18) })).toBe(0);
  });
});

describe('validateSchedule', () => {
  it('accepts the shipped default', () => {
    expect(validateSchedule(DEFAULT_SCHEDULE)).toEqual([]);
  });

  it('requires a label', () => {
    expect(validateSchedule(schedule({ label: '   ' })).join(' ')).toContain('name');
  });

  it('requires at least one day', () => {
    expect(validateSchedule(schedule({ days: [] })).join(' ')).toContain('at least one day');
  });

  it('rejects an out-of-range day', () => {
    expect(validateSchedule(schedule({ days: [7 as Weekday] })).join(' ')).toContain('0 (Sunday)');
  });

  it('rejects a duplicated day', () => {
    expect(validateSchedule(schedule({ days: [1, 1] })).join(' ')).toContain('more than once');
  });

  it('flags a peak longer than the working day', () => {
    const s = schedule({ work: { start: at(9), end: at(11) }, peak: { start: at(8), end: at(16) } });
    expect(validateSchedule(s).join(' ')).toContain('longer than the working day');
  });

  it('flags a peak that spills outside working hours', () => {
    const s = schedule({ work: { start: at(9), end: at(18) }, peak: { start: at(7), end: at(10) } });
    expect(validateSchedule(s).join(' ')).toContain('outside your working hours');
  });

  it('flags a working day too short to plan against', () => {
    const s = schedule({ work: { start: at(9), end: at(9, 10) }, peak: { start: at(9), end: at(9, 5) } });
    expect(validateSchedule(s).join(' ')).toContain('nothing to plan');
  });
});

describe('resolveSchedule', () => {
  const weekdays = schedule({ label: 'Weekdays', days: [1, 2, 3, 4, 5] });
  const saturday = schedule({ label: 'Saturday', days: [6] });

  it('finds the schedule covering a day', () => {
    expect(resolveSchedule([weekdays, saturday], 3)?.label).toBe('Weekdays');
    expect(resolveSchedule([weekdays, saturday], 6)?.label).toBe('Saturday');
  });

  it('returns null when no schedule covers the day', () => {
    expect(resolveSchedule([weekdays], 0)).toBeNull();
  });

  it('lets an earlier entry win, so a specific day can sit in front of a general one', () => {
    const wednesday = schedule({ label: 'Deep work Wednesday', days: [3] });
    expect(resolveSchedule([wednesday, weekdays], 3)?.label).toBe('Deep work Wednesday');
  });

  it('returns null for an empty list', () => {
    expect(resolveSchedule([], 1)).toBeNull();
  });
});

describe('normalizeSchedule', () => {
  it('dedupes and sorts days, and trims the label', () => {
    const out = normalizeSchedule(schedule({ label: '  Weekdays  ', days: [5, 1, 5, 3] }));
    expect(out.label).toBe('Weekdays');
    expect(out.days).toEqual([1, 3, 5]);
  });

  it('drops days outside 0..6 rather than clamping them into a real day', () => {
    expect(normalizeSchedule(schedule({ days: [-1 as Weekday, 2, 9 as Weekday] })).days).toEqual([2]);
  });

  it('names an unlabelled schedule instead of leaving it blank', () => {
    expect(normalizeSchedule(schedule({ label: '' })).label).toBe('Untitled');
  });

  it('wraps non-finite times to a real minute', () => {
    const out = normalizeSchedule(
      schedule({ work: { start: Number.NaN, end: Number.POSITIVE_INFINITY } }),
    );
    expect(out.work.start).toBe(0);
    expect(out.work.end).toBe(0);
  });
});

describe('local time helpers', () => {
  // 2026-08-24T00:00:00Z was a Monday.
  const mondayUtc = Date.UTC(2026, 7, 24, 0, 0, 0);

  it('reports the weekday in UTC', () => {
    expect(localWeekday(mondayUtc, 0)).toBe(1);
    expect(localWeekday(mondayUtc + 6 * 86_400_000, 0)).toBe(0); // the Sunday after
  });

  it('agrees with Date#getUTCDay across a fortnight', () => {
    for (let i = 0; i < 14; i++) {
      const t = mondayUtc + i * 86_400_000 + 13 * 3_600_000;
      expect(localWeekday(t, 0)).toBe(new Date(t).getUTCDay());
    }
  });

  it('rolls the weekday forward for an offset that pushes past midnight', () => {
    // 23:30 UTC Monday is 01:00 Tuesday at +90 minutes.
    const lateMonday = mondayUtc + 23 * 3_600_000 + 30 * 60_000;
    expect(localWeekday(lateMonday, 0)).toBe(1);
    expect(localWeekday(lateMonday, 90)).toBe(2);
  });

  it('rolls the weekday back for a negative offset', () => {
    // 00:30 UTC Monday is 19:30 Sunday at -300 minutes (US Eastern, DST).
    const earlyMonday = mondayUtc + 30 * 60_000;
    expect(localWeekday(earlyMonday, 0)).toBe(1);
    expect(localWeekday(earlyMonday, -300)).toBe(0);
  });

  it('puts local midnight before the instant, and exactly one day wide', () => {
    for (const tz of [0, 90, 330, -300, -480, 720]) {
      const t = mondayUtc + 15 * 3_600_000 + 37 * 60_000;
      const start = localDayStart(t, tz);
      expect(start).toBeLessThanOrEqual(t);
      expect(t - start).toBeLessThan(MINUTES_PER_DAY * 60_000);
      // Local midnight means the local clock reads 00:00 there.
      expect((start + tz * 60_000) % (MINUTES_PER_DAY * 60_000)).toBe(0);
    }
  });

  it('is stable at the exact boundary', () => {
    const start = localDayStart(mondayUtc, 0);
    expect(localDayStart(start, 0)).toBe(start);
  });
});
