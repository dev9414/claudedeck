/**
 * Timeline: the history explorer.
 *
 * One range control, one window selector, one y-axis. The projection cone comes
 * from `getForecasts()` and is labelled an estimate everywhere it appears —
 * including in the table view, which is a first-class way to read this screen
 * rather than a fallback for it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Account, Forecast, HistoryPoint } from '@shared/types';
import { useDeckState } from '../hooks/useDeckState';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { Icon } from '../components/Icon';
import { BurnRateBars } from '../charts/BurnRateBars';
import { ChartFrame } from '../charts/ChartFrame';
import { UsageTimeline } from '../charts/UsageTimeline';
import './views.css';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Points per series before striding kicks in; the plot is ~900px at most. */
const MAX_POINTS = 600;
const TABLE_ROW_CAP = 60;

const RANGES = [
  { id: '24h', label: '24 hours', span: DAY },
  { id: '7d', label: '7 days', span: 7 * DAY },
  { id: '30d', label: '30 days', span: 30 * DAY },
  { id: 'all', label: 'All recorded', span: null },
] as const;

type RangeKey = (typeof RANGES)[number]['id'];

interface TimelinePoint {
  t: number;
  pct: number;
}

interface TimelineSeries {
  slot: number;
  email: string;
  alias?: string;
  points: TimelinePoint[];
}

interface BurnRow {
  slot: number;
  label: string;
  pctPerHour: number;
  confidence: number;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function duration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${rest}m`;
  return `${rest}m`;
}

function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return typeof cause === 'string' ? cause : 'The main process did not answer.';
}

function accountLabel(account: Account): string {
  return account.alias ?? account.email;
}

// ---------------------------------------------------------------------------
// Derivations
// ---------------------------------------------------------------------------

/** Every window key any account reports, in a stable display order. */
function windowOptions(accounts: Account[]): Array<{ key: string; label: string }> {
  const options = new Map<string, string>([
    ['5h', '5-hour'],
    ['7d', '7-day'],
  ]);
  for (const account of accounts) {
    const usage = account.usage ?? account.lastGoodUsage;
    if (!usage) continue;
    if (usage.fiveHour) options.set(usage.fiveHour.key, usage.fiveHour.label);
    if (usage.sevenDay) options.set(usage.sevenDay.key, usage.sevenDay.label);
    for (const scoped of usage.scoped) options.set(scoped.key, scoped.label);
  }
  return [...options.entries()].map(([key, label]) => ({ key, label }));
}

/**
 * One series per account in slot order — never rank order — strided down to a
 * drawable point count. Folding past the eighth series belongs to the chart,
 * which owns the categorical palette, so every account is handed over.
 */
function buildSeries(accounts: Account[], history: HistoryPoint[], windowKey: string): TimelineSeries[] {
  const bySlot = new Map<number, TimelinePoint[]>();
  for (const point of history) {
    const pct = point.windows[windowKey];
    if (pct === undefined) continue;
    const bucket = bySlot.get(point.slot);
    if (bucket) bucket.push({ t: point.t, pct });
    else bySlot.set(point.slot, [{ t: point.t, pct }]);
  }
  for (const bucket of bySlot.values()) bucket.sort((a, b) => a.t - b.t);

  const stride = (points: TimelinePoint[]): TimelinePoint[] => {
    if (points.length <= MAX_POINTS) return points;
    const step = Math.ceil(points.length / MAX_POINTS);
    const kept = points.filter((_, i) => i % step === 0);
    const last = points[points.length - 1];
    // The newest observation is the one the user is actually looking for, so it
    // survives striding even when the modulus would drop it.
    if (last && kept[kept.length - 1] !== last) kept.push(last);
    return kept;
  };

  return [...accounts]
    .sort((a, b) => a.slot - b.slot)
    .filter((account) => bySlot.has(account.slot))
    .map((account) => ({
      slot: account.slot,
      email: account.email,
      alias: account.alias,
      points: stride(bySlot.get(account.slot) ?? []),
    }));
}

function seriesTable(series: TimelineSeries[], withDate: boolean): Array<Record<string, string | number>> {
  const stamps = [...new Set(series.flatMap((s) => s.points.map((p) => p.t)))].sort((a, b) => a - b);
  const step = Math.max(1, Math.ceil(stamps.length / TABLE_ROW_CAP));
  const format = (t: number): string =>
    withDate
      ? new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return stamps
    .filter((_, i) => i % step === 0)
    .map((t) => {
      const row: Record<string, string | number> = { When: format(t) };
      for (const s of series) {
        const hit = s.points.find((p) => p.t === t);
        row[s.alias ?? s.email] = hit ? round1(hit.pct) : '—';
      }
      return row;
    });
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export function Timeline() {
  const { state, loading, error, api, reload } = useDeckState();

  const accounts = useMemo<Account[]>(() => state?.accounts ?? [], [state]);
  const active = useMemo(
    () => accounts.find((a) => a.active) ?? accounts.find((a) => a.slot === state?.activeSlot) ?? null,
    [accounts, state?.activeSlot],
  );
  const pollStamp = accounts.map((a) => `${a.slot}:${a.usage?.fetchedAt ?? 0}`).join(',');

  const [range, setRange] = useState<RangeKey>('24h');
  const [windowKey, setWindowKey] = useState('5h');
  const [history, setHistory] = useState<HistoryPoint[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [byAccount, setByAccount] = useState<Map<number, Forecast[]> | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const options = useMemo(() => windowOptions(accounts), [accounts]);
  // A model window disappears when its account is removed; fall back rather
  // than keep querying a key nothing reports.
  useEffect(() => {
    if (options.length > 0 && !options.some((o) => o.key === windowKey)) setWindowKey(options[0]?.key ?? '5h');
  }, [options, windowKey]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const span = RANGES.find((r) => r.id === range)?.span ?? null;

  useEffect(() => {
    let cancelled = false;
    setHistory(null);
    setHistoryError(null);
    api
      .getHistory(span === null ? {} : { since: Date.now() - span })
      .then((points) => {
        if (!cancelled) setHistory(points);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setHistoryError(messageOf(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [api, span, pollStamp]);

  useEffect(() => {
    let cancelled = false;
    const slots = accounts.map((a) => a.slot);
    Promise.all(
      slots.map(async (slot) => [slot, await api.getForecasts(slot)] as const),
    )
      .then((pairs) => {
        if (!cancelled) setByAccount(new Map(pairs));
      })
      .catch(() => {
        // Forecasts are an estimate on top of history; their absence is a
        // reportable state in the panel, not a view-level failure.
        if (!cancelled) setByAccount(new Map());
      });
    return () => {
      cancelled = true;
    };
    // `pollStamp` carries both the slot set and every fetch time, so it is the
    // complete trigger for a refit; the account array identity is not.
  }, [api, pollStamp]);

  const refetch = useCallback(() => {
    setHistory(null);
    setHistoryError(null);
    api
      .getHistory(span === null ? {} : { since: Date.now() - span })
      .then(setHistory)
      .catch((cause: unknown) => setHistoryError(messageOf(cause)));
  }, [api, span]);

  // --- gates ---------------------------------------------------------------

  if (loading && !state) {
    return (
      <p className="cd-view-loading" role="status" aria-live="polite">
        <Icon name="refresh" className="cd-spin" />
        Reading recorded history…
      </p>
    );
  }

  if (!state) {
    return (
      <div className="cd-view">
        <EmptyState
          icon="alert-octagon"
          tone="warning"
          title="The timeline has no state to read"
          description={error ?? 'The main process did not answer the state request.'}
          action={
            <Button variant="primary" icon="refresh" onClick={() => void reload()}>
              Try again
            </Button>
          }
        />
      </div>
    );
  }

  // --- derived -------------------------------------------------------------

  const series = history ? buildSeries(accounts, history, windowKey) : [];
  const tableRows = seriesTable(series, range !== '24h');
  const windowLabel = options.find((o) => o.key === windowKey)?.label ?? windowKey;
  const rangeLabel = RANGES.find((r) => r.id === range)?.label ?? range;

  const focusForecasts = active && byAccount ? (byAccount.get(active.slot) ?? []) : [];
  const windowForecast = focusForecasts.find((f) => f.windowKey === windowKey) ?? null;
  // Tagged with its slot so the chart pins each cone to the line it belongs to
  // instead of dropping an ambiguous projection.
  const coneForecasts = byAccount
    ? [...byAccount.entries()].flatMap(([slot, list]) => {
        const fit = list.find((f) => f.windowKey === windowKey);
        return fit ? [{ ...fit, slot }] : [];
      })
    : [];

  const burnRows: BurnRow[] = [];
  const withoutFit: Account[] = [];
  for (const account of [...accounts].sort((a, b) => a.slot - b.slot)) {
    const forecast = byAccount?.get(account.slot)?.find((f) => f.windowKey === windowKey);
    if (forecast) {
      burnRows.push({
        slot: account.slot,
        label: accountLabel(account),
        pctPerHour: forecast.burn.pctPerHour,
        confidence: forecast.burn.confidence,
      });
    } else if (byAccount) {
      withoutFit.push(account);
    }
  }

  const burnTable: Array<Record<string, string | number>> = burnRows.map((row) => ({
    Account: row.label,
    Slot: row.slot,
    'Percent per hour': round1(row.pctPerHour),
    Confidence: `${Math.round(row.confidence * 100)}%`,
  }));

  const parsedExhaustion = windowForecast?.exhaustionAt ? Date.parse(windowForecast.exhaustionAt) : Number.NaN;
  const exhaustionMs = Number.isFinite(parsedExhaustion) ? parsedExhaustion : null;

  return (
    <div className="cd-view">
      <header className="cd-view-head">
        <h1 className="cd-h1">Timeline</h1>
        <p className="cd-view-sub">
          Recorded utilization per account. ClaudeDeck keeps {state.settings.historyRetentionDays} days of points.
        </p>
        <span className="cd-spacer" />
        {state.demoMode ? <Badge tone="info">Demo data</Badge> : null}
      </header>

      {error ? (
        <div className="cd-note cd-note--error" role="alert">
          <Icon name="alert-octagon" />
          <span className="cd-note-body">
            <span className="cd-note-title">State update failed</span>
            <span>{error} The chart below is drawn from the last data ClaudeDeck received.</span>
          </span>
        </div>
      ) : null}

      <div className="cd-tl-controls">
        <div className="cd-field">
          <span id="cd-tl-range">Range</span>
          <div className="cd-seg" role="group" aria-labelledby="cd-tl-range">
            {RANGES.map((preset) => (
              <Button
                key={preset.id}
                size="sm"
                variant="ghost"
                aria-pressed={range === preset.id}
                onClick={() => setRange(preset.id)}
              >
                {preset.label}
              </Button>
            ))}
          </div>
        </div>

        <label className="cd-field">
          <span>Window</span>
          <select
            className="cd-select"
            value={windowKey}
            onChange={(event) => setWindowKey(event.target.value)}
            disabled={options.length === 0}
          >
            {options.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <span className="cd-spacer" />

        <Button icon="refresh" size="sm" onClick={refetch} disabled={history === null && historyError === null}>
          Reload history
        </Button>
      </div>

      {historyError ? (
        <div className="cd-note cd-note--error" role="alert">
          <Icon name="alert-octagon" />
          <span className="cd-note-body">
            <span className="cd-note-title">History could not be read</span>
            <span>{historyError}</span>
          </span>
        </div>
      ) : null}

      <div className="cd-tl-split">
        <div className="cd-stack">
          {history === null && historyError === null ? (
            <p className="cd-view-loading" role="status" aria-live="polite">
              <Icon name="refresh" className="cd-spin" />
              Loading {rangeLabel.toLowerCase()} of history…
            </p>
          ) : series.length === 0 ? (
            <EmptyState
              icon="activity"
              title={`Nothing recorded for the ${windowLabel} window in this range`}
              description="A point is written every time ClaudeDeck polls usage. Widen the range, pick another window, or refresh usage from the title bar to start the record."
            />
          ) : (
            <ChartFrame
              title={
                series.length === 1
                  ? `${windowLabel} utilization — ${series[0]?.alias ?? series[0]?.email ?? 'one account'}`
                  : `${windowLabel} utilization`
              }
              subtitle={`${rangeLabel} · percent of the window used${
                coneForecasts.length > 0 ? ' · dashed cone is a projection, not a measurement' : ''
              }`}
              tableRows={tableRows}
              height={380}
            >
              <UsageTimeline
                series={series}
                windowKey={windowKey}
                forecasts={coneForecasts}
                height={380}
              />
            </ChartFrame>
          )}
        </div>

        <div className="cd-stack">
          {byAccount === null ? (
            <p className="cd-view-loading" role="status" aria-live="polite">
              <Icon name="refresh" className="cd-spin" />
              Fitting burn rates…
            </p>
          ) : burnRows.length === 0 ? (
            <EmptyState
              icon="info"
              title="No burn rate for this window yet"
              description="A rate needs at least two observations inside the same window. Keep ClaudeDeck polling and this fills in."
            />
          ) : (
            <ChartFrame
              title={`Burn rate — ${windowLabel}`}
              subtitle="Utilization points consumed per hour, fitted over recent history."
              tableRows={burnTable}
            >
              <BurnRateBars rows={burnRows} />
            </ChartFrame>
          )}

          <section className="cd-card" aria-labelledby="cd-tl-projection">
            <div className="cd-card-head">
              <Icon name="activity" />
              <h2 className="cd-h2" id="cd-tl-projection">
                Projection for {active ? accountLabel(active) : 'the active account'}
              </h2>
            </div>

            {!active ? (
              <p className="cd-secondary">No account is signed in, so there is nothing to project.</p>
            ) : windowForecast === null ? (
              <p className="cd-secondary">
                No fit for the {windowLabel} window on this account yet. Projections appear once two polls land
                inside one window.
              </p>
            ) : (
              <ul className="cd-forecast-list">
                <li>
                  <Icon name="bolt" size={12} />
                  <strong>{round1(windowForecast.burn.pctPerHour)}% per hour</strong>
                  <span>
                    from {windowForecast.burn.samples} samples ·{' '}
                    {Math.round(windowForecast.burn.confidence * 100)}% confidence
                  </span>
                </li>
                <li>
                  <Icon name="clock" size={12} />
                  {exhaustionMs === null ? (
                    <strong>Not trending toward 100%</strong>
                  ) : (
                    <strong>
                      {exhaustionMs <= now ? 'Estimated at 100% now' : `Estimated 100% in ${duration(exhaustionMs - now)}`}
                    </strong>
                  )}
                  <span>estimate, not a measurement</span>
                </li>
                <li>
                  <Icon name={windowForecast.lastsToReset ? 'check' : 'alert-triangle'} size={12} />
                  <strong>
                    {windowForecast.lastsToReset
                      ? 'Survives to its own reset'
                      : 'Runs out before its reset'}
                  </strong>
                </li>
                {windowForecast.expectedPct !== undefined ? (
                  <li>
                    <Icon name={windowForecast.aheadOfPace ? 'alert-triangle' : 'check'} size={12} />
                    <strong>{windowForecast.aheadOfPace ? 'Ahead of an even pace' : 'At or under an even pace'}</strong>
                    <span>even pace would sit at {round1(windowForecast.expectedPct)}%</span>
                  </li>
                ) : null}
              </ul>
            )}

            {withoutFit.length > 0 ? (
              <p className="cd-muted">
                No {windowLabel} fit yet for {withoutFit.map((a) => `slot ${a.slot}`).join(', ')}.
              </p>
            ) : null}
          </section>
        </div>
      </div>
    </div>
  );
}

export default Timeline;
