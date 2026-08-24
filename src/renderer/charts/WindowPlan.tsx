/**
 * The day plan: where each account's 5-hour windows actually land.
 *
 * This is the chart the planner exists for. Time runs left to right across one
 * local day; each account gets a lane of its 5-hour windows, and the boundary
 * between two windows *is* the reset the anchor decides. Over the top sit the
 * declared working hours and, stronger, the peak. Underneath sits the same day
 * anchored at the top of work with no plan at all, so "with a plan" versus
 * "just start working" is something the reader can see rather than something
 * the app asserts.
 *
 * Everything derived from a `PlanOutcome` is a simulation, and is labelled an
 * estimate in the legend, in the footnote and in the table view — a plan that
 * looks like a measurement is worse than no plan. The single exception is the
 * observed anchor, read back as `resetsAt - 5h`, which is drawn as a hollow
 * ring precisely so it cannot be mistaken for the prediction.
 */

import { useMemo } from 'react';
import { FIVE_HOUR_MS } from '@shared/types';
import type { DaySpan, PlanOutcome } from '@shared/types';
import { MINUTES_PER_DAY, formatHHMM, spanLengthMin } from '@core/schedule';
import { Icon, cx } from '../components/Icon';
import {
  ChartEmpty,
  ChartLegend,
  ChartTableFallback,
  OTHER_COLOR,
  seriesColor,
  seriesWash,
  useChartFrame,
  useMeasuredWidth,
  type ChartCell,
  type ChartTableInput,
  type LegendItem,
} from './ChartFrame';
import { clamp, formatClock, NO_VALUE, timeScale, timeTicks } from './scales';

const MINUTE_MS = 60_000;

/** Lane metrics, shared with `windowPlanHeight` so the frame reserves the exact height. */
const LANE_H = 34;
const LANE_GAP = 8;
const PAD_TOP = 38;
const PAD_BOTTOM = 26;
const PAD_RIGHT = 18;

/** Capsule geometry: a thin bar with 4px rounded data ends. */
const BAR_H = 10;
const BAR_R = 4;
/** Half of the 2px surface-coloured gap that separates adjacent fills. */
const BAR_INSET = 1;

/** Room for the lane names; collapses to the slot number on a narrow card. */
const GUTTER_WIDE = 116;
const GUTTER_NARROW = 46;
const WIDE_AT = 560;

/** Below this a blocked stretch is too narrow to carry its own word. */
const LABEL_MIN_PX = 46;
/** Roughly how far the anchor label runs, so nothing else is placed under it. */
const ANCHOR_LABEL_PX = 96;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface WindowPlanLane {
  slot: number;
  /** Display name: the alias when there is one, else the email. */
  label: string;
  /** Secondary label, e.g. `slot 2`. Defaults to the slot. */
  sub?: string;
  /** The simulated day for this account. */
  outcome: PlanOutcome;
  /**
   * The live anchor as observed (`resetsAt - 5h`), when known. The only
   * measured instant on this chart, so it is drawn differently on purpose.
   */
  observedAnchorAt?: number;
}

export interface WindowPlanProps {
  /** Epoch ms of local midnight for the day being drawn. */
  dayStartMs: number;
  work: DaySpan;
  peak: DaySpan;
  /** One lane per account, in slot order. Never re-ordered by rank. */
  lanes: readonly WindowPlanLane[];
  /** "Just start working": the faint comparison lane. Omit to hide it. */
  baseline?: PlanOutcome | null;
  /** The current instant. Drawn only when it falls inside the day. */
  now?: number;
  className?: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

interface Interval {
  start: number;
  end: number;
}

function minuteOfDay(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return ((Math.round(value) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

/** A `DaySpan` placed on a real day. `spanLengthMin` owns the midnight-crossing rule. */
function spanInterval(span: DaySpan, dayStartMs: number): Interval {
  const start = dayStartMs + minuteOfDay(span.start) * MINUTE_MS;
  return { start, end: start + spanLengthMin(span) * MINUTE_MS };
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * The exact SVG height for a lane count. Exported so the enclosing frame can
 * reserve it and the plot never sits in a pool of dead space.
 */
export function windowPlanHeight(laneCount: number, withBaseline = false): number {
  const rows = Math.max(1, laneCount) + (withBaseline ? 1 : 0);
  return PAD_TOP + rows * LANE_H + Math.max(0, rows - 1) * LANE_GAP + PAD_BOTTOM;
}

/**
 * The numbers behind the plot. Exported so the view can hand the identical
 * table to `ChartFrame`'s `tableRows` instead of building it a second way.
 */
export function windowPlanTable(input: {
  lanes: readonly WindowPlanLane[];
  baseline?: PlanOutcome | null;
}): ChartTableInput | null {
  const rows: ChartCell[][] = [];

  const push = (name: string, outcome: PlanOutcome, kind: string): void => {
    if (outcome.windows.length === 0) {
      // No simulated windows still means an anchor was chosen; omitting the row
      // would read as "this account was left out of the plan".
      rows.push([name, NO_VALUE, formatClock(outcome.anchorAt), NO_VALUE, null, NO_VALUE, 0, kind]);
      return;
    }
    outcome.windows.forEach((window, index) => {
      rows.push([
        name,
        index + 1,
        formatClock(window.start),
        formatClock(window.end),
        Number(window.endPct.toFixed(1)),
        window.exhaustedAt === null ? NO_VALUE : formatClock(window.exhaustedAt),
        Math.round(window.blockedMin),
        kind,
      ]);
    });
  };

  for (const lane of input.lanes) push(lane.label, lane.outcome, 'estimate');
  if (input.baseline) push('No plan (baseline)', input.baseline, 'estimate, baseline');
  if (rows.length === 0) return null;

  return {
    columns: [
      'Lane',
      'Window',
      'Starts',
      'Resets',
      'Utilization at reset (%)',
      'Predicted 100%',
      'Blocked minutes',
      'Kind',
    ],
    rows,
    caption:
      'Simulated 5-hour windows for the planned day. Every value here is an estimate produced from recorded history, not a measurement.',
    numericColumns: [1, 4, 6],
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function WindowPlan({
  dayStartMs,
  work,
  peak,
  lanes,
  baseline,
  now,
  className,
}: WindowPlanProps) {
  const frame = useChartFrame();
  const [rootRef, width] = useMeasuredWidth<HTMLDivElement>(760);

  const drawn = useMemo(
    // A lane's colour comes from its position in the list, so an account keeps
    // its colour as the plan's numbers move under it.
    () => lanes.map((lane, index) => ({ lane, color: seriesColor(index) })),
    [lanes],
  );

  const withBaseline = baseline != null;
  const rowCount = Math.max(1, drawn.length) + (withBaseline ? 1 : 0);
  const chartHeight = windowPlanHeight(drawn.length, withBaseline);

  const workBand = useMemo(() => spanInterval(work, dayStartMs), [work, dayStartMs]);
  const peakBand = useMemo(() => spanInterval(peak, dayStartMs), [peak, dayStartMs]);

  const domain = useMemo<[number, number]>(() => {
    let lo = Math.min(workBand.start, peakBand.start);
    let hi = Math.max(workBand.end, peakBand.end);
    const consider = (outcome: PlanOutcome): void => {
      lo = Math.min(lo, outcome.anchorAt);
      // An outcome with no simulated windows still occupies one window's worth
      // of the day, and the axis has to leave room for it.
      hi = Math.max(hi, outcome.anchorAt + FIVE_HOUR_MS);
      for (const window of outcome.windows) {
        lo = Math.min(lo, window.start);
        hi = Math.max(hi, window.end);
      }
    };
    for (const item of drawn) {
      consider(item.lane.outcome);
      const observed = item.lane.observedAnchorAt;
      if (observed !== undefined && Number.isFinite(observed)) lo = Math.min(lo, observed);
    }
    if (baseline) consider(baseline);
    // Air at both ends so the first tick label and the last reset are not
    // clipped against the plot edge.
    return [lo - 20 * MINUTE_MS, hi + 20 * MINUTE_MS];
  }, [drawn, baseline, workBand, peakBand]);

  const table = useMemo(() => windowPlanTable({ lanes, baseline }), [lanes, baseline]);

  const anyObserved = drawn.some(
    (item) =>
      item.lane.observedAnchorAt !== undefined && Number.isFinite(item.lane.observedAnchorAt),
  );

  const legend = useMemo<LegendItem[]>(() => {
    const items: LegendItem[] = drawn.map((item) => ({
      label: item.lane.label,
      color: item.color,
      sub: item.lane.sub ?? `slot ${item.lane.slot}`,
    }));
    items.push({ label: 'blocked', color: 'var(--status-critical)', band: true, sub: 'estimate' });
    items.push({
      label: 'predicted 100%',
      color: 'var(--status-critical)',
      dashed: true,
      sub: 'estimate',
    });
    if (anyObserved) items.push({ label: 'observed anchor', color: OTHER_COLOR, sub: 'measured' });
    if (withBaseline) {
      items.push({ label: 'no plan, for comparison', color: OTHER_COLOR, sub: 'estimate' });
    }
    return items;
  }, [drawn, anyObserved, withBaseline]);

  if (drawn.length === 0 && !withBaseline) {
    return (
      <div className={cx('cd-timeline', className)} ref={rootRef}>
        <ChartEmpty
          icon="clock"
          title="No account to plan a window for"
          hint="Add an account and the planner can place its first message on the day."
          height={140}
        />
      </div>
    );
  }

  // --- geometry ------------------------------------------------------------
  const wide = width >= WIDE_AT;
  const plotLeft = wide ? GUTTER_WIDE : GUTTER_NARROW;
  const plotWidth = Math.max(60, width - plotLeft - PAD_RIGHT);
  const plotRight = plotLeft + plotWidth;
  const x = timeScale(domain, [plotLeft, plotRight], { clamp: true });

  const laneTop = (row: number): number => PAD_TOP + row * (LANE_H + LANE_GAP);
  const bandTop = PAD_TOP - 3;
  const lanesBottom = laneTop(rowCount - 1) + LANE_H;
  const axisY = lanesBottom + 8;
  const ticks = timeTicks(domain[0], domain[1], wide ? 8 : 4);

  const inDomain = (t: number): boolean => t >= domain[0] && t <= domain[1];
  const nowX = now !== undefined && Number.isFinite(now) && inDomain(now) ? x.map(now) : null;
  const bandX = (t: number): number => clamp(x.map(t), plotLeft, plotRight);
  const bandHeight = lanesBottom - bandTop + 4;

  /** One lane's marks. The baseline lane is drawn thinner and in the neutral. */
  const renderLane = (
    key: string,
    row: number,
    color: string,
    outcome: PlanOutcome,
    options: { faint?: boolean; observedAnchorAt?: number },
  ) => {
    const top = laneTop(row);
    const mid = top + LANE_H / 2;
    const faint = options.faint === true;
    const barH = faint ? 4 : BAR_H;
    const barY = mid - barH / 2;
    const barR = Math.min(BAR_R, barH / 2);
    const anchorX = x.map(outcome.anchorAt);
    const anchorLate = anchorX > plotLeft + plotWidth * 0.72;

    // Only the widest blocked stretch carries the word; repeating it on every
    // stretch would turn the lane into a paragraph.
    let widest = { width: 0, centre: 0 };
    for (const window of outcome.windows) {
      if (window.exhaustedAt === null) continue;
      const from = bandX(window.exhaustedAt);
      const to = bandX(window.end);
      if (to - from > widest.width) widest = { width: to - from, centre: (from + to) / 2 };
    }

    return (
      <g key={key} opacity={faint ? 0.72 : 1}>
        {/* the lane's own hairline, so an empty stretch still reads as a lane */}
        <rect x={plotLeft} y={mid - 1} width={plotWidth} height={2} rx={1} fill="var(--grid)" />

        {outcome.windows.map((window, index) => {
          const from = x.map(window.start);
          const to = x.map(window.end);
          const cut = window.exhaustedAt === null ? to : clamp(x.map(window.exhaustedAt), from, to);
          const usableWidth = Math.max(0, cut - from - BAR_INSET * 2);
          const blockedWidth = Math.max(0, to - cut - BAR_INSET * 2);
          return (
            <g key={`w-${index}`}>
              {usableWidth > 0 ? (
                <rect
                  x={from + BAR_INSET}
                  y={barY}
                  width={usableWidth}
                  height={barH}
                  rx={barR}
                  fill={color}
                />
              ) : null}
              {blockedWidth > 0 ? (
                <rect
                  x={cut + BAR_INSET}
                  y={barY}
                  width={blockedWidth}
                  height={barH}
                  rx={barR}
                  fill={seriesWash('var(--status-critical)', 42)}
                />
              ) : null}
              {/* the reset: the boundary this anchor produced */}
              <line
                x1={to}
                x2={to}
                y1={top + 2}
                y2={top + LANE_H - 2}
                stroke="var(--text-secondary)"
                strokeWidth={2}
                strokeLinecap="round"
              />
              {wide && !faint ? (
                <text className="cd-axis-label" x={to} y={top + LANE_H - 1} textAnchor="middle">
                  {formatClock(window.end)}
                </text>
              ) : null}
              {window.exhaustedAt === null ? null : (
                <line
                  className="cd-projection"
                  x1={cut}
                  x2={cut}
                  y1={top + 4}
                  y2={top + LANE_H - 4}
                  style={{ stroke: 'var(--status-critical)' }}
                />
              )}
            </g>
          );
        })}

        {/* The shading is self-describing only if it says so, but the word is
            dropped rather than allowed to land on top of the anchor label. */}
        {widest.width >= LABEL_MIN_PX && widest.centre > anchorX + ANCHOR_LABEL_PX ? (
          <text
            className="cd-limit-label"
            x={widest.centre}
            y={faint ? top + LANE_H - 1 : barY - 3}
            textAnchor="middle"
          >
            blocked
          </text>
        ) : null}

        {/* the anchor: the one property of the window the user controls */}
        <line
          x1={anchorX}
          x2={anchorX}
          y1={top}
          y2={top + LANE_H}
          stroke={faint ? OTHER_COLOR : color}
          strokeWidth={2}
          strokeLinecap="round"
        />
        <text
          className="cd-direct-label"
          x={anchorLate ? anchorX - 5 : anchorX + 5}
          y={top + 10}
          textAnchor={anchorLate ? 'end' : 'start'}
        >
          {faint
            ? `no plan, ${formatClock(outcome.anchorAt)}`
            : `anchor ${formatClock(outcome.anchorAt)}`}
        </text>

        {options.observedAnchorAt !== undefined &&
        Number.isFinite(options.observedAnchorAt) &&
        inDomain(options.observedAnchorAt) ? (
          <circle
            cx={x.map(options.observedAnchorAt)}
            cy={mid}
            r={4}
            fill="var(--surface-1)"
            stroke={color}
            strokeWidth={2}
          />
        ) : null}
      </g>
    );
  };

  const ariaLabel =
    `Planned 5-hour windows for ${drawn.length} account${drawn.length === 1 ? '' : 's'} ` +
    `across one day. Working hours ${formatHHMM(work.start)} to ${formatHHMM(work.end)}, ` +
    `peak ${formatHHMM(peak.start)} to ${formatHHMM(peak.end)}. ` +
    'Every window here is simulated; the table view carries the same numbers.';

  return (
    <div className={cx('cd-timeline', className)} ref={rootRef}>
      {frame?.hasLegend ? null : <ChartLegend items={legend} className="cd-chart-legend--plot" />}

      <div className="cd-chart-surface">
        <svg
          className="cd-timeline-svg"
          width={width}
          height={chartHeight}
          viewBox={`0 0 ${width} ${chartHeight}`}
          role="img"
          aria-label={ariaLabel}
        >
          {/* Working hours, then the stronger peak over it. Both neutral: a band
              in a series colour would compete with the windows inside it. */}
          <rect
            x={bandX(workBand.start)}
            y={bandTop}
            width={Math.max(0, bandX(workBand.end) - bandX(workBand.start))}
            height={bandHeight}
            fill="var(--surface-2)"
          />
          <rect
            x={bandX(peakBand.start)}
            y={bandTop}
            width={Math.max(0, bandX(peakBand.end) - bandX(peakBand.start))}
            height={bandHeight}
            fill="var(--grid)"
          />
          <text className="cd-axis-label" x={bandX(workBand.start) + 2} y={20}>
            {`working hours ${formatHHMM(work.start)} to ${formatHHMM(work.end)}`}
          </text>
          <text className="cd-limit-label" x={bandX(peakBand.start) + 2} y={32}>
            {`peak ${formatHHMM(peak.start)} to ${formatHHMM(peak.end)}`}
          </text>

          {/* grid, then the one axis this chart has */}
          {ticks.map((tick) => (
            <line
              key={`grid-${tick}`}
              className="cd-axis-grid"
              x1={x.map(tick)}
              x2={x.map(tick)}
              y1={bandTop}
              y2={lanesBottom + 4}
            />
          ))}
          <line className="cd-axis-line" x1={plotLeft} x2={plotRight} y1={axisY} y2={axisY} />
          {ticks.map((tick) => (
            <text
              key={`tick-${tick}`}
              className="cd-axis-label"
              x={bandX(tick)}
              y={axisY + 14}
              textAnchor="middle"
            >
              {formatClock(tick)}
            </text>
          ))}

          {/* Lane names sit outside the plot, so no lane needs a colour key. */}
          {drawn.map((item, row) => {
            const mid = laneTop(row) + LANE_H / 2;
            return (
              <g key={`name-${item.lane.slot}`}>
                <text className="cd-direct-label" x={0} y={wide ? mid - 1 : mid + 3}>
                  {wide ? truncate(item.lane.label, 15) : `#${item.lane.slot}`}
                </text>
                {wide ? (
                  <text className="cd-axis-label" x={0} y={mid + 12}>
                    {item.lane.sub ?? `slot ${item.lane.slot}`}
                  </text>
                ) : null}
              </g>
            );
          })}
          {withBaseline ? (
            <text className="cd-axis-label" x={0} y={laneTop(rowCount - 1) + LANE_H / 2 + 3}>
              {wide ? 'no plan' : 'base'}
            </text>
          ) : null}

          {drawn.map((item, row) =>
            renderLane(`lane-${item.lane.slot}`, row, item.color, item.lane.outcome, {
              observedAnchorAt: item.lane.observedAnchorAt,
            }),
          )}
          {baseline
            ? renderLane('lane-baseline', rowCount - 1, OTHER_COLOR, baseline, { faint: true })
            : null}

          {nowX === null ? null : (
            <>
              <line
                x1={nowX}
                x2={nowX}
                y1={bandTop}
                y2={lanesBottom + 4}
                stroke="var(--axis)"
                strokeWidth={2}
                strokeDasharray="2 3"
              />
              <text className="cd-limit-label" x={nowX + 4} y={10}>
                now
              </text>
            </>
          )}
        </svg>
      </div>

      <p className="cd-burn-foot" style={{ display: 'flex', alignItems: 'flex-start', gap: '4px' }}>
        <Icon name="alert-triangle" size={12} />
        <span>
          Estimate. Shaded stretches are the minutes this plan predicts you would spend blocked,
          simulated from recorded history rather than measured. Each boundary is a reset the anchor
          produces; a ring marks an anchor ClaudeDeck has actually observed.
        </span>
      </p>

      <ChartTableFallback table={table} />
    </div>
  );
}

export default WindowPlan;
