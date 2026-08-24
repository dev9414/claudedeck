/**
 * Burn rate per account: how many utilization points an hour each one is
 * consuming, as horizontal bars on a single shared scale.
 *
 * A fit over three noisy samples is not the same claim as a fit over forty, so
 * low-confidence rows are drawn with a reduced-opacity fill *and* labelled in
 * words. Bars keep the order they arrive in and their colour with them; they
 * are never re-coloured by rank.
 */

import { useMemo } from 'react';
import { Icon, cx } from '../components/Icon';
import {
  ChartEmpty,
  ChartTableFallback,
  seriesColor,
  type ChartTableInput,
} from './ChartFrame';
import { clamp, formatPct, niceTicks } from './scales';

export interface BurnRateRow {
  slot: number;
  label: string;
  /** Utilization points per hour. Negative after a window reset. */
  pctPerHour: number;
  /** 0-1. Below `lowConfidence` the row is drawn and labelled as uncertain. */
  confidence: number;
}

export interface BurnRateBarsProps {
  rows: readonly BurnRateRow[];
  /** Confidence below which a row is called out. Defaults to 0.5. */
  lowConfidence?: number;
  className?: string;
}

export function BurnRateBars({ rows, lowConfidence = 0.5, className }: BurnRateBarsProps) {
  const prepared = useMemo(
    () =>
      rows.map((row, index) => {
        const rate = Number.isFinite(row.pctPerHour) ? row.pctPerHour : 0;
        const confidence = Number.isFinite(row.confidence) ? clamp(row.confidence, 0, 1) : 0;
        return {
          ...row,
          rate,
          confidence,
          low: confidence < lowConfidence,
          color: seriesColor(index),
        };
      }),
    [rows, lowConfidence],
  );

  const scaleMax = useMemo(() => {
    const peak = prepared.reduce((max, row) => Math.max(max, row.rate), 0);
    if (peak <= 0) return 1;
    const ticks = niceTicks(0, peak, 3);
    const top = ticks[ticks.length - 1];
    return top !== undefined && top >= peak ? top : peak;
  }, [prepared]);

  const table = useMemo<ChartTableInput | null>(() => {
    if (prepared.length === 0) return null;
    return {
      columns: ['Account', 'Burn (points/hour)', 'Confidence', 'Reliability'],
      caption: 'Least-squares burn rate per account over the recorded history.',
      numericColumns: [1, 2],
      rows: prepared.map((row) => [
        row.label,
        Number(row.rate.toFixed(2)),
        Number(row.confidence.toFixed(2)),
        row.low ? 'low confidence' : 'usable',
      ]),
    };
  }, [prepared]);

  if (prepared.length === 0) {
    return (
      <ChartEmpty
        icon="activity"
        title="No burn rate yet"
        hint="Two or more polls of the same window are needed before a rate can be fitted."
      />
    );
  }


  return (
    <div className={cx('cd-burn', className)}>
      <ul className="cd-burn-list">
        {prepared.map((row) => {
          const width = clamp((Math.max(0, row.rate) / scaleMax) * 100, 0, 100);
          return (
            <li className="cd-burn-row" key={`${row.slot}-${row.label}`}>
              <span className="cd-burn-label" title={row.label}>
                {row.label}
              </span>
              <span className="cd-burn-track">
                <span
                  className="cd-burn-fill"
                  style={{ width: `${width}%`, background: row.color, opacity: row.low ? 0.45 : 1 }}
                />
              </span>
              <span className="cd-burn-value cd-num">{`${formatPct(row.rate, 1)}/h`}</span>
              <span className="cd-burn-flag">
                {row.low ? (
                  <>
                    <Icon name="info" size={12} />
                    low confidence
                  </>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="cd-burn-foot">
        {/* Each low-confidence row already carries its own labelled chip, so
            repeating the explanation here was a second sentence for one fact. */}
        {`Scale 0 to ${formatPct(scaleMax, 1)} per hour.`}
      </p>
      <ChartTableFallback table={table} />
    </div>
  );
}

export default BurnRateBars;
