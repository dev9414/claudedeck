/**
 * The user's working hours: parsing, validating and resolving them.
 *
 * The session planner is only as good as the hours it plans against, and those
 * are not something to infer. A burst of 3am commits does not mean 3am is when
 * someone *wants* capacity — it might be the one night they were firefighting.
 * So the schedule is declared, not guessed, and this module is the single place
 * that decides whether a declaration is usable and which one applies to a day.
 *
 * Pure: no I/O, no ambient clock. `DaySpan` values are minutes from local
 * midnight, and a span whose `end` is less than or equal to its `start` is read
 * as running past midnight.
 */

import type { DaySpan, MinuteOfDay, Weekday, WorkSchedule } from '@shared/types';

export const MINUTES_PER_DAY = 24 * 60;

/**
 * What the app assumes until the user says otherwise. Deliberately ordinary:
 * a default that looks like a guess is better than one that looks like a
 * finding. `PlannerConfig.configured` records whether the user has replaced it.
 */
export const DEFAULT_SCHEDULE: WorkSchedule = {
  label: 'Weekdays',
  days: [1, 2, 3, 4, 5],
  work: { start: 9 * 60, end: 18 * 60 },
  peak: { start: 10 * 60, end: 13 * 60 },
};

/** `"09:30"` -> 570. Returns null for anything that is not a real time. */
export function parseHHMM(value: string): MinuteOfDay | null {
  const m = /^\s*(\d{1,2})\s*:\s*(\d{2})\s*$/.exec(value);
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min)) return null;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** 570 -> `"09:30"`. Values outside a day are wrapped, never thrown. */
export function formatHHMM(minute: MinuteOfDay): string {
  const m = ((Math.round(minute) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const h = Math.floor(m / 60);
  return `${String(h).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Length in minutes, treating `end <= start` as running past midnight. */
export function spanLengthMin(span: DaySpan): number {
  const start = normalizeMinute(span.start);
  const end = normalizeMinute(span.end);
  if (end > start) return end - start;
  // Equal endpoints mean a full day rather than nothing: a span has to have
  // some extent to be worth planning against, and zero would silently disable
  // the planner instead of showing the user their mistake.
  return MINUTES_PER_DAY - (start - end);
}

/** True when `minute` falls inside the half-open span, midnight-crossing aware. */
export function spanContains(span: DaySpan, minute: MinuteOfDay): boolean {
  const start = normalizeMinute(span.start);
  const end = normalizeMinute(span.end);
  const m = normalizeMinute(minute);
  return end > start ? m >= start && m < end : m >= start || m < end;
}

/** Minutes of `inner` that fall inside `outer`. Used to check peak ⊆ work. */
export function overlapMin(inner: DaySpan, outer: DaySpan): number {
  let count = 0;
  const start = normalizeMinute(inner.start);
  const length = spanLengthMin(inner);
  for (let i = 0; i < length; i++) {
    if (spanContains(outer, (start + i) % MINUTES_PER_DAY)) count += 1;
  }
  return count;
}

/** Minute-of-day folded into 0..1439. Non-finite input becomes midnight. */
export function normalizeMinute(minute: number): MinuteOfDay {
  if (!Number.isFinite(minute)) return 0;
  return ((Math.round(minute) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

/**
 * Problems with a declared schedule, phrased for the person who typed it.
 * An empty array means it is usable. These are shown next to the editor, so
 * they name the field and what to do, not just what is wrong.
 */
export function validateSchedule(schedule: WorkSchedule): string[] {
  const problems: string[] = [];

  if (!schedule.label.trim()) {
    problems.push('Give this schedule a name, so you can tell it from the others.');
  }
  if (schedule.days.length === 0) {
    problems.push('Pick at least one day, or this schedule will never apply.');
  }
  if (schedule.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    problems.push('Days must be 0 (Sunday) through 6 (Saturday).');
  }
  if (new Set(schedule.days).size !== schedule.days.length) {
    problems.push('The same day is listed more than once.');
  }

  for (const [name, span] of [
    ['Working hours', schedule.work],
    ['Peak hours', schedule.peak],
  ] as const) {
    if (!Number.isFinite(span.start) || !Number.isFinite(span.end)) {
      problems.push(`${name} needs a start and an end time.`);
    }
  }

  const workLen = spanLengthMin(schedule.work);
  const peakLen = spanLengthMin(schedule.peak);

  if (peakLen > workLen) {
    problems.push('Peak hours are longer than the working day — check which is which.');
  }
  if (peakLen > 0 && overlapMin(schedule.peak, schedule.work) < peakLen) {
    problems.push('Peak hours fall partly outside your working hours; the planner will only weight the overlap.');
  }
  if (workLen < 30) {
    problems.push('A working day under 30 minutes leaves nothing to plan.');
  }

  return problems;
}

/**
 * The schedule that applies to `weekday`, or null when none does.
 *
 * Earlier entries win, so a user can keep a specific day in front of a general
 * one without having to prune the general one's `days`.
 */
export function resolveSchedule(
  schedules: readonly WorkSchedule[],
  weekday: Weekday,
): WorkSchedule | null {
  for (const schedule of schedules) {
    if (schedule.days.includes(weekday)) return schedule;
  }
  return null;
}

/**
 * Coerce a schedule into something the simulator can run, without silently
 * "fixing" the user's intent: clamps only what would otherwise break the maths,
 * and leaves questionable-but-workable values alone for `validateSchedule` to
 * report.
 */
export function normalizeSchedule(schedule: WorkSchedule): WorkSchedule {
  return {
    label: schedule.label.trim() || 'Untitled',
    days: [...new Set(schedule.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort(
      (a, b) => a - b,
    ) as Weekday[],
    work: { start: normalizeMinute(schedule.work.start), end: normalizeMinute(schedule.work.end) },
    peak: { start: normalizeMinute(schedule.peak.start), end: normalizeMinute(schedule.peak.end) },
  };
}

/** Epoch ms of local midnight for the day containing `at`. */
export function localDayStart(at: number, tzOffsetMin: number): number {
  const shifted = at + tzOffsetMin * 60_000;
  const dayIndex = Math.floor(shifted / (MINUTES_PER_DAY * 60_000));
  return dayIndex * MINUTES_PER_DAY * 60_000 - tzOffsetMin * 60_000;
}

/** The local weekday of `at`, as `Date#getDay` would report it locally. */
export function localWeekday(at: number, tzOffsetMin: number): Weekday {
  const shifted = at + tzOffsetMin * 60_000;
  const days = Math.floor(shifted / (MINUTES_PER_DAY * 60_000));
  // 1970-01-01 was a Thursday, which is index 4.
  return (((days + 4) % 7) + 7) % 7 as Weekday;
}
