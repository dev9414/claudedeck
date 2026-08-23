/**
 * Scale and format math for the chart kit.
 *
 * Everything here is pure and DOM-free so the axis, tick and projection
 * decisions can be unit-tested without rendering, and so no chart re-derives
 * them slightly differently.
 */

// ---------------------------------------------------------------------------
// Scales
// ---------------------------------------------------------------------------

export interface Scale {
  /** Domain value -> pixel position. */
  map(value: number): number;
  /** Pixel position -> domain value. */
  invert(position: number): number;
  readonly domain: readonly [number, number];
  readonly range: readonly [number, number];
}

export interface ScaleOptions {
  /** Clamp results into the range/domain. Off by default so overshoot shows. */
  clamp?: boolean;
}

export function clamp(value: number, min: number, max: number): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  if (!Number.isFinite(value)) return lo;
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

/**
 * A linear mapping between two intervals.
 *
 * A zero-width domain is the normal case for a single observation or a totally
 * flat series, so it maps to the middle of the range rather than producing NaN
 * and a broken axis.
 */
export function linearScale(
  domain: readonly [number, number],
  range: readonly [number, number],
  options: ScaleOptions = {},
): Scale {
  const d0 = domain[0];
  const d1 = domain[1];
  const r0 = range[0];
  const r1 = range[1];
  const dSpan = d1 - d0;
  const rSpan = r1 - r0;
  const flatDomain = !Number.isFinite(dSpan) || dSpan === 0;
  const flatRange = !Number.isFinite(rSpan) || rSpan === 0;
  const mid = (r0 + r1) / 2;

  const map = (value: number): number => {
    if (!Number.isFinite(value) || flatDomain) return mid;
    const pos = r0 + ((value - d0) / dSpan) * rSpan;
    return options.clamp ? clamp(pos, r0, r1) : pos;
  };

  const invert = (position: number): number => {
    if (!Number.isFinite(position) || flatDomain || flatRange) return d0;
    const value = d0 + ((position - r0) / rSpan) * dSpan;
    return options.clamp ? clamp(value, d0, d1) : value;
  };

  return { map, invert, domain: [d0, d1], range: [r0, r1] };
}

/** Half an hour, used to give a single-observation time domain some width. */
const SINGLE_POINT_PAD_MS = 30 * 60 * 1000;

/**
 * Linear scale over epoch milliseconds. Identical to `linearScale` except that
 * an empty time span is padded, so one recorded point still lands mid-plot with
 * usable ticks either side of it.
 */
export function timeScale(
  domain: readonly [number, number],
  range: readonly [number, number],
  options: ScaleOptions = {},
): Scale {
  const t0 = domain[0];
  const t1 = domain[1];
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 - t0 <= 0) {
    const anchor = Number.isFinite(t0) ? t0 : 0;
    return linearScale([anchor - SINGLE_POINT_PAD_MS, anchor + SINGLE_POINT_PAD_MS], range, options);
  }
  return linearScale([t0, t1], range, options);
}

// ---------------------------------------------------------------------------
// Ticks
// ---------------------------------------------------------------------------

/** Rounds a raw step up to the nearest 1/2/5 x 10^n. */
function niceStep(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const exponent = Math.floor(Math.log10(raw));
  const magnitude = Math.pow(10, exponent);
  const fraction = raw / magnitude;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return nice * magnitude;
}

/** Trims the float noise a repeated `+= step` accumulates. */
function roundToStep(value: number, step: number): number {
  const decimals = clamp(Math.ceil(-Math.log10(step)) + 1, 0, 12);
  return Number(value.toFixed(decimals));
}

/**
 * Human-friendly tick values covering `[min, max]`, spaced on a 1/2/5 step.
 * Returns `[]` for a non-finite input and `[min]` for a zero-width span, so a
 * caller never has to special-case an empty chart.
 */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  if (lo === hi) return [lo];
  const target = Math.max(1, Math.floor(count));
  const step = niceStep((hi - lo) / target);
  const out: number[] = [];
  const epsilon = step * 1e-9;
  const first = Math.ceil(lo / step - 1e-9) * step;
  for (let value = first, guard = 0; value <= hi + epsilon && guard < 1024; value += step, guard += 1) {
    out.push(roundToStep(value, step));
  }
  return out;
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Steps a person reads without arithmetic: minutes, hours, then days. */
const TIME_STEPS_MS = [
  MINUTE_MS,
  5 * MINUTE_MS,
  15 * MINUTE_MS,
  30 * MINUTE_MS,
  HOUR_MS,
  2 * HOUR_MS,
  3 * HOUR_MS,
  6 * HOUR_MS,
  12 * HOUR_MS,
  DAY_MS,
  2 * DAY_MS,
  7 * DAY_MS,
] as const;

/**
 * Tick instants aligned to local clock boundaries (on the hour, on the day)
 * rather than to the first sample, which is what makes a time axis readable.
 */
export function timeTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  if (lo === hi) return [lo];
  const target = Math.max(1, Math.floor(count));
  const raw = (hi - lo) / target;
  const last = TIME_STEPS_MS[TIME_STEPS_MS.length - 1] ?? HOUR_MS;
  const step = TIME_STEPS_MS.find((candidate) => candidate >= raw) ?? last;
  // Shift into "local epoch" space so alignment lands on local boundaries, not
  // UTC ones: a 6h tick should read 06:00 where the user lives.
  const offset = new Date(lo).getTimezoneOffset() * MINUTE_MS;
  const out: number[] = [];
  const firstLocal = Math.ceil((lo - offset) / step) * step;
  for (let value = firstLocal + offset, guard = 0; value <= hi && guard < 1024; value += step, guard += 1) {
    out.push(value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Shown wherever a number is missing, so a gap never reads as a zero. */
export const NO_VALUE = '—';

/**
 * `25%`, `4.2%`. Defaults to whole numbers, dropping to one decimal for small
 * fractional values where the digit actually carries information.
 */
export function formatPct(value: number, digits?: number): string {
  if (!Number.isFinite(value)) return NO_VALUE;
  const safe = Object.is(value, -0) ? 0 : value;
  const places = digits ?? (Math.abs(safe) < 10 && !Number.isInteger(safe) ? 1 : 0);
  return `${safe.toFixed(places)}%`;
}

/** Zero-padded to two digits. */
function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/**
 * A countdown like `3h 12m`. Coarsens as it grows, because nobody needs seconds
 * on a two-day reset, and reads `now` once the instant has passed.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return NO_VALUE;
  if (ms <= 0) return 'now';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`;
}

export interface ClockOptions {
  /** Prefix the month and day, for axes that span more than a day. */
  withDate?: boolean;
  seconds?: boolean;
}

/**
 * Local wall-clock time, formatted by hand rather than through `Intl` so the
 * output is identical in every locale and therefore assertable in tests.
 */
export function formatClock(t: number, options: ClockOptions = {}): string {
  if (!Number.isFinite(t)) return NO_VALUE;
  const date = new Date(t);
  if (Number.isNaN(date.getTime())) return NO_VALUE;
  const time =
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}` +
    (options.seconds ? `:${pad2(date.getSeconds())}` : '');
  if (!options.withDate) return time;
  const month = MONTHS[date.getMonth()] ?? '';
  return `${month} ${date.getDate()} ${time}`;
}

// ---------------------------------------------------------------------------
// Regression
// ---------------------------------------------------------------------------

export interface Point2 {
  x: number;
  y: number;
}

export interface LinearFit {
  /** Change in y per unit x. Zero when there is nothing to fit. */
  slope: number;
  intercept: number;
  /** Coefficient of determination 0-1; zero when y has no variance to explain. */
  r2: number;
  /** Observations that survived the finite check. */
  n: number;
  predict(x: number): number;
}

/**
 * Ordinary least squares through the given points, used for the projection
 * line. x is centred before the fit because x values here are epoch
 * milliseconds, and squaring those raw is a fast route to precision loss.
 */
export function leastSquares(points: readonly Point2[]): LinearFit {
  const usable = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  const n = usable.length;
  if (n === 0) {
    return { slope: 0, intercept: 0, r2: 0, n: 0, predict: () => 0 };
  }
  let sumX = 0;
  let sumY = 0;
  for (const point of usable) {
    sumX += point.x;
    sumY += point.y;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  if (n === 1) {
    return { slope: 0, intercept: meanY, r2: 0, n, predict: () => meanY };
  }
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const point of usable) {
    const dx = point.x - meanX;
    const dy = point.y - meanY;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = meanY - slope * meanX;
  const r2 = sxx === 0 || syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  return { slope, intercept, r2, n, predict: (x: number) => slope * x + intercept };
}

/** Milliseconds per hour, exported so charts convert burn rates consistently. */
export const MS_PER_HOUR = HOUR_MS;
