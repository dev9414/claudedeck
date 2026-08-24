/**
 * Planner: where to place the first message of the day.
 *
 * The 5-hour window is anchored by that first message rather than by the clock,
 * so the anchor is the one property of it the user controls. This view exists to
 * make that controllable: it explains the mechanic to someone who has never
 * heard of it, takes the one input the app cannot infer (which hours actually
 * matter), and then shows the simulated day next to the same day with no plan at
 * all so the advice can be checked rather than trusted.
 *
 * Two kinds of doubt are surfaced separately, because they are separate: thin
 * history (`lowConfidence`) and hours nobody confirmed (`usingDefaultSchedule`).
 * A plan can suffer from either without the other, and collapsing them into one
 * "roughly" would hide which one the user can fix.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { FIVE_HOUR_MS } from '@shared/types';
import type {
  AnchorObservation,
  AnchorResult,
  PlannerConfig,
  SessionPlan,
  Settings,
  UsageProfile,
  Weekday,
  WorkSchedule,
} from '@shared/types';
import { DEFAULT_SCHEDULE, formatHHMM, resolveSchedule, validateSchedule } from '@core/schedule';
import { scoredPeakMinutes } from '@core/planner';
import { useDeckState } from '../hooks/useDeckState';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { ScheduleEditor } from '../components/ScheduleEditor';
import { Toggle } from '../components/Toggle';
import { ChartFrame, useNow } from '../charts/ChartFrame';
import { HourProfile, hourProfileTable } from '../charts/HourProfile';
import { WindowPlan, windowPlanHeight, windowPlanTable, type WindowPlanLane } from '../charts/WindowPlan';
import { formatClock } from '../charts/scales';
import './views.css';

const MIN_PER_HOUR = 60;
const DAY_MS = 24 * MIN_PER_HOUR * 60_000;

/**
 * How close a recommended anchor has to be before the instruction is "now"
 * rather than a clock time. The plan is recomputed on each poll, so `now` drifts
 * past its own anchor between polls -- and a time printed at a user for whom it
 * has passed is the whole reason this page was reported.
 */
const START_NOW_MS = 5 * 60_000;

/**
 * Fallbacks for a settings file written before the planner existed. They mirror
 * `DEFAULT_PLANNER` in the main process, which the renderer must not import —
 * nothing here may reach into main — and every write goes back through
 * `updateSettings`, which re-validates them anyway.
 */
const FALLBACK_PEAK_WEIGHT = 3;
const FALLBACK_REMIND_LEAD_MIN = 10;
const FALLBACK_ANCHOR_PROMPT = 'hi';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return typeof cause === 'string' ? cause : 'The main process did not answer.';
}

/**
 * The planner block, read defensively. Settings arrive from a JSON file on disk
 * and, during UI work, from the bridgeless stub — either can simply not have
 * this section yet, and a view that crashes on that is worse than one that
 * shows the defaults and says so.
 */
function readPlannerConfig(settings: Settings | undefined): PlannerConfig {
  const raw = settings?.planner as Partial<PlannerConfig> | undefined;
  const schedules =
    raw && Array.isArray(raw.schedules) && raw.schedules.length > 0
      ? raw.schedules
      : [DEFAULT_SCHEDULE];
  const weight = raw?.peakWeight;
  const lead = raw?.remindLeadMin;
  const prompt = raw?.anchorPrompt;
  return {
    enabled: raw?.enabled === true,
    schedules,
    configured: raw?.configured === true,
    peakWeight: typeof weight === 'number' && Number.isFinite(weight) ? weight : FALLBACK_PEAK_WEIGHT,
    remind: raw?.remind !== false,
    remindLeadMin:
      typeof lead === 'number' && Number.isFinite(lead) ? lead : FALLBACK_REMIND_LEAD_MIN,
    autoAnchor: raw?.autoAnchor === true,
    anchorPrompt:
      typeof prompt === 'string' && prompt.length > 0 ? prompt : FALLBACK_ANCHOR_PROMPT,
  };
}

/** Local midnight of the `YYYY-MM-DD` the plan was computed for. */
function dayStartFromKey(day: string): number | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  const year = parts?.[1];
  const month = parts?.[2];
  const date = parts?.[3];
  if (year === undefined || month === undefined || date === undefined) return null;
  const t = new Date(Number(year), Number(month) - 1, Number(date)).getTime();
  return Number.isFinite(t) ? t : null;
}

function localMidnight(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Minutes the way a person says them. */
function minutesText(value: number): string {
  const total = Math.max(0, Math.round(value));
  if (total < MIN_PER_HOUR) return `${total} minute${total === 1 ? '' : 's'}`;
  const hours = Math.floor(total / MIN_PER_HOUR);
  const rest = total % MIN_PER_HOUR;
  if (rest === 0) return `${hours} hour${hours === 1 ? '' : 's'}`;
  return `${hours}h ${rest}m`;
}

/** An observed 5-hour window: derived from a snapshot, so it needs checking. */
interface ObservedWindow {
  anchorAt: number;
  resetsAt: number;
  /** True while `now` is still inside it. */
  open: boolean;
}

/**
 * The observed anchor, if it is really an observation.
 *
 * It is derived as `resetsAt - 5h` from the last snapshot good enough to show,
 * which can be arbitrarily stale, and this page labels it with the word
 * "measured" -- the app's own word for "this really happened". Two derivations
 * do not earn it: a window that has not started yet, and one whose snapshot
 * predates the window it describes. Both are dropped, and the caller says
 * "nothing observed", which is true and checkable against the clock beside it.
 */
function observedWindow(entry: AnchorObservation | undefined, now: number): ObservedWindow | null {
  if (entry === undefined) return null;
  const { anchorAt, observedAt } = entry;
  if (!Number.isFinite(anchorAt) || !Number.isFinite(observedAt)) return null;
  if (anchorAt > now || observedAt < anchorAt) return null;
  const resetsAt = anchorAt + FIVE_HOUR_MS;
  return { anchorAt, resetsAt, open: now < resetsAt };
}

/** The index of the schedule that governs `weekday`, matching `resolveSchedule`. */
function applicableIndex(schedules: readonly WorkSchedule[], weekday: Weekday): number {
  return schedules.findIndex((entry) => Array.isArray(entry.days) && entry.days.includes(weekday));
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export function Planner() {
  const { state, loading, error, api, reload } = useDeckState();
  const now = useNow(60_000);

  const cfg = useMemo(() => readPlannerConfig(state?.settings), [state?.settings]);

  const [plan, setPlan] = useState<SessionPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planLoading, setPlanLoading] = useState(true);
  const [profile, setProfile] = useState<UsageProfile | null>(null);
  const [anchors, setAnchors] = useState<AnchorObservation[] | null>(null);
  const [nonce, setNonce] = useState(0);

  const [draft, setDraft] = useState<WorkSchedule | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const [confirming, setConfirming] = useState<number | null>(null);
  const [busySlot, setBusySlot] = useState<number | null>(null);
  const [anchorResults, setAnchorResults] = useState<Record<number, AnchorResult>>({});
  // Declared with the rest of the state: this sits above two early returns,
  // and a hook below them changes the hook count between renders.
  const [hoursOpen, setHoursOpen] = useState(false);

  // Every poll can move the plan, and so can any change to the hours it is
  // scored against; those two things are the whole trigger for a re-plan.
  const pollStamp = (state?.accounts ?? [])
    .map((account) => `${account.slot}:${account.usage?.fetchedAt ?? 0}`)
    .join(',');
  const scheduleStamp = JSON.stringify({
    schedules: cfg.schedules,
    weight: cfg.peakWeight,
    configured: cfg.configured,
  });

  useEffect(() => {
    let cancelled = false;
    setPlanLoading(true);
    setPlanError(null);
    void (async () => {
      try {
        const result = await api.getSessionPlan();
        if (cancelled) return;
        if (result.ok) setPlan(result.value);
        else {
          setPlan(null);
          setPlanError(result.error);
        }
      } catch (cause) {
        // A missing bridge method throws rather than rejecting, so this is not
        // only for transport errors.
        if (!cancelled) {
          setPlan(null);
          setPlanError(messageOf(cause));
        }
      } finally {
        if (!cancelled) setPlanLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, scheduleStamp, pollStamp, nonce]);

  // The profile and the observed anchors decorate the plan rather than carry
  // it, so they fail softly: the view says what is missing and stays up.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [profileResult, observed] = await Promise.all([
          api.getUsageProfile(),
          api.getAnchors(),
        ]);
        if (cancelled) return;
        setProfile(profileResult.ok ? profileResult.value : null);
        setAnchors(observed);
      } catch {
        if (!cancelled) {
          setProfile(null);
          setAnchors([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, pollStamp, nonce]);

  const recompute = useCallback(() => setNonce((value) => value + 1), []);

  const anchorNow = useCallback(
    async (slot: number) => {
      setBusySlot(slot);
      try {
        const result = await api.anchorNow(slot);
        setAnchorResults((current) => ({ ...current, [slot]: result }));
        // A successful anchor moves the observed window, which the plan and the
        // anchor markers both read.
        if (result.ok) setNonce((value) => value + 1);
      } catch (cause) {
        setAnchorResults((current) => ({
          ...current,
          [slot]: { ok: false, slot, error: messageOf(cause) },
        }));
      } finally {
        setBusySlot(null);
        setConfirming(null);
      }
    },
    [api],
  );

  // --- gates ---------------------------------------------------------------

  if (loading && !state) {
    return (
      <p className="cd-view-loading" role="status" aria-live="polite">
        <Icon name="refresh" className="cd-spin" />
        Reading your schedule and recorded usage…
      </p>
    );
  }

  if (!state) {
    return (
      <div className="cd-view">
        <EmptyState
          icon="alert-octagon"
          tone="warning"
          title="The planner has no state to read"
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

  const dayStartMs = (plan ? dayStartFromKey(plan.day) : null) ?? localMidnight(now);
  const weekday = new Date(dayStartMs).getDay() as Weekday;
  // `governing` is the schedule the plan was actually scored against, so it is
  // what the charts draw. An unsaved draft only feeds the editor: banding the
  // plot with hours the simulation never saw would be a lie about the plan.
  const governing =
    plan?.schedule ?? resolveSchedule(cfg.schedules, weekday) ?? cfg.schedules[0] ?? DEFAULT_SCHEDULE;
  const schedule = draft ?? governing;
  const problems = validateSchedule(schedule);
  const dirty = draft !== null;

  // How many local hours the profile has actually seen. Zero means the plan was
  // simulated from a placeholder load, and its minute figures are arithmetic
  // about an invented day rather than a finding about this one.
  const observedHours = (plan?.profile.samples ?? []).filter((count) => count > 0).length;

  const anchorBySlot = new Map((anchors ?? []).map((entry) => [entry.slot, entry]));
  const observedFor = (slot: number): ObservedWindow | null =>
    observedWindow(anchorBySlot.get(slot), now);

  /**
   * Which day the plan is for, measured against the day the user is living in.
   * `planDay` hands back tomorrow once today's anchors have all passed -- that
   * is the only answer left that can be acted on -- so every clock time on this
   * page has to say which day it belongs to.
   */
  const dayOffset = Math.round((dayStartMs - localMidnight(now)) / DAY_MS);
  /** For a sentence: "no start time beats any other <dayWord>". */
  const dayWord =
    dayOffset === 0 ? 'today' : dayOffset === 1 ? 'tomorrow' : `on ${plan?.day ?? 'the day planned'}`;
  /** For a clock time that needs qualifying: "07:50 (tomorrow)". */
  const dayTag =
    dayOffset === 0 ? '' : dayOffset === 1 ? ' (tomorrow)' : ` (${plan?.day ?? 'another day'})`;

  /**
   * The one-line answer, chosen so the page opens with what to do rather than
   * with why it matters. Order is deliberate: a missing input beats a missing
   * measurement beats a real recommendation, because that is the order in which
   * the user can act on them.
   */
  const headline = ((): { text: string; sub?: string } => {
    if (planLoading && !plan) return { text: 'Working out today’s plan…' };
    if (!plan) return { text: 'No plan yet.', sub: 'Set your hours and ClaudeDeck will work one out.' };
    if (!cfg.configured) {
      return {
        text: 'Tell ClaudeDeck when your day matters.',
        sub: 'It is planning against default hours right now, so treat the times below as a placeholder.',
      };
    }
    if (observedHours === 0) {
      return {
        text: 'Nothing to recommend yet — no usage recorded.',
        sub: 'Leave ClaudeDeck running through a working day and this becomes a real answer.',
      };
    }
    const first = plan.accounts[0];
    if (!first) return { text: 'No account to plan for.', sub: 'Add an account and come back.' };
    // Already anchored. The window's start was fixed by a message that has been
    // sent, and no plan can move it, so naming a start time here would be
    // naming something the user cannot do.
    const openWindow = dayOffset === 0 ? observedFor(first.slot) : null;
    if (openWindow !== null && openWindow.open) {
      return {
        text: `Your window is already open until ${formatClock(openWindow.resetsAt)}.`,
        sub: `Your first message at ${formatClock(openWindow.anchorAt)} set it, and nothing can move it now — the times below apply to your next fresh window.`,
      };
    }
    if (plan.peakMinutesSaved <= 0) {
      return {
        text: 'Just start when you start.',
        sub: `No start time beats any other ${dayWord}, so there is nothing to plan around.`,
      };
    }
    const anchorAt = first.outcome.anchorAt;
    const reset = first.outcome.windows[0]?.end ?? anchorAt + FIVE_HOUR_MS;
    // `peakMinutesSaved` is a delta against starting when work starts, not the
    // peak the plan protects -- the two differ by hours, and the page used to
    // print the smaller one as though it were the larger.
    const peakMin = scoredPeakMinutes(plan.schedule, dayStartMs);
    const protectedMin = peakMin - first.outcome.blockedPeakMin;
    const saved = minutesText(plan.peakMinutesSaved);
    const startOfWork = formatHHMM(governing.work.start);
    return {
      text:
        dayOffset === 0
          ? anchorAt - now <= START_NOW_MS
            ? 'Start now — nothing later today beats it.'
            : `Send your first message at ${formatClock(anchorAt)}.`
          : `${dayOffset === 1 ? 'Tomorrow' : plan.day}: send your first message at ${formatClock(anchorAt)}.`,
      sub:
        peakMin <= 0 || protectedMin <= 0
          ? `That puts a reset at ${formatClock(reset)}, leaving ${saved} more of your peak unblocked than starting at ${startOfWork} would.`
          : protectedMin >= peakMin
            ? `That puts a reset at ${formatClock(reset)}, keeping all ${minutesText(peakMin)} of your peak unblocked — ${saved} more than starting at ${startOfWork} would.`
            : `That puts a reset at ${formatClock(reset)}, keeping ${minutesText(protectedMin)} of the ${minutesText(peakMin)} in your peak unblocked — ${saved} more than starting at ${startOfWork} would.`,
    };
  })();

  /** The time reminders would fire for, when there is one left to remember. */
  const anchorToRemember = ((): string | null => {
    const first = plan?.accounts[0];
    if (plan === null || first === undefined || plan.peakMinutesSaved <= 0) return null;
    const openWindow = dayOffset === 0 ? observedFor(first.slot) : null;
    if (openWindow !== null && openWindow.open) return null;
    return `${formatClock(first.outcome.anchorAt)}${dayTag}`;
  })();

  const lanes: WindowPlanLane[] = (plan?.accounts ?? []).map((account) => {
    const observed = observedFor(account.slot);
    return {
      slot: account.slot,
      label: account.alias ?? account.email,
      sub: `slot ${account.slot}`,
      outcome: account.outcome,
      // Only a window that has actually opened. The ring is drawn as an
      // observation, and one to the right of the chart's own "now" line is a
      // claim about the future.
      ...(observed === null ? {} : { observedAnchorAt: observed.anchorAt }),
    };
  });

  const chartProfile = profile ?? plan?.profile ?? null;
  const dayContainsNow = now >= dayStartMs && now < dayStartMs + 24 * MIN_PER_HOUR * 60_000;

  const saveSchedule = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const index = applicableIndex(cfg.schedules, weekday);
      const schedules =
        index >= 0
          ? cfg.schedules.map((entry, position) => (position === index ? schedule : entry))
          : [...cfg.schedules, schedule];
      // `configured` is the load-bearing flag: it is what lets every surface
      // stop calling these hours a guess.
      const result = await api.updateSettings({
        planner: { ...cfg, schedules, configured: true },
      });
      if (!result.ok) {
        setSaveError(result.error);
        return;
      }
      setDraft(null);
      setSavedAt(Date.now());
      recompute();
    } catch (cause) {
      setSaveError(messageOf(cause));
    } finally {
      setSaving(false);
    }
  };

  const patchPlanner = async (patch: Partial<typeof cfg>) => {
    setSaveError(null);
    const result = await api.updateSettings({ planner: { ...cfg, ...patch } });
    if (!result.ok) setSaveError(result.error);
  };

  const setEnabled = (next: boolean) => patchPlanner({ enabled: next });

  return (
    <div className="cd-view">
      <header className="cd-view-head">
        <h1 className="cd-h1">Planner</h1>
        <p className="cd-view-sub">
          Where to put the first message of the day, so a reset lands where you need one.
        </p>
        <span className="cd-spacer" />
        {cfg.enabled ? null : (
          <Badge tone="warning" icon="pause" title="The plan is still computed; reminders are not sent.">
            Planner off
          </Badge>
        )}
        {plan ? (
          <Badge tone="neutral" icon="clock">
            {dayOffset === 0
              ? 'Plan for today'
              : dayOffset === 1
                ? 'Plan for tomorrow'
                : `Plan for ${plan.day}`}
          </Badge>
        ) : null}
        {state.demoMode ? <Badge tone="info">Demo data</Badge> : null}
      </header>

      {/* The answer first. This page used to open with two paragraphs of theory
          and bury the hours editor at the bottom, which is backwards: the one
          thing only the user can supply was the hardest thing to find. */}
      <section className="cd-answer" aria-labelledby="cd-pl-answer">
        <h2 className="cd-sr-only" id="cd-pl-answer">
          Your next start time
        </h2>
        <p className="cd-answer-line">{headline.text}</p>
        {headline.sub ? <p className="cd-answer-sub">{headline.sub}</p> : null}
        <div className="cd-answer-actions">
          {/* `description` renders under the label; `hint` is only a title
              attribute, so the sentence explaining the switch reached nobody. */}
          <Toggle
            checked={cfg.enabled}
            onChange={(next) => void setEnabled(next)}
            label={cfg.enabled ? 'Planner on' : 'Planner off'}
            description={
              cfg.enabled
                ? 'Reminders arrive before a recommended start time.'
                : 'The plan below is still computed, but no reminders are sent.'
            }
          />
          {!cfg.configured ? (
            <Button variant="primary" icon="clock" onClick={() => setHoursOpen(true)}>
              Set my hours
            </Button>
          ) : (
            <Button variant="secondary" icon="clock" onClick={() => setHoursOpen(true)}>
              {`${formatHHMM(governing.work.start)}–${formatHHMM(governing.work.end)}, peak ${formatHHMM(governing.peak.start)}–${formatHHMM(governing.peak.end)}`}
            </Button>
          )}
          <details className="cd-explainer">
            <summary>How this works</summary>
            <p>
              Your 5-hour window starts at your <strong>first message</strong>, not on the clock.
              Start at 09:00 and resets land 14:00 and 19:00; start at 11:00 and they land 16:00 and
              21:00.
            </p>
            <p>
              So if a busy stretch would drain a window part-way through, starting earlier makes the
              reset arrive <em>during</em> it instead of just after. ClaudeDeck simulates your day
              from recorded usage and picks the start time that blocks you least, weighting your
              peak hours heaviest.
            </p>
          </details>
        </div>
        {cfg.enabled ? null : (
          <p className="cd-answer-sub" role="note">
            <Icon name="pause" size={12} />{' '}
            {anchorToRemember === null
              ? 'Reminders are off, so nothing will tell you when to start.'
              : `Reminders are off — you will have to remember ${anchorToRemember} yourself.`}
          </p>
        )}
      </section>

      {error ? (
        <div className="cd-note cd-note--error" role="alert">
          <Icon name="alert-octagon" />
          <span className="cd-note-body">
            <span className="cd-note-title">State update failed</span>
            <span>{error} What you see below came from the last data ClaudeDeck received.</span>
          </span>
        </div>
      ) : null}

      {plan?.lowConfidence ? (
        <div className="cd-note cd-note--warning" role="note">
          <Icon name="alert-triangle" />
          <span className="cd-note-body">
            <span className="cd-note-title">This plan is a guess, not a finding</span>
            <span>
              ClaudeDeck has not yet watched you work for long enough to know your day. Treat the
              times below as a starting point rather than advice — the plan sharpens on its own as
              more usage is recorded, and the hourly profile lower down shows exactly which hours
              are still thin.
            </span>
          </span>
        </div>
      ) : null}

      {plan?.usingDefaultSchedule ? (
        <div className="cd-note" role="note">
          <Icon name="clock" />
          <span className="cd-note-body">
            <span className="cd-note-title">Running on hours you have not confirmed</span>
            <span>
              {`These are ClaudeDeck's default hours (${formatHHMM(governing.work.start)} to ${formatHHMM(
                governing.work.end,
              )}), not yours. Set your own below and the plan is scored against a day that actually exists.`}
            </span>
          </span>
        </div>
      ) : null}

      {planError ? (
        <div className="cd-note cd-note--error" role="alert">
          <Icon name="alert-octagon" />
          <span className="cd-note-body">
            <span className="cd-note-title">The plan could not be computed</span>
            <span>
              {planError}
              {cfg.enabled ? '' : ' The planner is currently switched off, which may be why.'}
            </span>
          </span>
          <span className="cd-spacer" />
          <Button size="sm" icon="refresh" onClick={recompute}>
            Try again
          </Button>
        </div>
      ) : null}

      {planLoading && !plan ? (
        <p className="cd-view-loading" role="status" aria-live="polite">
          <Icon name="refresh" className="cd-spin" />
          Simulating the day against your recorded usage…
        </p>
      ) : null}

      {plan ? (
        <ChartFrame
          title="The day, window by window"
          subtitle="One lane per account. Boundaries are resets; the faint lane is the same day unplanned."
          height={windowPlanHeight(lanes.length, true)}
          tableRows={windowPlanTable({ lanes, baseline: plan.baseline }) ?? undefined}
        >
          <WindowPlan
            dayStartMs={dayStartMs}
            work={governing.work}
            peak={governing.peak}
            lanes={lanes}
            baseline={plan.baseline}
            now={dayContainsNow ? now : undefined}
          />
        </ChartFrame>
      ) : null}

      <div className="cd-tl-split">
        <div className="cd-stack">
          {plan && plan.accounts.length === 0 ? (
            <EmptyState
              icon="users"
              title="No account to anchor"
              description="The planner places a first message per account. Add one in Accounts and this fills in."
            />
          ) : null}

          {plan && plan.accounts.length > 0 ? (
            <section className="cd-card" aria-labelledby="cd-pl-rec">
              <div className="cd-card-head">
                <Icon name="bolt" />
                <h2 className="cd-h2" id="cd-pl-rec">
                  Recommended start times
                </h2>
                <span className="cd-spacer" />
                <Button size="sm" icon="refresh" onClick={recompute} busy={planLoading}>
                  Recompute
                </Button>
              </div>

              {observedHours === 0 ? (
                <p className="cd-secondary">
                  There is no recorded usage to simulate against yet, so ClaudeDeck is not putting a
                  number on this. It records your quota every few minutes while it runs — leave it
                  open for a working day and this becomes a real recommendation rather than
                  arithmetic about a placeholder.
                </p>
              ) : plan.peakMinutesSaved === 0 ? (
                <p className="cd-secondary">
                  {`Anchoring would not help ${dayWord}.`} On the simulated day, no start time keeps more of
                  your peak hours unblocked than simply beginning work at{' '}
                  {formatHHMM(governing.work.start)} would, so there is nothing to gain by waiting or
                  by starting early.
                </p>
              ) : (
                <p className="cd-muted">
                  {`Compared with starting at ${formatHHMM(governing.work.start)}. Estimated, not measured.`}
                </p>
              )}

              {plan.accounts.map((account) => {
                const first = account.outcome.windows[0];
                const reset = first ? first.end : account.outcome.anchorAt + FIVE_HOUR_MS;
                const observed = observedFor(account.slot);
                const result = anchorResults[account.slot];
                const confirmingThis = confirming === account.slot;
                return (
                  <div className="cd-stack" key={account.slot}>
                    <hr className="cd-divider" />
                    <div className="cd-row">
                      <strong>{account.alias ?? account.email}</strong>
                      <Badge tone="neutral" icon={null}>{`slot ${account.slot}`}</Badge>
                    </div>
                    <ul className="cd-forecast-list">
                      <li>
                        <Icon name="clock" size={12} />
                        <strong>{`Send the first message at ${formatClock(
                          account.outcome.anchorAt,
                        )}${dayTag}`}</strong>
                        <span>estimate</span>
                      </li>
                      <li>
                        <Icon name="refresh" size={12} />
                        <strong>{`That window resets at ${formatClock(reset)}`}</strong>
                        <span>5 hours after the anchor</span>
                      </li>
                      <li>
                        <Icon name={observed === null ? 'minus' : 'check'} size={12} />
                        <strong>
                          {observed === null
                            ? 'No window observed open for this account'
                            : observed.open
                              ? `Its window opened at ${formatClock(observed.anchorAt)} and resets at ${formatClock(observed.resetsAt)}`
                              : `Its last window opened at ${formatClock(observed.anchorAt)} and has since reset`}
                        </strong>
                        <span>{observed === null ? 'nothing to measure yet' : 'measured'}</span>
                      </li>
                    </ul>
                    <p className="cd-secondary">{account.note}</p>

                    <div className="cd-row">
                      {confirmingThis ? (
                        <>
                          <Button
                            variant="primary"
                            icon="bolt"
                            busy={busySlot === account.slot}
                            onClick={() => void anchorNow(account.slot)}
                          >
                            Send it now
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() => setConfirming(null)}
                            disabled={busySlot === account.slot}
                          >
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <Button
                          icon="bolt"
                          onClick={() => setConfirming(account.slot)}
                          disabled={busySlot !== null}
                        >
                          Anchor now
                        </Button>
                      )}
                    </div>
                    <p className="cd-muted">
                      {`Anchor now runs Claude Code on this account with the prompt "${cfg.anchorPrompt}". That is a real message: it opens the 5-hour window immediately and spends a small amount of this account's own quota. Nothing is sent until you click.`}
                    </p>

                    {result?.ok ? (
                      <p className="cd-secondary" role="status">
                        <Icon name="check" size={12} />{' '}
                        {`Window opened${
                          result.anchoredAt === undefined
                            ? ''
                            : ` at ${formatClock(result.anchoredAt)}`
                        }${
                          result.resetsAt === undefined
                            ? ''
                            : `, resetting at ${formatClock(result.resetsAt)}`
                        }.`}
                      </p>
                    ) : null}
                    {result && !result.ok ? (
                      <div className="cd-note cd-note--error" role="alert">
                        <Icon name="alert-octagon" />
                        <span className="cd-note-body">
                          <span className="cd-note-title">Anchoring did not run</span>
                          <span>
                            {result.error ?? 'The Claude Code CLI did not report why it failed.'}
                          </span>
                        </span>
                      </div>
                    ) : null}
                  </div>
                );
              })}

              {plan.rationale.length > 0 ? (
                <>
                  <hr className="cd-divider" />
                  <h3 className="cd-h3">Why this plan</h3>
                  {plan.rationale.map((line, index) => (
                    <p className="cd-secondary" key={`${index}-${line.slice(0, 24)}`}>
                      {line}
                    </p>
                  ))}
                </>
              ) : null}
            </section>
          ) : null}
        </div>

        <div className="cd-stack">
          {chartProfile ? (
            <ChartFrame
              title="What your day usually costs"
              subtitle="Utilization gained per local hour, learned from recorded usage. The band is your declared peak."
              height={220}
              tableRows={hourProfileTable(chartProfile, governing.peak) ?? undefined}
            >
              <HourProfile profile={chartProfile} peak={governing.peak} height={220} />
            </ChartFrame>
          ) : anchors === null ? (
            <p className="cd-view-loading" role="status" aria-live="polite">
              <Icon name="refresh" className="cd-spin" />
              Loading the hourly profile…
            </p>
          ) : (
            <EmptyState
              icon="activity"
              title="No hourly profile yet"
              description="ClaudeDeck learns this from recorded usage. Keep it polling and the curve fills in."
            />
          )}

          {/* These were previously described in a sentence and settable nowhere,
              so reminders could not be turned off and auto-anchoring — the whole
              opt-in — could not be turned on at all. */}
          <section className="cd-card" aria-labelledby="cd-pl-switch">
            <div className="cd-card-head">
              <Icon name="settings" />
              <h2 className="cd-h2" id="cd-pl-switch">
                Reminders and anchoring
              </h2>
            </div>

            <Toggle
              checked={cfg.remind}
              disabled={!cfg.enabled}
              onChange={(next) => void patchPlanner({ remind: next })}
              label="Remind me before a start time"
              description={`A desktop notification shortly before the recommended first message.${
                cfg.enabled ? '' : ' The planner is off, so none is sent.'
              }`}
            />

            <label className="cd-field cd-field--inline">
              <span className="cd-field-label">Minutes of warning</span>
              <input
                type="number"
                className="cd-input cd-input--num"
                min={0}
                max={120}
                step={5}
                value={cfg.remindLeadMin}
                disabled={!cfg.enabled || !cfg.remind}
                onChange={(e) => {
                  const next = Number(e.target.value);
                  // An empty field parses to NaN mid-edit; ignore it rather than
                  // writing a broken value on every keystroke.
                  if (Number.isFinite(next)) void patchPlanner({ remindLeadMin: next });
                }}
              />
            </label>

            <Toggle
              checked={cfg.autoAnchor}
              disabled={!cfg.enabled || state.settings.safeMode}
              onChange={(next) => void patchPlanner({ autoAnchor: next })}
              label="Anchor automatically"
              description={`Sends "${cfg.anchorPrompt}" through Claude Code at the recommended time, without asking. That is a real message and spends a little of the account's own quota — off unless you turn it on.${
                state.settings.safeMode
                  ? ' Safe mode is on, so nothing would be sent.'
                  : cfg.enabled
                    ? ''
                    : ' The planner is off, so nothing is sent.'
              }`}
            />
          </section>
        </div>
      </div>

      {/* The hours live in a dialog reachable from the top of the page, not in a
          card below three charts. It is the only input the planner cannot derive,
          so it should never take scrolling to find. */}
      <Modal
        open={hoursOpen}
        onClose={() => setHoursOpen(false)}
        title="Your hours"
        description="ClaudeDeck learns when you burn quota. Only you know when it matters."
        size="md"
        footer={
          <>
            {dirty ? (
              <Button variant="ghost" onClick={() => setDraft(null)} disabled={saving}>
                Discard changes
              </Button>
            ) : null}
            <Button variant="ghost" onClick={() => setHoursOpen(false)} disabled={saving}>
              Close
            </Button>
            <Button
              variant="primary"
              icon="check"
              busy={saving}
              disabled={!dirty || problems.length > 0 || state.settings.safeMode}
              onClick={() => void saveSchedule()}
            >
              Save these hours
            </Button>
          </>
        }
      >
        {cfg.configured ? null : (
          <div className="cd-note cd-note--info">
            <Icon name="info" />
            <span className="cd-note-body">
              <span className="cd-note-title">These are defaults, not your hours</span>
              <span>Change them and press save, and the plan stops calling itself a guess.</span>
            </span>
          </div>
        )}

        <ScheduleEditor value={schedule} onChange={setDraft} disabled={saving} showLabel={false} />

        {state.settings.safeMode ? (
          <p className="cd-muted">
            Safe mode is on, so ClaudeDeck will refuse to write these hours. Turn it off in Settings
            first.
          </p>
        ) : null}

        {saveError ? (
          <div className="cd-note cd-note--error" role="alert">
            <Icon name="alert-octagon" />
            <span className="cd-note-body">
              <span className="cd-note-title">Your hours were not saved</span>
              <span>{saveError}</span>
            </span>
          </div>
        ) : null}
      </Modal>

    </div>
  );
}

export default Planner;
