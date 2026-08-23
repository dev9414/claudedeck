/**
 * Utilization over time, one line per account.
 *
 * This is the chart the app is built around, so it carries the full contract:
 * a single y axis pinned to the utilization percentage, a crosshair that snaps
 * to the nearest recorded instant and reads out every series at once, a
 * hairline `limit` reference at 100%, and — only when forecasts are supplied —
 * a dashed projection with a shaded confidence cone that is labelled an
 * estimate in the legend, the tooltip and the table.
 *
 * The projection is deliberately bounded to a short horizon: extending a
 * least-squares fit until it crosses 100% would let a two-hour sample dictate a
 * three-day axis and make the recorded data unreadable.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { BurnRate } from '@shared/types';
import { cx } from '../components/Icon';
import {
  ChartEmpty,
  ChartLegend,
  ChartTableFallback,
  MAX_SERIES,
  OTHER_COLOR,
  OTHER_LABEL,
  seriesColor,
  seriesWash,
  useChartFrame,
  useMeasuredWidth,
  type ChartCell,
  type ChartTableInput,
  type LegendItem,
} from './ChartFrame';
import {
  clamp,
  formatClock,
  formatPct,
  leastSquares,
  linearScale,
  MS_PER_HOUR,
  niceTicks,
  NO_VALUE,
  timeScale,
  timeTicks,
} from './scales';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface TimelinePoint {
  /** Epoch ms. */
  t: number;
  /** Utilization 0-100. */
  pct: number;
}

export interface TimelineSeries {
  slot: number;
  email: string;
  alias?: string;
  points: TimelinePoint[];
}

/**
 * A `Forecast` from the domain contract, plus the slot it belongs to. Either
 * the whole `burn` object or a bare `pctPerHour`/`confidence` pair is accepted,
 * so a view can pass what it has without reshaping it.
 */
export interface TimelineForecast {
  slot?: number;
  windowKey?: string;
  burn?: BurnRate;
  pctPerHour?: number;
  confidence?: number;
  exhaustionAt?: string | null;
  lastsToReset?: boolean;
}

export interface UsageTimelineProps {
  series: readonly TimelineSeries[];
  /** Which rate-limit window these points describe; names the axis. */
  windowKey: string;
  forecasts?: readonly TimelineForecast[];
  height?: number;
  /** How far past the last observation a projection may be drawn. */
  projectionHours?: number;
  className?: string;
}

// ---------------------------------------------------------------------------
// Data prep
// ---------------------------------------------------------------------------

interface DrawnSeries {
  key: string;
  slot: number | null;
  name: string;
  sub: string;
  color: string;
  points: TimelinePoint[];
}

interface Projection {
  seriesKey: string;
  color: string;
  from: TimelinePoint;
  to: TimelinePoint;
  upper: number;
  lower: number;
  pctPerHour: number;
  confidence: number;
}

function sortedPoints(points: readonly TimelinePoint[]): TimelinePoint[] {
  return points
    .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.pct))
    .map((point) => ({ t: point.t, pct: point.pct }))
    .sort((a, b) => a.t - b.t);
}

/** Linear read of a series at an arbitrary instant; null outside its range. */
function valueAt(points: readonly TimelinePoint[], t: number): number | null {
  const count = points.length;
  if (count === 0) return null;
  const first = points[0];
  const last = points[count - 1];
  if (!first || !last) return null;
  if (t <= first.t) return t === first.t ? first.pct : null;
  if (t >= last.t) return t === last.t ? last.pct : null;
  let lo = 0;
  let hi = count - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    const probe = points[mid];
    if (!probe) break;
    if (probe.t <= t) lo = mid;
    else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  if (!a || !b) return null;
  if (b.t === a.t) return b.pct;
  return a.pct + ((b.pct - a.pct) * (t - a.t)) / (b.t - a.t);
}

function nearestIndex(times: readonly number[], t: number): number {
  if (times.length === 0) return -1;
  let lo = 0;
  let hi = times.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    const probe = times[mid];
    if (probe === undefined) break;
    if (probe <= t) lo = mid;
    else hi = mid;
  }
  const a = times[lo];
  const b = times[hi];
  if (a === undefined) return hi;
  if (b === undefined) return lo;
  return Math.abs(a - t) <= Math.abs(b - t) ? lo : hi;
}

/**
 * Slots nine and beyond collapse into one neutral "Other" line carrying their
 * mean, because a ninth categorical colour would break the validated set.
 */
function foldSeries(series: readonly TimelineSeries[]): DrawnSeries[] {
  const usable = series
    .map((entry) => ({ entry, points: sortedPoints(entry.points) }))
    .filter((item) => item.points.length > 0);

  const drawn: DrawnSeries[] = usable.slice(0, MAX_SERIES).map((item, index) => ({
    key: `slot-${item.entry.slot}`,
    slot: item.entry.slot,
    name: item.entry.alias ?? item.entry.email,
    sub: `slot ${item.entry.slot}`,
    color: seriesColor(index),
    points: item.points,
  }));

  const rest = usable.slice(MAX_SERIES);
  if (rest.length === 0) return drawn;

  const instants = new Set<number>();
  for (const item of rest) for (const point of item.points) instants.add(point.t);
  const merged: TimelinePoint[] = [...instants]
    .sort((a, b) => a - b)
    .map((t) => {
      let sum = 0;
      let seen = 0;
      for (const item of rest) {
        const value = valueAt(item.points, t);
        if (value !== null) {
          sum += value;
          seen += 1;
        }
      }
      return seen === 0 ? null : { t, pct: sum / seen };
    })
    .filter((point): point is TimelinePoint => point !== null);

  if (merged.length > 0) {
    drawn.push({
      key: 'other',
      slot: null,
      name: OTHER_LABEL,
      sub: `${rest.length} more accounts, mean`,
      color: OTHER_COLOR,
      points: merged,
    });
  }
  return drawn;
}

/** Median sample interval, used to decide where a line should break. */
function medianGap(points: readonly TimelinePoint[]): number {
  if (points.length < 3) return 0;
  const gaps: number[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (!previous || !current) continue;
    gaps.push(current.t - previous.t);
  }
  if (gaps.length === 0) return 0;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)] ?? 0;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function UsageTimeline({
  series,
  windowKey,
  forecasts,
  height,
  projectionHours = 6,
  className,
}: UsageTimelineProps) {
  const frame = useChartFrame();
  const [rootRef, width] = useMeasuredWidth<HTMLDivElement>(680);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const plotHeight = height ?? frame?.plotHeight ?? 240;
  const drawn = useMemo(() => foldSeries(series), [series]);

  const times = useMemo(() => {
    const instants = new Set<number>();
    for (const entry of drawn) for (const point of entry.points) instants.add(point.t);
    return [...instants].sort((a, b) => a - b);
  }, [drawn]);

  const forecastBySeries = useMemo(() => {
    const map = new Map<string, TimelineForecast>();
    if (!forecasts) return map;
    for (const forecast of forecasts) {
      if (forecast.windowKey && forecast.windowKey !== windowKey) continue;
      // A slotless forecast is only unambiguous when there is one line to pin
      // it to; otherwise it is dropped rather than guessed at.
      const key =
        forecast.slot !== undefined
          ? `slot-${forecast.slot}`
          : drawn.length === 1
            ? drawn[0]?.key
            : undefined;
      if (key && !map.has(key)) map.set(key, forecast);
    }
    return map;
  }, [forecasts, windowKey, drawn]);

  const projections = useMemo<Projection[]>(() => {
    if (forecastBySeries.size === 0) return [];
    const horizonMs = Math.max(0.25, projectionHours) * MS_PER_HOUR;
    const out: Projection[] = [];
    for (const entry of drawn) {
      const forecast = forecastBySeries.get(entry.key);
      if (!forecast) continue;
      const anchor = entry.points[entry.points.length - 1];
      if (!anchor) continue;

      const declared = forecast.burn?.pctPerHour ?? forecast.pctPerHour;
      // No declared rate: fit the tail ourselves rather than drawing nothing.
      const fitted = leastSquares(
        entry.points.slice(-12).map((point) => ({ x: point.t, y: point.pct })),
      );
      const pctPerHour = Number.isFinite(declared as number)
        ? (declared as number)
        : fitted.slope * MS_PER_HOUR;
      const confidence = clamp(forecast.burn?.confidence ?? forecast.confidence ?? fitted.r2, 0, 1);

      const exhaustion = forecast.exhaustionAt ? Date.parse(forecast.exhaustionAt) : Number.NaN;
      const cappedEnd = anchor.t + horizonMs;
      const end = Number.isFinite(exhaustion) && exhaustion > anchor.t
        ? Math.min(exhaustion, cappedEnd)
        : cappedEnd;
      const hours = (end - anchor.t) / MS_PER_HOUR;
      if (hours <= 0) continue;

      // The cone widens with doubt: a fit nobody trusts fans out to +/-90%.
      const spread = clamp(1 - confidence, 0.15, 0.9);
      out.push({
        seriesKey: entry.key,
        color: entry.color,
        from: anchor,
        to: { t: end, pct: anchor.pct + pctPerHour * hours },
        upper: anchor.pct + pctPerHour * hours * (1 + spread),
        lower: anchor.pct + pctPerHour * hours * (1 - spread),
        pctPerHour,
        confidence,
      });
    }
    return out;
  }, [drawn, forecastBySeries, projectionHours]);

  const hasData = drawn.length > 0 && times.length > 0;

  // --- geometry ------------------------------------------------------------
  const directLabels = hasData && drawn.length <= 4 && width >= 460;
  const padding = { top: 12, right: directLabels ? 104 : 16, bottom: 24, left: 38 };
  const plotWidth = Math.max(48, width - padding.left - padding.right);
  const innerHeight = Math.max(60, plotHeight - padding.top - padding.bottom);

  const firstTime = times[0] ?? 0;
  const lastTime = times[times.length - 1] ?? firstTime;
  const projectionEnd = projections.reduce((max, projection) => Math.max(max, projection.to.t), lastTime);
  const spanMs = Math.max(0, projectionEnd - firstTime);

  const peak = useMemo(() => {
    let max = 0;
    for (const entry of drawn) for (const point of entry.points) max = Math.max(max, point.pct);
    for (const projection of projections) max = Math.max(max, projection.to.pct, projection.upper);
    return max;
  }, [drawn, projections]);
  const yMax = Math.max(100, Math.ceil(peak / 10) * 10);

  const x = timeScale([firstTime, projectionEnd], [padding.left, padding.left + plotWidth]);
  const y = linearScale([0, yMax], [padding.top + innerHeight, padding.top], { clamp: true });

  // Five requested steps land on a 20-point grid for the usual 0-100 axis:
  // dense enough to read a value off, recessive enough to stay out of the way.
  const yTicks = useMemo(() => niceTicks(0, yMax, 5), [yMax]);
  const xTicks = useMemo(
    () => timeTicks(firstTime, projectionEnd, width >= 560 ? 6 : 3),
    [firstTime, projectionEnd, width],
  );
  const withDate = spanMs > 20 * MS_PER_HOUR;

  const paths = useMemo(
    () =>
      drawn.map((entry) => {
        const breakAfter = medianGap(entry.points) * 3;
        let d = '';
        let previous: TimelinePoint | null = null;
        for (const point of entry.points) {
          const px = x.map(point.t).toFixed(2);
          const py = y.map(point.pct).toFixed(2);
          const broken = previous !== null && breakAfter > 0 && point.t - previous.t > breakAfter;
          d += `${d === '' || broken ? 'M' : 'L'}${px} ${py} `;
          previous = point;
        }
        return { key: entry.key, d: d.trim(), color: entry.color, single: entry.points.length === 1 };
      }),
    // The scales are derived from the same inputs, so tracking them separately
    // would only add churn.
    [drawn, firstTime, projectionEnd, yMax, plotWidth, innerHeight, padding.left, padding.top],
  );

  // --- crosshair -----------------------------------------------------------
  const activeTime = activeIndex === null ? null : (times[activeIndex] ?? null);

  const readings = useMemo(() => {
    if (activeTime === null) return [];
    return drawn
      .map((entry) => ({ entry, value: valueAt(entry.points, activeTime) }))
      .filter((row): row is { entry: DrawnSeries; value: number } => row.value !== null)
      .sort((a, b) => b.value - a.value);
  }, [drawn, activeTime]);

  const handlePointer = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      const svg = svgRef.current;
      if (!svg || times.length === 0) return;
      const box = svg.getBoundingClientRect();
      const offset = event.clientX - box.left;
      setActiveIndex(nearestIndex(times, x.invert(offset)));
    },
    [times, x],
  );

  const handleKey = useCallback(
    (event: ReactKeyboardEvent<SVGSVGElement>) => {
      if (times.length === 0) return;
      const current = activeIndex ?? times.length - 1;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        setActiveIndex(Math.max(0, current - 1));
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        setActiveIndex(Math.min(times.length - 1, current + 1));
      } else if (event.key === 'Home') {
        event.preventDefault();
        setActiveIndex(0);
      } else if (event.key === 'End') {
        event.preventDefault();
        setActiveIndex(times.length - 1);
      } else if (event.key === 'Escape') {
        setActiveIndex(null);
      }
    },
    [activeIndex, times],
  );

  // --- legend + table ------------------------------------------------------
  const legend = useMemo<LegendItem[]>(() => {
    const items: LegendItem[] = drawn.map((entry) => ({
      label: entry.name,
      color: entry.color,
      sub: entry.sub,
    }));
    if (projections.length > 0) {
      items.push({ label: 'projected', dashed: true, color: OTHER_COLOR, sub: 'estimate' });
      items.push({ label: 'confidence range', band: true, color: OTHER_COLOR, sub: 'estimate' });
    }
    return items;
  }, [drawn, projections]);

  const table = useMemo<ChartTableInput | null>(() => {
    if (!hasData) return null;
    // A poll every few minutes over a week is thousands of rows; thin them so
    // the table stays something a person can actually read.
    const stride = Math.max(1, Math.ceil(times.length / 60));
    const sampled = times.filter((_time, index) => index % stride === 0 || index === times.length - 1);
    const columns = ['Time', ...drawn.map((entry) => entry.name), 'Kind'];
    const rows: ChartCell[][] = sampled.map((time) => [
      formatClock(time, { withDate }),
      ...drawn.map((entry) => {
        const value = valueAt(entry.points, time);
        return value === null ? null : Number(value.toFixed(1));
      }),
      'recorded',
    ]);
    if (projections.length > 0) {
      const byKey = new Map(projections.map((projection) => [projection.seriesKey, projection]));
      const horizon = projections.reduce((max, projection) => Math.max(max, projection.to.t), 0);
      rows.push([
        formatClock(horizon, { withDate }),
        ...drawn.map((entry) => {
          const projection = byKey.get(entry.key);
          return projection ? Number(clamp(projection.to.pct, 0, yMax).toFixed(1)) : null;
        }),
        'estimate',
      ]);
    }
    return {
      columns,
      rows,
      caption: `Utilization of the ${windowKey} window, in percent. Rows marked "estimate" are projected, not observed.${
        stride > 1 ? ` Sampled every ${stride} observations.` : ''
      }`,
      numericColumns: drawn.map((_entry, index) => index + 1),
    };
  }, [hasData, times, drawn, projections, windowKey, withDate, yMax]);

  if (!hasData) {
    return (
      <div className={cx('cd-timeline', className)} ref={rootRef}>
        <ChartEmpty
          icon="activity"
          title="No usage history yet"
          hint="Points land here after the first successful poll of this window."
          height={Math.min(plotHeight, 160)}
        />
      </div>
    );
  }

  const baseline = padding.top + innerHeight;
  const limitY = y.map(100);
  const crosshairX = activeTime === null ? null : x.map(activeTime);
  const tooltipOnRight = crosshairX !== null && crosshairX < width / 2;

  return (
    <div className={cx('cd-timeline', className)} ref={rootRef}>
      {/* One line needs no key: the title names it. Two or more, or anything
          projected, always does. */}
      {frame?.hasLegend || legend.length < 2 ? null : (
        <ChartLegend items={legend} className="cd-chart-legend--plot" />
      )}

      <div className="cd-chart-surface">
        <svg
          ref={svgRef}
          className="cd-timeline-svg"
          width={width}
          height={plotHeight}
          viewBox={`0 0 ${width} ${plotHeight}`}
          role="img"
          tabIndex={0}
          aria-label={`Utilization over time for the ${windowKey} window, ${drawn.length} accounts. Use the arrow keys to step through the recorded instants.`}
          onPointerMove={handlePointer}
          onPointerDown={handlePointer}
          onPointerLeave={() => setActiveIndex(null)}
          onKeyDown={handleKey}
          onBlur={() => setActiveIndex(null)}
        >
          {/* grid */}
          {yTicks.map((tick) => (
            <line
              key={`grid-${tick}`}
              className="cd-axis-grid"
              x1={padding.left}
              x2={padding.left + plotWidth}
              y1={y.map(tick)}
              y2={y.map(tick)}
            />
          ))}
          {yTicks.map((tick) => (
            <text
              key={`ylabel-${tick}`}
              className="cd-axis-label"
              x={padding.left - 8}
              y={y.map(tick) + 3}
              textAnchor="end"
            >
              {formatPct(tick, 0)}
            </text>
          ))}

          {/* x axis */}
          <line
            className="cd-axis-line"
            x1={padding.left}
            x2={padding.left + plotWidth}
            y1={baseline}
            y2={baseline}
          />
          {xTicks.map((tick) => (
            <text
              key={`xlabel-${tick}`}
              className="cd-axis-label"
              x={clamp(x.map(tick), padding.left, padding.left + plotWidth)}
              y={baseline + 15}
              textAnchor="middle"
            >
              {formatClock(tick, { withDate })}
            </text>
          ))}

          {/* the one thing every series is measured against */}
          <line
            className="cd-limit-line"
            x1={padding.left}
            x2={padding.left + plotWidth}
            y1={limitY}
            y2={limitY}
          />
          <text className="cd-limit-label" x={padding.left + 4} y={limitY - 5}>
            limit
          </text>

          {/* confidence cones sit under the lines so they never obscure data */}
          {projections.map((projection) => {
            const x0 = x.map(projection.from.t);
            const x1 = x.map(projection.to.t);
            return (
              <polygon
                key={`cone-${projection.seriesKey}`}
                className="cd-cone"
                points={`${x0},${y.map(projection.from.pct)} ${x1},${y.map(projection.upper)} ${x1},${y.map(projection.lower)}`}
                style={{ fill: seriesWash(projection.color, 14) }}
              />
            );
          })}
          {projections.map((projection) => (
            <line
              key={`proj-${projection.seriesKey}`}
              className="cd-projection"
              x1={x.map(projection.from.t)}
              y1={y.map(projection.from.pct)}
              x2={x.map(projection.to.t)}
              y2={y.map(projection.to.pct)}
              style={{ stroke: projection.color }}
            />
          ))}

          {/* series */}
          {paths.map((path) =>
            path.single ? null : (
              // pathLength normalises the geometry to 1, which is what lets
              // the draw-in animation in motion.css work at any width without
              // measuring the path from JS.
              <path
                key={path.key}
                className="cd-series-line"
                d={path.d}
                pathLength={1}
                style={{ stroke: path.color }}
              />
            ),
          )}
          {drawn.map((entry) => {
            if (entry.points.length !== 1) return null;
            const only = entry.points[0];
            if (!only) return null;
            return (
              <circle
                key={`dot-${entry.key}`}
                className="cd-series-dot"
                cx={x.map(only.t)}
                cy={y.map(only.pct)}
                r={3}
                style={{ fill: entry.color }}
              />
            );
          })}

          {/* crosshair */}
          {crosshairX === null ? null : (
            <g className="cd-crosshair">
              <line x1={crosshairX} x2={crosshairX} y1={padding.top} y2={baseline} />
              {readings.map((reading) => (
                <circle
                  key={`marker-${reading.entry.key}`}
                  className="cd-crosshair-marker"
                  cx={crosshairX}
                  cy={y.map(reading.value)}
                  r={4}
                  style={{ fill: reading.entry.color }}
                />
              ))}
            </g>
          )}

          {/* direct labels, for the small-multiples case */}
          {directLabels
            ? layoutDirectLabels(drawn, y, plotHeight).map((label) => (
                <g key={`label-${label.key}`}>
                  <circle
                    className="cd-direct-dot"
                    cx={padding.left + plotWidth + 10}
                    cy={label.y - 3}
                    r={3}
                    style={{ fill: label.color }}
                  />
                  <text className="cd-direct-label" x={padding.left + plotWidth + 18} y={label.y}>
                    {label.name.length > 14 ? `${label.name.slice(0, 13)}…` : label.name}
                  </text>
                </g>
              ))
            : null}
        </svg>

        {crosshairX === null || activeTime === null ? null : (
          <div
            className="cd-chart-tooltip"
            style={
              tooltipOnRight
                ? { left: `${crosshairX + 14}px` }
                : { right: `${Math.max(0, width - crosshairX) + 14}px` }
            }
            role="presentation"
          >
            <p className="cd-chart-tooltip-head">{formatClock(activeTime, { withDate: true })}</p>
            <ul className="cd-chart-tooltip-list">
              {readings.map((reading) => (
                <li key={`tip-${reading.entry.key}`}>
                  <span className="cd-chart-swatch" style={{ color: reading.entry.color }} aria-hidden="true" />
                  <span className="cd-chart-tooltip-name">{reading.entry.name}</span>
                  <span className="cd-chart-tooltip-value cd-num">{formatPct(reading.value, 1)}</span>
                </li>
              ))}
              {readings.length === 0 ? <li className="cd-muted">{NO_VALUE}</li> : null}
            </ul>
            {projections.length > 0 ? (
              <p className="cd-chart-tooltip-foot">Dashed segments are estimates.</p>
            ) : null}
          </div>
        )}
      </div>

      <p className="cd-sr-only" aria-live="polite">
        {activeTime === null
          ? ''
          : `${formatClock(activeTime, { withDate: true })}: ${readings
              .map((reading) => `${reading.entry.name} ${formatPct(reading.value, 1)}`)
              .join(', ')}`}
      </p>

      <ChartTableFallback table={table} />
    </div>
  );
}

/** Places one end-of-line label per series, nudged apart so none collide. */
function layoutDirectLabels(
  drawn: readonly DrawnSeries[],
  y: { map(value: number): number },
  height: number,
): Array<{ key: string; name: string; color: string; y: number }> {
  const placed = drawn
    .map((entry) => {
      const last = entry.points[entry.points.length - 1];
      if (!last) return null;
      return { key: entry.key, name: entry.name, color: entry.color, y: y.map(last.pct) + 4 };
    })
    .filter((label): label is { key: string; name: string; color: string; y: number } => label !== null)
    .sort((a, b) => a.y - b.y);

  const minimumGap = 14;
  for (let index = 1; index < placed.length; index += 1) {
    const previous = placed[index - 1];
    const current = placed[index];
    if (!previous || !current) continue;
    if (current.y - previous.y < minimumGap) current.y = previous.y + minimumGap;
  }
  const overflow = (placed[placed.length - 1]?.y ?? 0) - (height - 4);
  if (overflow > 0) for (const label of placed) label.y -= overflow;
  return placed;
}

export default UsageTimeline;
