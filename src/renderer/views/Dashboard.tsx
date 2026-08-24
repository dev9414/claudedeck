/**
 * Dashboard: the at-a-glance answer to "can I keep working right now?".
 *
 * Four stat tiles, the active account's quota meter, a 24-hour utilization
 * chart across every account, and the switch control. The switch is a two-step
 * on purpose — `previewSwitch()` returns the exact file writes a real switch
 * would perform, and that manifest is shown and confirmed before anything
 * touches disk. Hiding it would make the one destructive action in the app the
 * least legible one.
 *
 * Two invariants this screen kept breaking, both now held in one place:
 * every figure states percent *used*, the direction the bars, the API and
 * Automation already use; and a tile's status is judged against the window's
 * own clock — how far in we are, when it resets — never against a flat
 * percentage, or almost everything reads amber and amber stops meaning
 * anything.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  Account,
  Forecast,
  HistoryPoint,
  SwitchRequest,
  SwitchStrategy,
  SwitchResult,
  UsageSnapshot,
  UsageWindow,
} from '@shared/types';
import { headroom } from '@core/usage';
import { useDeckState } from '../hooks/useDeckState';
import { Badge, USAGE_STATUS_META } from '../components/Badge';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { ChartFrame, STATUS_THRESHOLDS, statusForPct, type ChartStatus } from '../charts/ChartFrame';
import { StatTile } from '../charts/StatTile';
import { UsageMeter } from '../charts/UsageMeter';
import { UsageTimeline } from '../charts/UsageTimeline';
import { formatPct } from '../charts/scales';
import './views.css';

const HOUR = 3_600_000;
const TABLE_ROW_CAP = 48;

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

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * `confidence` scores how well the line fits the recorded points -- it is not a
 * probability that the projection comes true. Rendering it as "100% confidence"
 * next to a future timestamp reads as certainty about the future, which is a
 * claim the arithmetic cannot support, so it is described in words instead.
 */
function describeFit(confidence: number): string {
  if (confidence >= 0.75) return 'strong fit';
  if (confidence >= 0.5) return 'fair fit';
  if (confidence >= 0.35) return 'weak fit';
  return 'low confidence';
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * The same formatter the meters use.
 *
 * These two disagreed: the tile printed one decimal while the bar below it
 * rounded to a whole number, so a 61.5% window read "61.5%" up here and "62%"
 * down there. One formatter, one answer -- the point of this view is that its
 * numbers agree with each other.
 */
function pctText(value: number): string {
  return formatPct(value);
}

/** Coarse, honest duration: never more precise than the estimate behind it. */
function duration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${rest}m`;
  return `${rest}m`;
}

function ago(then: number, now: number): string {
  const delta = now - then;
  return delta < 60_000 ? 'just now' : `${duration(delta)} ago`;
}

/** An ISO instant as epoch ms, or null when the API reported nothing usable. */
function instant(iso: string | undefined): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? at : null;
}

/** Countdown to a window reset, or an honest "not reported". */
function resetText(iso: string | undefined, now: number): string {
  const at = instant(iso);
  if (at === null) return 'not reported';
  return at <= now ? 'due now' : `in ${duration(at - now)}`;
}

function clockLabel(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function accountLabel(account: Account): string {
  return account.alias ?? account.email;
}

function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return typeof cause === 'string' ? cause : 'The main process did not answer.';
}

/** The shell routes on the hash, so a view can hand over without a prop. */
function goToAccounts(): void {
  if (typeof window !== 'undefined') window.location.hash = '#/accounts';
}

/**
 * A window's status, judged against how far into the window we are.
 *
 * A flat percentage paints a healthy window amber: 62% of a 7-day window that
 * is already 64% elapsed is exactly on budget, and calling that a warning makes
 * amber mean nothing. `expectedPct`/`aheadOfPace` carry the comparison the
 * forecaster already did, so amber here means "spending faster than the window
 * refills" — the only reading that carries information. Above the critical line
 * the absolute number gates regardless of pace: nearly spent is nearly spent.
 * With no reported reset there is no elapsed fraction to compare, so the flat
 * thresholds stand in and the tile says the pace is unknown.
 */
function paceStatus(usedPct: number, forecast: Forecast | null): ChartStatus {
  if (usedPct >= STATUS_THRESHOLDS.critical) return 'critical';
  if (forecast?.expectedPct === undefined) return statusForPct(usedPct);
  return forecast.aheadOfPace ? statusForPct(usedPct) : 'good';
}

/**
 * How urgent a projection that lands *before* its own reset is, measured
 * against the time left in the window rather than the clock: "half the time
 * left" is the same news in a 5-hour window and a 7-day one.
 */
function projectionStatus(exhaustIn: number, resetIn: number | null): ChartStatus {
  if (exhaustIn < HOUR) return 'critical';
  if (resetIn === null || resetIn <= 0) return exhaustIn < 4 * HOUR ? 'serious' : 'warning';
  return exhaustIn / resetIn < 0.34 ? 'serious' : 'warning';
}

interface TileCopy {
  value: string;
  sub: string;
  status: ChartStatus;
}

/**
 * The projection tile's states.
 *
 * The one the old tile got wrong is the good news: a projected 100% that lands
 * after the window's own reset cannot happen, because the reset wipes the
 * counter first — raising it as a warning was arithmetically impossible. It is
 * stated as good news instead, with the raw projection kept in the subtitle
 * where it can still be checked.
 */
function projectionTile(
  forecasts: Forecast[] | null,
  forecast: Forecast | null,
  exhaustionMs: number | null,
  windowLabel: string,
  resetIn: number | null,
  now: number,
): TileCopy {
  if (forecasts === null) {
    return { value: 'Loading', sub: 'Fitting the recent burn rate.', status: 'neutral' };
  }
  if (forecast === null) {
    return {
      value: 'No projection',
      sub: 'Not enough history yet — two polls inside one window are needed.',
      status: 'neutral',
    };
  }
  const fit = describeFit(forecast.burn.confidence);
  if (exhaustionMs === null) {
    return { value: 'Not on this pace', sub: `${windowLabel} · ${fit}`, status: 'good' };
  }
  const left = Math.max(0, exhaustionMs - now);
  if (forecast.lastsToReset) {
    const resets = resetIn === null || resetIn <= 0 ? '' : `, after the ${windowLabel} reset in ${duration(resetIn)}`;
    return {
      value: 'Resets before it runs out',
      sub: `Estimate: 100% in ${duration(left)}${resets} · ${fit}`,
      status: 'good',
    };
  }
  return {
    value: left < 60_000 ? 'Due now' : `in ${duration(left)}`,
    sub: `Estimate · ${windowLabel} · ${fit}`,
    status: projectionStatus(left, resetIn),
  };
}

/** The switch request a Target selection means. */
function requestFor(choice: string): SwitchRequest {
  const slotMatch = /^slot:(\d+)$/.exec(choice);
  return slotMatch && slotMatch[1] !== undefined
    ? { target: Number(slotMatch[1]), reason: 'manual' }
    : { strategy: choice as SwitchStrategy, reason: 'manual' };
}

const KIND_LABEL: Record<Account['kind'], string> = {
  oauth: 'OAuth',
  'setup-token': 'Setup token',
  'api-key': 'API key',
};

/**
 * A usage status as a tile status. `no-quota` is deliberately neutral: an
 * API-key account having no window is the expected shape, not a fault.
 */
const STATUS_FOR_USAGE: Record<Account['usageStatus'], ChartStatus> = {
  ok: 'good',
  unavailable: 'neutral',
  'token-expired': 'warning',
  'rate-limited': 'critical',
  quarantined: 'serious',
  'no-quota': 'neutral',
};

// ---------------------------------------------------------------------------
// Derivations
// ---------------------------------------------------------------------------

/** The rate-limit windows, and only those — the meter's bars are quota gates. */
function meterWindows(account: Account | null): UsageWindow[] {
  const usage = account?.usage ?? account?.lastGoodUsage;
  if (!usage) return [];
  const windows: UsageWindow[] = [];
  if (usage.fiveHour) windows.push(usage.fiveHour);
  if (usage.sevenDay) windows.push(usage.sevenDay);
  windows.push(...usage.scoped);
  return windows;
}

/**
 * Pay-as-you-go credit, as its own line rather than a fourth bar.
 *
 * `spend` is a billing axis, not a rate-limit gate — `relevantWindows` in
 * core/usage.ts leaves it out of every switching decision — so a bar under a
 * heading that reads "Quota windows" claimed something untrue, and it also made
 * this screen show four windows where Accounts showed three. Same sentence on
 * both screens now.
 */
function spendNote(usage: UsageSnapshot | undefined): string | null {
  const spend = usage?.spend;
  if (!spend) return null;
  return `Extra usage credit: ${spend.used.toFixed(2)} of ${spend.limit.toFixed(2)} ${spend.currency} used — billed separately, not a rate limit.`;
}

/**
 * One series per account, in slot order — never in rank order, so a colour
 * never moves when usage does. Folding past the eighth series is the chart's
 * job, not the view's, so every account is handed over as it stands.
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

  return [...accounts]
    .sort((a, b) => a.slot - b.slot)
    .filter((account) => bySlot.has(account.slot))
    .map((account) => ({
      slot: account.slot,
      email: account.email,
      alias: account.alias,
      points: bySlot.get(account.slot) ?? [],
    }));
}

/** One row per sampled instant; every series always contributes a column. */
function seriesTable(series: TimelineSeries[]): Array<Record<string, string | number>> {
  const stamps = [...new Set(series.flatMap((s) => s.points.map((p) => p.t)))].sort((a, b) => a - b);
  const step = Math.max(1, Math.ceil(stamps.length / TABLE_ROW_CAP));
  const sampled = stamps.filter((_, i) => i % step === 0);
  return sampled.map((t) => {
    const row: Record<string, string | number> = { Time: clockLabel(t) };
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

export function Dashboard() {
  const { state, loading, error, api, reload } = useDeckState();

  const accounts = useMemo<Account[]>(() => state?.accounts ?? [], [state]);
  const active = useMemo(
    () => accounts.find((a) => a.active) ?? accounts.find((a) => a.slot === state?.activeSlot) ?? null,
    [accounts, state?.activeSlot],
  );
  const models = state?.settings.autoswitch.models ?? [];
  // Re-reads history whenever a poll lands, without re-running on every render.
  const pollStamp = accounts.map((a) => `${a.slot}:${a.usage?.fetchedAt ?? 0}`).join(',');
  // Everything the rotation rules read, so the resolved target is re-asked when
  // one of them moves and at no other time.
  const rotationStamp = accounts
    .map((a) => `${a.slot}:${a.active ? 1 : 0}${a.disabled ? 'd' : ''}${a.quarantinedAt ? 'q' : ''}:${a.usageStatus}`)
    .join(',');

  const [history, setHistory] = useState<HistoryPoint[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [forecasts, setForecasts] = useState<Forecast[] | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const [choice, setChoice] = useState('best');
  const [resolved, setResolved] = useState<SwitchResult | null>(null);
  const [resolveFailed, setResolveFailed] = useState(false);
  const [preview, setPreview] = useState<SwitchResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  // A minute is the finest granularity anything on this screen reports.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setHistoryError(null);
    api
      .getHistory({ since: Date.now() - 24 * HOUR })
      .then((points) => {
        if (!cancelled) setHistory(points);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setHistoryError(messageOf(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [api, pollStamp]);

  useEffect(() => {
    const slot = active?.slot;
    if (slot === undefined) {
      setForecasts(null);
      return;
    }
    let cancelled = false;
    api
      .getForecasts(slot)
      .then((next) => {
        if (!cancelled) setForecasts(next);
      })
      .catch(() => {
        // A missing forecast is a normal state, not an error worth a banner —
        // the tile says so in words.
        if (!cancelled) setForecasts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [api, active?.slot, pollStamp]);

  // The card has to name the account this rule lands on, so the rule is run on
  // render. `previewSwitch` is a dry run: it computes, it never writes.
  useEffect(() => {
    if (accounts.length < 2) {
      setResolved(null);
      setResolveFailed(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const result = await api.previewSwitch(requestFor(choice));
        if (cancelled) return;
        setResolved(result);
        setResolveFailed(false);
      } catch {
        if (cancelled) return;
        setResolved(null);
        setResolveFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, choice, accounts.length, pollStamp, rotationStamp]);

  const openPreview = useCallback(async () => {
    setPreviewing(true);
    setSwitchError(null);
    try {
      setPreview(await api.previewSwitch(requestFor(choice)));
    } catch (cause: unknown) {
      setSwitchError(messageOf(cause));
    } finally {
      setPreviewing(false);
    }
  }, [api, choice]);

  const confirmSwitch = useCallback(async () => {
    const target = preview?.to?.slot;
    if (target === undefined) return;
    setCommitting(true);
    setSwitchError(null);
    try {
      // Commit against the resolved slot, never the strategy: the user approved
      // this target, not "whatever the rule picks a second later".
      const result = await api.switchAccount({ target, reason: 'manual' });
      if (result.switched) {
        setPreview(null);
        setAnnouncement(`Switched to ${result.to?.email ?? `slot ${target}`}.`);
      } else {
        setSwitchError(result.error ?? result.reason);
      }
    } catch (cause: unknown) {
      setSwitchError(messageOf(cause));
    } finally {
      setCommitting(false);
    }
  }, [api, preview]);

  // --- gates ---------------------------------------------------------------

  if (loading && !state) {
    return (
      <p className="cd-view-loading" role="status" aria-live="polite">
        <Icon name="refresh" className="cd-spin" />
        Reading account state…
      </p>
    );
  }

  if (!state) {
    return (
      <div className="cd-view">
        <EmptyState
          icon="alert-octagon"
          tone="warning"
          title="The dashboard has no state to show"
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

  const usage = active?.usage ?? active?.lastGoodUsage;
  const room = headroom(usage, models);
  const windows = meterWindows(active);
  const bindingLabel =
    windows.find((w) => w.key === room?.bindingWindow)?.label ?? room?.bindingWindow ?? 'unknown window';
  // One direction for the whole view: percent *used*, the same way every bar
  // below, the API and Automation state it. The remainder goes in the subtitle.
  const usedPct = room === null ? null : 100 - room.remaining;
  // A window can read higher than the binding one and still not gate, because
  // the auto-switch model list decides what counts. Say so rather than look wrong.
  const ungated = windows.filter(
    (w) => room !== null && w.pct > 100 - room.remaining && w.key !== room.bindingWindow,
  );
  const credit = spendNote(usage);

  const attention = accounts.filter(
    (a) =>
      a.quarantinedAt !== undefined || a.usageStatus === 'rate-limited' || a.usageStatus === 'token-expired',
  );
  const disabled = accounts.filter((a) => a.disabled);

  const bindingForecast = forecasts?.find((f) => f.windowKey === room?.bindingWindow) ?? null;
  const forecast = bindingForecast ?? forecasts?.find((f) => f.exhaustionAt !== null) ?? null;
  const exhaustionMs = instant(forecast?.exhaustionAt ?? undefined);
  const forecastWindow = forecast ? windows.find((w) => w.key === forecast.windowKey) : undefined;
  const forecastLabel = forecastWindow?.label ?? forecast?.windowKey ?? 'this window';
  const forecastResetAt = instant(forecastWindow?.resetsAt);
  const forecastResetIn = forecastResetAt === null ? null : forecastResetAt - now;
  const projection = projectionTile(forecasts, forecast, exhaustionMs, forecastLabel, forecastResetIn, now);
  const paceNote =
    bindingForecast?.expectedPct === undefined ? null : bindingForecast.aheadOfPace ? 'ahead of pace' : 'on pace';

  const sparkPoints =
    active && history && room
      ? history
          .filter((p) => p.slot === active.slot)
          .map((p) => ({ t: p.t, pct: p.windows[room.bindingWindow] }))
          .filter((p): p is TimelinePoint => p.pct !== undefined)
      : [];

  const meterTable = windows.map((w) => ({
    Window: w.label,
    'Used %': round1(w.pct),
    Resets: resetText(w.resetsAt, now),
  }));

  const series = history ? buildSeries(accounts, history, '5h') : [];
  const tableRows = seriesTable(series);

  const canRotate = accounts.length >= 2;
  const resolvedTo = resolved?.to;
  const resolvedAccount = resolvedTo ? accounts.find((a) => a.slot === resolvedTo.slot) : undefined;
  const resolvedRoom = headroom(resolvedAccount?.usage ?? resolvedAccount?.lastGoodUsage, models);
  // A rule that resolves onto nothing would open a modal reading "No target
  // resolved", so the button that opens it is not offered.
  const noTarget = resolved !== null && resolvedTo === undefined;

  const previewTarget = preview?.to;
  const alreadyActive = previewTarget !== undefined && previewTarget.slot === state.activeSlot;
  const canCommit =
    previewTarget !== undefined && preview?.error === undefined && !alreadyActive && !state.settings.safeMode;

  return (
    <div className="cd-view">
      <header className="cd-view-head">
        <h1 className="cd-h1">Dashboard</h1>
        <p className="cd-view-sub">
          {active
            ? `Slot ${active.slot} — ${active.email} is signed in to Claude Code.`
            : 'No account is currently written into Claude Code.'}
        </p>
        <span className="cd-spacer" />
        {state.demoMode ? <Badge tone="info">Demo data</Badge> : null}
        {state.settings.safeMode ? (
          <Badge tone="warning" icon="ban">
            Safe mode — writes blocked
          </Badge>
        ) : null}
      </header>

      {error ? (
        <div className="cd-note cd-note--error" role="alert">
          <Icon name="alert-octagon" />
          <span className="cd-note-body">
            <span className="cd-note-title">State update failed</span>
            <span>{error} The numbers below are the last ones ClaudeDeck received.</span>
          </span>
        </div>
      ) : null}

      {/* --- tiles ------------------------------------------------------- */}

      <div className="cd-grid cd-tiles">
        <StatTile
          label="Active account"
          value={active ? accountLabel(active) : 'None'}
          sub={
            active
              ? `Slot ${active.slot} · ${KIND_LABEL[active.kind]} · ${USAGE_STATUS_META[active.usageStatus].label}`
              : 'Open Accounts to sign one in.'
          }
          status={active ? STATUS_FOR_USAGE[active.usageStatus] : 'neutral'}
          onClick={goToAccounts}
        />

        <StatTile
          label="Binding window used"
          value={usedPct === null ? 'Unknown' : pctText(usedPct)}
          sub={
            room === null
              ? 'No usage has been read for this account yet.'
              : `${pctText(room.remaining)} left in the ${bindingLabel} window${paceNote === null ? '' : ` · ${paceNote}`}`
          }
          status={usedPct === null ? 'neutral' : paceStatus(usedPct, bindingForecast)}
          spark={sparkPoints.length > 1 ? sparkPoints : undefined}
        />

        <StatTile
          label="Projected exhaustion"
          value={projection.value}
          sub={projection.sub}
          status={projection.status}
        />

        <StatTile
          label="Accounts healthy"
          value={accounts.length === 0 ? 'None' : `${accounts.length - attention.length}/${accounts.length}`}
          sub={
            accounts.length === 0
              ? 'No accounts are managed yet.'
              : attention.length === 0
                ? disabled.length === 0
                  ? 'Every managed account is reporting.'
                  : `${disabled.length} held out of rotation.`
                : `${attention.length} ${attention.length === 1 ? 'needs' : 'need'} attention: ${attention
                    .map((a) => `slot ${a.slot}`)
                    .join(', ')}`
          }
          status={
            accounts.length === 0
              ? 'neutral'
              : attention.length === 0
                ? 'good'
                : attention.length >= accounts.length
                  ? 'critical'
                  : 'warning'
          }
          onClick={goToAccounts}
        />
      </div>

      {/* --- meter + switch ---------------------------------------------- */}

      <div className="cd-dash-split">
        <div className="cd-stack">
          {windows.length > 0 ? (
            <ChartFrame
              title={active ? `Quota windows — ${accountLabel(active)}` : 'Quota windows'}
              subtitle={
                usage
                  ? `One bar per rate-limit window · read ${ago(usage.fetchedAt, now)}`
                  : 'One bar per rate-limit window'
              }
              tableRows={meterTable}
              height={Math.max(120, windows.length * 56)}
            >
              <UsageMeter windows={windows} />
            </ChartFrame>
          ) : (
            <EmptyState
              icon="info"
              title={active ? 'No quota windows for this account' : 'No active account'}
              description={
                active
                  ? active.kind === 'api-key'
                    ? 'API-key accounts bill per token and have no subscription window to track.'
                    : 'Usage has not been read yet. Use Refresh in the title bar to poll now.'
                  : 'Pick an account on the Accounts screen to make it the signed-in one.'
              }
            />
          )}

          {ungated.length > 0 ? (
            <p className="cd-window-note">
              {ungated.map((w) => w.label).join(', ')} sits higher but does not gate switching — add it to the
              auto-switch model list in Automation to make it count.
            </p>
          ) : null}

          {credit ? (
            <p className="cd-window-note">
              <Icon name="plus" size={12} /> {credit}
            </p>
          ) : null}
        </div>

        <section className="cd-card cd-switch-card" aria-labelledby="cd-dash-switch">
          <div className="cd-card-head">
            <Icon name="bolt" />
            <h2 className="cd-h2" id="cd-dash-switch">
              Switch account
            </h2>
          </div>
          {!canRotate ? (
            <>
              <p className="cd-secondary">
                {accounts.length === 0
                  ? 'No accounts are managed yet, so there is nowhere to switch to.'
                  : `Slot ${accounts[0]?.slot ?? 1} is the only managed account, so there is nowhere to switch to.`}
              </p>
              <Button variant="primary" icon="users" onClick={goToAccounts}>
                Add an account
              </Button>
            </>
          ) : (
            <>
              <div className="cd-switch-strategies">
                <label className="cd-field">
                  <span>Target</span>
                  <select
                    className="cd-select"
                    value={choice}
                    onChange={(event) => setChoice(event.target.value)}
                  >
                    <option value="best">Rule: most headroom</option>
                    <option value="next">Rule: next slot in order</option>
                    <option value="next-available">Rule: next slot with quota left</option>
                    <option value="consume-first">Rule: finish the current account first</option>
                    {accounts
                      .filter((a) => !a.active)
                      .map((a) => (
                        <option key={a.slot} value={`slot:${a.slot}`}>
                          Slot {a.slot} — {a.email}
                        </option>
                      ))}
                  </select>
                </label>

                {/* What the rule resolves to, run on render: the account you
                    would be signed in as is the only question this card is
                    actually asked. */}
                <p className="cd-secondary">
                  {resolveFailed ? (
                    'The engine could not be asked where this rule lands. Refresh usage and it will come back.'
                  ) : resolved === null ? (
                    'Resolving where this rule lands…'
                  ) : resolvedTo === undefined ? (
                    `No account is eligible: ${resolved.reason}`
                  ) : (
                    <>
                      Lands on{' '}
                      <strong>{resolvedAccount ? accountLabel(resolvedAccount) : resolvedTo.email}</strong> · slot{' '}
                      {resolvedTo.slot} ·{' '}
                      {resolvedRoom
                        ? `${pctText(100 - resolvedRoom.remaining)} used`
                        : 'usage not reported yet'}
                      {resolvedTo.slot === state.activeSlot ? ' · already signed in' : ''}
                    </>
                  )}
                </p>

                <Button
                  variant="primary"
                  icon="chevron"
                  busy={previewing}
                  disabled={noTarget}
                  onClick={() => void openPreview()}
                >
                  Preview switch
                </Button>
              </div>

              {switchError && preview === null ? (
                <div className="cd-note cd-note--error" role="alert">
                  <Icon name="alert-octagon" />
                  <span className="cd-note-body">
                    <span className="cd-note-title">Preview failed</span>
                    <span>{switchError}</span>
                  </span>
                </div>
              ) : null}
            </>
          )}
        </section>
      </div>

      {/* --- 24h timeline -------------------------------------------------- */}

      {historyError ? (
        <div className="cd-note cd-note--error" role="alert">
          <Icon name="alert-octagon" />
          <span className="cd-note-body">
            <span className="cd-note-title">History unavailable</span>
            <span>{historyError}</span>
          </span>
        </div>
      ) : history === null ? (
        <p className="cd-view-loading" role="status" aria-live="polite">
          <Icon name="refresh" className="cd-spin" />
          Loading the last 24 hours…
        </p>
      ) : series.length === 0 ? (
        <EmptyState
          icon="activity"
          title="No usage recorded in the last 24 hours"
          description="ClaudeDeck records a point every time it polls. Start auto-switch, or refresh usage, and the chart fills in from there."
        />
      ) : (
        <ChartFrame
          title={
            series.length === 1
              ? `5-hour utilization — ${series[0]?.alias ?? series[0]?.email ?? 'active account'}`
              : '5-hour utilization, last 24 hours'
          }
          subtitle={`Percent of the 5-hour window used, ${series.length} account${series.length === 1 ? '' : 's'}.`}
          tableRows={tableRows}
          height={200}
        >
          <UsageTimeline series={series} windowKey="5h" height={200} />
        </ChartFrame>
      )}

      {/* --- confirmation -------------------------------------------------- */}

      <Modal
        open={preview !== null}
        onClose={() => setPreview(null)}
        title="Confirm account switch"
        description="Nothing has been written yet. These are the exact files approving this would write."
        dismissOnOverlay={false}
        footer={
          <>
            <Button onClick={() => setPreview(null)}>Cancel</Button>
            <Button
              variant="primary"
              icon="check"
              busy={committing}
              disabled={!canCommit}
              onClick={() => void confirmSwitch()}
            >
              Write these changes
            </Button>
          </>
        }
      >
        {preview ? (
          <div className="cd-stack">
            <dl className="cd-kv">
              <dt>From</dt>
              <dd>{preview.from ? `Slot ${preview.from.slot} — ${preview.from.email}` : 'No active account'}</dd>
              <dt>To</dt>
              <dd>{previewTarget ? `Slot ${previewTarget.slot} — ${previewTarget.email}` : 'No target resolved'}</dd>
              <dt>Reason</dt>
              <dd>{preview.reason}</dd>
            </dl>

            <div>
              <h3 className="cd-h3">Planned writes</h3>
              {preview.plannedWrites && preview.plannedWrites.length > 0 ? (
                <ul className="cd-writes">
                  {preview.plannedWrites.map((write) => (
                    <li key={write}>{write}</li>
                  ))}
                </ul>
              ) : (
                <p className="cd-secondary">
                  The preview reported no file writes. That normally means the target is already the account on
                  disk.
                </p>
              )}
            </div>

            {preview.error ? (
              <div className="cd-note cd-note--error" role="alert">
                <Icon name="alert-octagon" />
                <span className="cd-note-body">
                  <span className="cd-note-title">This switch cannot run</span>
                  <span>{preview.error}</span>
                </span>
              </div>
            ) : null}

            {alreadyActive ? (
              <div className="cd-note" role="note">
                <Icon name="info" />
                <span className="cd-note-body">
                  <span className="cd-note-title">Already active</span>
                  <span>Slot {previewTarget?.slot} is the account Claude Code is using. Nothing to write.</span>
                </span>
              </div>
            ) : null}

            {state.settings.safeMode ? (
              <div className="cd-note cd-note--warning" role="note">
                <Icon name="ban" />
                <span className="cd-note-body">
                  <span className="cd-note-title">Safe mode is on</span>
                  <span>Every disk write is refused while safe mode is enabled. Turn it off in Settings first.</span>
                </span>
              </div>
            ) : null}

            {switchError ? (
              <div className="cd-note cd-note--error" role="alert">
                <Icon name="alert-octagon" />
                <span className="cd-note-body">
                  <span className="cd-note-title">Switch failed</span>
                  <span>{switchError}</span>
                </span>
              </div>
            ) : null}
          </div>
        ) : null}
      </Modal>

      <div className="cd-live" role="status" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}

export default Dashboard;
