/**
 * The inline utilization sparkline used inside stat tiles and dense lists.
 *
 * Hand-rolled SVG, no axis, one series. It is always paired with the figure it
 * annotates, so the shape carries trend only and never a value on its own.
 */

import { useMemo } from 'react';
import { cx } from '../components/Icon';
import { STATUS_META, seriesColor, seriesWash, type ChartStatus } from './ChartFrame';
import { clamp, formatPct, linearScale, timeScale } from './scales';

export interface SparkPoint {
  /** Epoch ms. */
  t: number;
  /** Utilization 0-100. */
  pct: number;
}

export interface SparklineProps {
  points: readonly SparkPoint[];
  width?: number;
  height?: number;
  /** Overrides the colour. Must be a token reference, never a literal. */
  color?: string;
  /** When set, the mark takes the status colour; the caller still ships a label. */
  status?: ChartStatus;
  /** Wash under the line. On by default; off in very small rows. */
  area?: boolean;
  /** Utilization is a percentage, so the default domain is the full 0-100. */
  yDomain?: readonly [number, number];
  /** Accessible name. Defaults to a description of the trend. */
  label?: string;
  className?: string;
}

export function Sparkline({
  points,
  width = 84,
  height = 24,
  color,
  status,
  area = true,
  yDomain = [0, 100],
  label,
  className,
}: SparklineProps) {
  const usable = useMemo(
    () =>
      points
        .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.pct))
        .slice()
        .sort((a, b) => a.t - b.t),
    [points],
  );

  const stroke = color ?? (status && status !== 'neutral' ? STATUS_META[status].color : seriesColor(0));
  const pad = 2;

  // No history yet: a flat hairline reads as "nothing recorded" without
  // implying a zero, which a plotted line at the baseline would.
  if (usable.length === 0) {
    return (
      <svg
        className={cx('cd-spark', 'cd-spark--empty', className)}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={label ?? 'No history recorded yet'}
      >
        <line x1={0} y1={height / 2} x2={width} y2={height / 2} strokeDasharray="3 3" />
      </svg>
    );
  }

  const first = usable[0];
  const last = usable[usable.length - 1];
  if (!first || !last) return null;

  const domainMax = Math.max(yDomain[1], ...usable.map((point) => point.pct));
  const x = timeScale([first.t, last.t], [pad, Math.max(pad + 1, width - pad)]);
  const y = linearScale([yDomain[0], domainMax], [height - pad, pad], { clamp: true });

  const coords = usable.map((point) => ({
    x: Number(x.map(point.t).toFixed(2)),
    y: Number(y.map(clamp(point.pct, yDomain[0], domainMax)).toFixed(2)),
  }));

  const line = coords
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x} ${point.y}`)
    .join(' ');
  const lastCoord = coords[coords.length - 1];
  const firstCoord = coords[0];
  const areaPath =
    area && firstCoord && lastCoord && coords.length > 1
      ? `${line} L${lastCoord.x} ${height - pad} L${firstCoord.x} ${height - pad} Z`
      : null;

  const description =
    label ??
    `Utilization trend, ${usable.length} samples, latest ${formatPct(last.pct)}, from ${formatPct(first.pct)}`;

  return (
    <svg
      className={cx('cd-spark', className)}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={description}
      style={{ color: stroke }}
    >
      {areaPath ? (
        <path className="cd-spark-area" d={areaPath} style={{ fill: seriesWash(stroke, 18) }} stroke="none" />
      ) : null}
      {coords.length > 1 ? (
        <path className="cd-spark-line" d={line} pathLength={1} fill="none" style={{ stroke }} />
      ) : null}
      {lastCoord ? (
        <circle className="cd-spark-end" cx={lastCoord.x} cy={lastCoord.y} r={2} style={{ fill: stroke }} />
      ) : null}
    </svg>
  );
}

export default Sparkline;
