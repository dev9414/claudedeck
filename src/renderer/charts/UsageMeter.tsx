/**
 * The quota meter: one horizontal bar per rate-limit window (5h, 7d, and any
 * per-model weekly window the API reports).
 *
 * Bars are anchored to a zero baseline with a rounded data end, direct-labelled
 * with the figure, and carry an icon plus the state word so the threshold
 * colour is never doing the work alone. The reset countdown is the second thing
 * people look for, so it sits in the same row.
 */

import { useMemo } from 'react';
import type { UsageWindow } from '@shared/types';
import { useCountUp } from '../hooks/useCountUp';
import { Icon, cx } from '../components/Icon';
import {
  ChartEmpty,
  ChartTableFallback,
  STATUS_META,
  statusForPct,
  useNow,
  type ChartTableInput,
} from './ChartFrame';
import { clamp, formatDuration, formatPct, NO_VALUE } from './scales';

export interface UsageMeterProps {
  windows: readonly UsageWindow[];
  /** One line per window, for list rows and the tray-sized layouts. */
  compact?: boolean;
  className?: string;
  /** Injectable clock, so the countdown is deterministic in tests. */
  now?: number;
}

function resetMs(window: UsageWindow, now: number): number | null {
  if (!window.resetsAt) return null;
  const at = Date.parse(window.resetsAt);
  if (!Number.isFinite(at)) return null;
  return at - now;
}

/**
 * The figure over the bar. It runs to its new reading alongside the fill, so
 * the two say the same thing at the same time; the `progressbar` above still
 * exposes the settled value, because assistive tech must never be handed a
 * number that is mid-flight.
 */
function MeterValue({ pct }: { pct: number }) {
  const readable = Number.isFinite(pct);
  const shown = useCountUp(readable ? pct : 0);
  // Pin the decimal count to the target. formatPct picks it per value, so an
  // unpinned count would gain and lose a decimal place on the way up.
  const digits = Number.isInteger(pct) || Math.abs(pct) >= 10 ? 0 : 1;
  return (
    <span className="cd-meter-value cd-num">{readable ? formatPct(shown, digits) : NO_VALUE}</span>
  );
}

export function UsageMeter({ windows, compact = false, className, now }: UsageMeterProps) {
  const ticking = useNow(now === undefined ? 30_000 : 0);
  const clock = now ?? ticking;

  const rows = useMemo(
    () =>
      windows.map((window) => {
        const pct = Number.isFinite(window.pct) ? window.pct : Number.NaN;
        const status = statusForPct(pct);
        return { window, pct, status, meta: STATUS_META[status] };
      }),
    [windows],
  );

  const table = useMemo<ChartTableInput | null>(() => {
    if (rows.length === 0) return null;
    return {
      columns: ['Window', 'Utilization', 'State', 'Resets in'],
      caption: 'Quota windows for this account.',
      numericColumns: [1],
      rows: rows.map((row) => {
        const remaining = resetMs(row.window, clock);
        return [
          row.window.label || row.window.key,
          Number.isFinite(row.pct) ? Number(row.pct.toFixed(1)) : null,
          row.meta.label,
          remaining === null ? NO_VALUE : formatDuration(remaining),
        ];
      }),
    };
  }, [rows, clock]);

  if (rows.length === 0) {
    return (
      <ChartEmpty
        icon="activity"
        title="No quota windows reported"
        hint="API-key accounts carry no subscription quota, and a fresh account has nothing polled yet."
      />
    );
  }

  return (
    <div className={cx('cd-meter', compact && 'cd-meter--compact', className)}>
      <ul className="cd-meter-list">
        {rows.map(({ window, pct, status, meta }) => {
          const remaining = resetMs(window, clock);
          const label = window.label || window.key;
          const readable = Number.isFinite(pct);
          const width = readable ? clamp(pct, 0, 100) : 0;
          return (
            <li className="cd-meter-row" key={window.key}>
              <div className="cd-meter-top">
                <span className="cd-meter-label">{label}</span>
                <MeterValue pct={pct} />
              </div>
              <div
                className="cd-meter-track"
                role="progressbar"
                aria-label={`${label} utilization`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={readable ? Math.round(pct) : undefined}
                aria-valuetext={readable ? `${formatPct(pct)}, ${meta.label}` : 'not reported'}
              >
                <div className="cd-meter-fill" data-status={status} style={{ width: `${width}%` }} />
              </div>
              <div className="cd-meter-foot">
                <span className="cd-meter-state" data-status={status}>
                  <Icon name={meta.icon} size={12} />
                  {meta.label}
                </span>
                {remaining === null ? null : (
                  <span className="cd-meter-reset">
                    <Icon name="clock" size={12} />
                    {remaining <= 0 ? 'reset due' : `resets in ${formatDuration(remaining)}`}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <ChartTableFallback table={table} />
    </div>
  );
}

export default UsageMeter;
