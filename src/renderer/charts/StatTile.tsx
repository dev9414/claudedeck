/**
 * The KPI tile: one figure, its label, an optional qualifier and an optional
 * sparkline.
 *
 * `status` tints the tile and the spark, and always ships the matching glyph
 * and word alongside — the warning and serious steps sit below 3:1 on the
 * light surface, so the colour is reinforcement, never the signal.
 */

import type { ReactNode } from 'react';
import { useCountUp } from '../hooks/useCountUp';
import { Icon, cx } from '../components/Icon';
import { STATUS_META, type ChartStatus } from './ChartFrame';
import { Sparkline, type SparkPoint } from './Sparkline';

export type StatStatus = ChartStatus;

export interface StatTileProps {
  label: ReactNode;
  /**
   * A finite `number` is counted to its new value, so a figure that moves says
   * how far it moved. Anything else renders verbatim — a label like "Not on
   * this pace" has no trajectory and must not be given one.
   */
  value: ReactNode;
  sub?: ReactNode;
  status?: ChartStatus;
  /** Inline trend for the same figure. */
  spark?: readonly SparkPoint[];
  /** Renders the counted figure. Only consulted when `value` is a number. */
  formatValue?: (value: number) => string;
  /** Makes the whole tile a button, e.g. to jump to the account it summarises. */
  onClick?: () => void;
  className?: string;
}

export function StatTile({
  label,
  value,
  sub,
  status,
  spark,
  formatValue,
  onClick,
  className,
}: StatTileProps) {
  const meta = status ? STATUS_META[status] : null;
  // Called unconditionally, as hooks must be; its result is only read when the
  // figure is actually a number.
  const numeric = typeof value === 'number' && Number.isFinite(value);
  const counted = useCountUp(numeric ? value : 0);
  // Tabular figures while counting, or the tile reflows on every frame.
  const figure = numeric ? (
    <span className="cd-num">{formatValue ? formatValue(counted) : String(Math.round(counted))}</span>
  ) : (
    value
  );
  const body = (
    <>
      <div className="cd-stat-top">
        <span className="cd-stat-label">{label}</span>
        {meta ? (
          <span className="cd-stat-state" data-status={status}>
            <Icon name={meta.icon} size={12} />
            {meta.label}
          </span>
        ) : null}
      </div>
      <div className="cd-stat-value">{figure}</div>
      {sub ? <div className="cd-stat-sub">{sub}</div> : null}
      {spark && spark.length > 0 ? (
        <div className="cd-stat-spark">
          <Sparkline points={spark} width={140} height={26} status={status ?? 'neutral'} />
        </div>
      ) : null}
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        className={cx('cd-stat', 'cd-stat--action', className)}
        data-status={status ?? 'none'}
        onClick={onClick}
      >
        {body}
      </button>
    );
  }

  return (
    <div className={cx('cd-stat', className)} data-status={status ?? 'none'}>
      {body}
    </div>
  );
}

export default StatTile;
