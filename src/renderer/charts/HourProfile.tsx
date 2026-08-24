/**
 * The learned demand curve: how much quota each hour of the day usually costs.
 *
 * Twenty-four bars on one axis, with the declared peak laid over them, because
 * the whole planning question is "does my heaviest hour sit near a reset or far
 * from one" and that is a question about shape, not totals.
 *
 * An hour backed by two observations is not the same claim as an hour backed by
 * forty, so thin hours are drawn faded *and* named in words underneath — colour
 * and opacity never carry that on their own. The table view carries the sample
 * count per hour, which is the only place the distinction is exact.
 */

import { useMemo } from 'react';
import type { DaySpan, UsageProfile } from '@shared/types';
import { MINUTES_PER_DAY, formatHHMM } from '@core/schedule';
import { Icon, cx } from '../components/Icon';
import {
  ChartEmpty,
  ChartLegend,
  ChartTableFallback,
  seriesColor,
  seriesWash,
  useChartFrame,
  useMeasuredWidth,
  type ChartCell,
  type ChartTableInput,
  type LegendItem,
} from './ChartFrame';
import { clamp, formatPct, niceTicks } from './scales';

const HOURS = 24;
const MIN_PER_HOUR = 60;

/** Below this many observations an hour is a sliver, not a measurement. */
const DEFAULT_MIN_SAMPLES = 2;

/** The one series on this chart, so it takes the first categorical slot. */
const BAR_COLOR = seriesColor(0);

/** 4px rounded data end, capped by the bar's own width. */
const BAR_R = 4;
/** The 2px surface-coloured gap between adjacent fills. */
const BAR_GAP = 2;

const PAD = { top: 18, right: 12, bottom: 34, left: 40 };

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface HourProfileProps {
  profile: UsageProfile;
  /** The declared peak, laid over the bars as a band. */
  peak: DaySpan;
  /** Observations below which an hour is de-emphasised and labelled. */
  minSamples?: number;
  height?: number;
  className?: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

interface HourRow {
  hour: number;
  /** Utilization points gained during this local hour. */
  value: number;
  samples: number;
  thin: boolean;
  inPeak: boolean;
}

function finiteAt(values: readonly number[] | undefined, index: number): number {
  const value = values?.[index];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Hour ranges, in fractional hours, that the peak covers. Splits at midnight. */
function peakRanges(peak: DaySpan): Array<[number, number]> {
  const start = ((Math.round(peak.start) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const end = ((Math.round(peak.end) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const from = start / MIN_PER_HOUR;
  const to = end / MIN_PER_HOUR;
  // `end <= start` reads as running past midnight, matching `DaySpan`; equal
  // endpoints mean the whole day, exactly as `spanLengthMin` treats them.
  if (to > from) return [[from, to]];
  return [
    [from, HOURS],
    [0, to],
  ];
}

function inPeakHour(ranges: ReadonlyArray<[number, number]>, hour: number): boolean {
  // An hour counts as peak when any part of it is: the planner weights those
  // minutes, so hiding a partial overlap would understate the band.
  return ranges.some(([from, to]) => hour + 1 > from && hour < to);
}

/** `08:00` for the axis and the table, so both read the same way. */
function hourLabel(hour: number): string {
  return formatHHMM(hour * MIN_PER_HOUR);
}

/** Collapses `[2,3,4,7]` to `02:00-05:00, 07:00-08:00` for the footnote. */
function describeHours(hours: readonly number[]): string {
  const runs: Array<[number, number]> = [];
  for (const hour of hours) {
    const last = runs[runs.length - 1];
    if (last && hour === last[1] + 1) last[1] = hour;
    else runs.push([hour, hour]);
  }
  return runs.map(([from, to]) => `${hourLabel(from)}-${hourLabel((to + 1) % HOURS)}`).join(', ');
}

function prepare(profile: UsageProfile, peak: DaySpan, minSamples: number): HourRow[] {
  const ranges = peakRanges(peak);
  const rows: HourRow[] = [];
  for (let hour = 0; hour < HOURS; hour += 1) {
    const samples = Math.max(0, Math.round(finiteAt(profile.samples, hour)));
    rows.push({
      hour,
      value: finiteAt(profile.hourly, hour),
      samples,
      thin: samples < minSamples,
      inPeak: inPeakHour(ranges, hour),
    });
  }
  return rows;
}

/**
 * A bar rounded on its data end only. A plain `rx` would round the baseline
 * too, which reads as the bar floating off the axis.
 */
function topRoundedBar(x: number, y: number, w: number, h: number, r: number): string {
  const radius = clamp(Math.min(r, w / 2, h), 0, Math.max(0, w / 2));
  const right = x + w;
  const bottom = y + h;
  if (radius <= 0) return `M${x} ${y} H${right} V${bottom} H${x} Z`;
  return (
    `M${x} ${bottom} V${y + radius} A${radius} ${radius} 0 0 1 ${x + radius} ${y} ` +
    `H${right - radius} A${radius} ${radius} 0 0 1 ${right} ${y + radius} V${bottom} Z`
  );
}

/**
 * The numbers behind the plot, exported so the view hands the identical table
 * to `ChartFrame`'s `tableRows` rather than deriving it a second way.
 */
export function hourProfileTable(
  profile: UsageProfile,
  peak: DaySpan,
  minSamples: number = DEFAULT_MIN_SAMPLES,
): ChartTableInput | null {
  const rows = prepare(profile, peak, minSamples);
  if (rows.every((row) => row.value === 0 && row.samples === 0)) return null;
  const body: ChartCell[][] = rows.map((row) => [
    hourLabel(row.hour),
    Number(row.value.toFixed(2)),
    row.samples,
    row.inPeak ? 'peak' : '',
    row.samples === 0 ? 'no observations' : row.thin ? 'thin history' : 'observed',
  ]);
  return {
    columns: ['Hour', 'Utilization gained (%)', 'Observations', 'Band', 'Reliability'],
    rows: body,
    caption:
      'Mean utilization points gained during each local hour, learned from recorded history. Rows marked thin rest on too few observations to act on.',
    numericColumns: [1, 2],
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function HourProfile({
  profile,
  peak,
  minSamples = DEFAULT_MIN_SAMPLES,
  height,
  className,
}: HourProfileProps) {
  const frame = useChartFrame();
  const [rootRef, width] = useMeasuredWidth<HTMLDivElement>(560);

  const rows = useMemo(() => prepare(profile, peak, minSamples), [profile, peak, minSamples]);
  const table = useMemo(() => hourProfileTable(profile, peak, minSamples), [profile, peak, minSamples]);

  const plotHeight = height ?? frame?.plotHeight ?? 200;
  const observed = rows.filter((row) => row.samples > 0);
  const thinHours = rows.filter((row) => row.thin && row.value > 0).map((row) => row.hour);
  const blankHours = rows.filter((row) => row.samples === 0).map((row) => row.hour);

  const legend = useMemo<LegendItem[]>(
    () => [
      { label: 'utilization gained', color: BAR_COLOR, sub: 'per local hour' },
      { label: 'thin history', color: BAR_COLOR, band: true, sub: `under ${minSamples} observations` },
      // A neutral ink, not the hairline the band is filled with: at the tint the
      // swatch applies, --grid disappears against the surface. Still chromaless,
      // so it reads as a band rather than a ninth series.
      { label: 'peak hours', color: 'var(--text-secondary)', band: true, sub: 'your declaration' },
    ],
    [minSamples],
  );

  if (observed.length === 0) {
    return (
      <div className={cx('cd-timeline', className)} ref={rootRef}>
        <ChartEmpty
          icon="clock"
          title="No hourly profile yet"
          hint="ClaudeDeck learns this curve from recorded usage. It fills in as the app watches you work."
          height={Math.min(plotHeight, 150)}
        />
      </div>
    );
  }

  // --- geometry ------------------------------------------------------------
  const plotWidth = Math.max(96, width - PAD.left - PAD.right);
  const innerHeight = Math.max(60, plotHeight - PAD.top - PAD.bottom);
  const baseline = PAD.top + innerHeight;

  const peakValue = rows.reduce((max, row) => Math.max(max, row.value), 0);
  const yTicks = niceTicks(0, Math.max(peakValue, 1), 4);
  const yMax = Math.max(peakValue, yTicks[yTicks.length - 1] ?? 1, 1);
  const yFor = (value: number): number => baseline - (clamp(value, 0, yMax) / yMax) * innerHeight;

  const step = plotWidth / HOURS;
  const barWidth = Math.max(2, step - BAR_GAP);
  const xFor = (hour: number): number => PAD.left + hour * step;
  const ranges = peakRanges(peak);
  // Every third hour on a narrow card: 24 labels do not fit under 24 bars.
  const labelEvery = step >= 34 ? 2 : 3;

  const summary =
    `Hourly utilization profile. Busiest hour ${hourLabel(
      rows.reduce((best, row) => (row.value > best.value ? row : best), rows[0] ?? {
        hour: 0,
        value: 0,
        samples: 0,
        thin: true,
        inPeak: false,
      }).hour,
    )} at ${formatPct(peakValue, 1)} per hour. ` +
    `${observed.length} of 24 hours observed. The table view carries every hour and its sample count.`;

  return (
    <div className={cx('cd-timeline', className)} ref={rootRef}>
      {frame?.hasLegend ? null : <ChartLegend items={legend} className="cd-chart-legend--plot" />}

      <div className="cd-chart-surface">
        <svg
          className="cd-timeline-svg"
          width={width}
          height={plotHeight}
          viewBox={`0 0 ${width} ${plotHeight}`}
          role="img"
          aria-label={summary}
        >
          {/* the declared peak, behind the data and deliberately neutral */}
          {ranges.map(([from, to], index) =>
            to <= from ? null : (
              <rect
                key={`peak-${index}`}
                x={PAD.left + from * step}
                y={PAD.top}
                width={Math.max(0, (to - from) * step)}
                height={innerHeight}
                fill="var(--grid)"
              />
            ),
          )}

          {/* one axis: utilization points gained per hour */}
          {yTicks.map((tick) => (
            <line
              key={`grid-${tick}`}
              className="cd-axis-grid"
              x1={PAD.left}
              x2={PAD.left + plotWidth}
              y1={yFor(tick)}
              y2={yFor(tick)}
            />
          ))}
          {yTicks.map((tick) => (
            <text
              key={`ylabel-${tick}`}
              className="cd-axis-label"
              x={PAD.left - 8}
              y={yFor(tick) + 3}
              textAnchor="end"
            >
              {formatPct(tick, 0)}
            </text>
          ))}
          <line
            className="cd-axis-line"
            x1={PAD.left}
            x2={PAD.left + plotWidth}
            y1={baseline}
            y2={baseline}
          />

          {rows.map((row) => {
            const barX = xFor(row.hour) + BAR_GAP / 2;
            const top = yFor(row.value);
            const barHeight = baseline - top;
            return (
              <g key={`hour-${row.hour}`}>
                {barHeight > 0.5 ? (
                  <path
                    d={topRoundedBar(barX, top, barWidth, barHeight, BAR_R)}
                    fill={row.thin ? seriesWash(BAR_COLOR, 38) : BAR_COLOR}
                  />
                ) : null}
                {/* Thin and empty hours get a dotted footing, so a faded bar is
                    never the only signal that its hour is barely observed. */}
                {row.thin ? (
                  <line
                    x1={barX}
                    x2={barX + barWidth}
                    y1={baseline + 2}
                    y2={baseline + 2}
                    stroke="var(--axis)"
                    strokeWidth={2}
                    strokeDasharray="2 2"
                    strokeLinecap="round"
                  />
                ) : null}
              </g>
            );
          })}

          {rows.map((row) =>
            row.hour % labelEvery === 0 ? (
              <text
                key={`xlabel-${row.hour}`}
                className="cd-axis-label"
                x={xFor(row.hour) + step / 2}
                y={baseline + 18}
                textAnchor="middle"
              >
                {hourLabel(row.hour)}
              </text>
            ) : null,
          )}

          {/* The band it names, captioned from the padding just above the plot:
              after the bars in paint order, and clear of the tallest of them. */}
          {ranges[0] && ranges[0][1] > ranges[0][0] ? (
            <text className="cd-limit-label" x={PAD.left + ranges[0][0] * step + 3} y={PAD.top - 6}>
              peak
            </text>
          ) : null}
        </svg>
      </div>

      <p className="cd-burn-foot" style={{ display: 'flex', alignItems: 'flex-start', gap: '4px' }}>
        <Icon name="info" size={12} />
        <span>
          {`Learned from ${profile.days.length} day${profile.days.length === 1 ? '' : 's'} of recorded usage, `}
          {`confidence ${Math.round(clamp(profile.confidence, 0, 1) * 100)}%. `}
          {thinHours.length > 0
            ? `Faded bars with a dotted footing rest on fewer than ${minSamples} observations: ${describeHours(thinHours)}. `
            : ''}
          {blankHours.length > 0
            ? `No usage recorded at all for ${describeHours(blankHours)} — that is an absence of data, not a quiet hour.`
            : ''}
        </span>
      </p>

      <ChartTableFallback table={table} />
    </div>
  );
}

export default HourProfile;
