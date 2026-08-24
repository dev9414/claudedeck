/**
 * Automation — the auto-switch console.
 *
 * Everything about the rotation engine lives here: whether it is running, the
 * rule it follows, the numbers that gate it, and a log of what it actually did.
 * Controls write straight through `updateSettings`, so the screen and the
 * engine never hold two different versions of the configuration.
 *
 * Notes, inputs, and the rest of the shared furniture come from `views.css`;
 * the block below only styles chrome that exists nowhere else — the strategy
 * cards, the threshold range, the model chips, and the log rows.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  Account,
  AutoSwitchConfig,
  AutoSwitchEvent,
  AutoSwitchEventKind,
  DeckState,
  SwitchResult,
  SwitchStrategy,
  UsageWindow,
} from '@shared/types';
import type { DeckApi } from '@shared/ipc';
import { useDeckState } from '../hooks/useDeckState';
import { Badge, type BadgeTone } from '../components/Badge';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { Icon, type IconName } from '../components/Icon';
import { Toggle } from '../components/Toggle';
import { UsageMeter } from '../charts/UsageMeter';
import './views.css';

const VIEW_CSS = `
.cda-hero { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-4); }
.cda-hero-icon {
  display: grid; place-items: center; width: 44px; height: 44px;
  border: 1px solid var(--border); border-radius: var(--radius-lg);
  background: var(--surface-2); color: var(--text-secondary);
}
.cda-hero[data-running="true"] .cda-hero-icon {
  border-color: color-mix(in srgb, var(--status-good) 45%, transparent);
  background: color-mix(in srgb, var(--status-good) 10%, transparent);
  color: var(--status-good-text);
}
.cda-hero-text { display: flex; flex-direction: column; gap: 2px; min-width: 240px; }
.cda-hero-title { font-size: 17px; font-weight: 600; letter-spacing: -0.01em; }

.cda-opts { display: grid; gap: var(--space-2); grid-template-columns: repeat(auto-fit, minmax(268px, 1fr)); border: 0; margin: 0; padding: 0; }
.cda-opt {
  display: flex; gap: var(--space-3); padding: var(--space-3);
  border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--surface-1); cursor: pointer;
}
.cda-opt:hover { border-color: var(--border-strong); }
.cda-opt[data-selected="true"] { border-color: var(--accent); background: var(--accent-wash); }
.cda-opt input { margin: 3px 0 0; accent-color: var(--accent); }
.cda-opt-title { display: block; font-size: 13px; font-weight: 600; }
.cda-opt-desc { display: block; margin-top: 2px; font-size: 12px; line-height: 1.45; color: var(--text-secondary); }

.cda-fields { display: grid; gap: var(--space-4); grid-template-columns: repeat(auto-fit, minmax(212px, 1fr)); }
.cda-field { display: flex; flex-direction: column; gap: var(--space-1); }
.cda-field-label { font-size: 12px; font-weight: 600; color: var(--text-secondary); }
.cda-field-help { font-size: 12px; line-height: 1.45; color: var(--text-muted); }
.cda-field .cd-input { font-variant-numeric: tabular-nums; }

.cda-range-row { display: flex; align-items: center; gap: var(--space-3); }
.cda-range { flex: 1 1 auto; min-width: 160px; accent-color: var(--accent); }
.cda-range-value { min-width: 68px; text-align: right; font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }

.cda-preview {
  display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-3);
  border: 1px dashed var(--border-strong); border-radius: var(--radius); background: var(--surface-2);
}
.cda-preview p { font-size: 13px; line-height: 1.5; }

.cda-chips { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.cda-chip {
  display: inline-flex; align-items: center; gap: var(--space-2);
  padding: 5px var(--space-3); border: 1px solid var(--border); border-radius: 999px;
  background: var(--surface-1); font-size: 12px; cursor: pointer;
}
.cda-chip:hover { border-color: var(--border-strong); }
.cda-chip[data-selected="true"] { border-color: var(--accent); background: var(--accent-wash); }
.cda-chip input { accent-color: var(--accent); }

.cda-log { display: flex; flex-direction: column; max-height: 384px; overflow: auto; }
.cda-log-row {
  display: grid; grid-template-columns: 142px 92px minmax(0, 1fr);
  gap: var(--space-3); align-items: baseline;
  padding: var(--space-2) var(--space-1); border-bottom: 1px solid var(--grid);
}
.cda-log-row:last-child { border-bottom: 0; }
.cda-log-time { font-family: var(--font-mono); font-size: 11px; font-variant-numeric: tabular-nums; color: var(--text-muted); }
.cda-log-msg { font-size: 13px; overflow-wrap: anywhere; }
.cda-log-slot { color: var(--text-muted); }
`;

// ---------------------------------------------------------------------------
// Presentation tables
// ---------------------------------------------------------------------------

interface StrategyOption {
  id: SwitchStrategy;
  title: string;
  desc: string;
}

/** Plain English, not the enum name — the user is choosing a behaviour. */
const STRATEGIES: readonly StrategyOption[] = [
  {
    id: 'next',
    title: 'Next in order',
    desc: 'Hands over to the following slot whatever its usage. Predictable, but it can land somewhere with less headroom than you just left.',
  },
  {
    id: 'best',
    title: 'Most headroom',
    desc: 'Picks whichever enabled account currently has the most quota left on its tightest window.',
  },
  {
    id: 'next-available',
    title: 'Next one with quota left',
    desc: 'Walks forward through the slots and takes the first account that is not already exhausted.',
  },
  {
    id: 'consume-first',
    title: 'Drain this one first',
    desc: 'Stays put until the active account is genuinely spent, so later accounts stay untouched for as long as possible.',
  },
];

const EVENT_META: Record<AutoSwitchEventKind, { icon: IconName; label: string; tone: BadgeTone }> = {
  poll: { icon: 'refresh', label: 'Poll', tone: 'neutral' },
  switch: { icon: 'bolt', label: 'Switched', tone: 'good' },
  'no-switch': { icon: 'minus', label: 'No change', tone: 'neutral' },
  blocked: { icon: 'ban', label: 'Blocked', tone: 'warning' },
  'account-quarantined': { icon: 'ban', label: 'Quarantined', tone: 'serious' },
  'all-exhausted': { icon: 'alert-octagon', label: 'All exhausted', tone: 'critical' },
  error: { icon: 'alert-triangle', label: 'Error', tone: 'critical' },
};

const UNKNOWN_EVENT: { icon: IconName; tone: BadgeTone } = { icon: 'info', tone: 'neutral' };

/** The log is a scrollback, not an archive — durable history is the store's job. */
const LOG_CAP = 200;

const TIME_FMT = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function windowsOf(account: Account | undefined): UsageWindow[] {
  const usage = account?.usage ?? account?.lastGoodUsage;
  if (!usage) return [];
  const list: UsageWindow[] = [];
  if (usage.fiveHour) list.push(usage.fiveHour);
  if (usage.sevenDay) list.push(usage.sevenDay);
  list.push(...usage.scoped);
  return list;
}

/** The window closest to its ceiling — the one that actually gates the account. */
function bindingWindow(account: Account | undefined): UsageWindow | null {
  return windowsOf(account).reduce<UsageWindow | null>(
    (worst, w) => (worst === null || w.pct > worst.pct ? w : worst),
    null,
  );
}

function describeAccount(account: Account | undefined, slot?: number, email?: string): string {
  if (account) return `slot ${account.slot} — ${account.alias ?? account.email}`;
  if (slot !== undefined) return `slot ${slot}${email ? ` — ${email}` : ''}`;
  return 'an unknown account';
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function eventKey(event: AutoSwitchEvent): string {
  return `${event.ts}|${event.kind}|${event.slot ?? ''}|${event.message}`;
}

/** The shell routes on the hash, so a view can hand over without prop drilling. */
function goToAccounts(): void {
  if (typeof window !== 'undefined') window.location.hash = '#/accounts';
}

// ---------------------------------------------------------------------------
// Field primitives
// ---------------------------------------------------------------------------

interface NumberFieldProps {
  label: string;
  help: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit: string;
  onCommit: (next: number) => void;
}

/**
 * Commits a clamped, finite value only once the user has stopped typing.
 * Writing on every keystroke would persist "1" on the way to "120".
 */
function NumberField({ label, help, value, min, max, step = 1, unit, onCommit }: NumberFieldProps) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const next = clamp(Math.round(parsed), min, max);
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };

  return (
    <label className="cda-field">
      <span className="cda-field-label">
        {label} <span className="cd-muted">({unit})</span>
      </span>
      <input
        className="cd-input"
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={step}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
      />
      <span className="cda-field-help">{help}</span>
    </label>
  );
}

/** The shared `.cd-note` callout: icon plus words, tint only reinforcing. */
function Note({ tone, icon, children }: { tone: 'info' | 'warning' | 'critical'; icon: IconName; children: ReactNode }) {
  const variant = tone === 'critical' ? ' cd-note--error' : tone === 'warning' ? ' cd-note--warning' : '';
  const role = tone === 'info' ? 'Note' : tone === 'warning' ? 'Warning' : 'Error';
  return (
    <div className={`cd-note${variant}`}>
      <Icon name={icon} title={role} />
      <div className="cd-note-body">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export default function Automation() {
  const deck = useDeckState();
  if (!deck.state) {
    return (
      <div className="cd-view">
        <p className="cd-view-loading">
          <Icon name="refresh" className="cd-spin" />
          Reading the automation settings…
        </p>
      </div>
    );
  }
  return <Console state={deck.state} api={deck.api} />;
}

function Console({ state, api }: { state: DeckState; api: DeckApi }) {
  const cfg = state.settings.autoswitch;
  const running = state.autoSwitchRunning;
  const safeMode = state.settings.safeMode;
  const accounts = state.accounts;

  const [pending, setPending] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [startBlocked, setStartBlocked] = useState(false);
  const [threshold, setThreshold] = useState(cfg.threshold);
  const [preview, setPreview] = useState<SwitchResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [liveEvents, setLiveEvents] = useState<AutoSwitchEvent[]>([]);

  // The slider is local while dragging so it tracks the pointer, then it is
  // reconciled against whatever the main process actually stored.
  useEffect(() => {
    setThreshold(cfg.threshold);
  }, [cfg.threshold]);

  const patchAuto = useCallback(
    async (patch: Partial<AutoSwitchConfig>) => {
      const result = await api.updateSettings({ autoswitch: { ...cfg, ...patch } });
      setSaveError(result.ok ? null : result.error);
    },
    [api, cfg],
  );

  const commitThreshold = useCallback(() => {
    if (threshold === cfg.threshold) return;
    void patchAuto({ threshold });
  }, [threshold, cfg.threshold, patchAuto]);

  // --- engine on/off -------------------------------------------------------

  const toggleEngine = useCallback(async () => {
    setPending('engine');
    setSaveError(null);
    setStartError(null);
    setStartBlocked(false);
    try {
      if (running) {
        const stopped = await api.stopAutoSwitch();
        if (!stopped.ok) {
          setSaveError(stopped.error);
          return;
        }
        await patchAuto({ enabled: false });
      } else {
        // Start first, persist second. `enabled: true` on disk behind a refused
        // start is what makes the whole app believe rotation is armed and keep
        // sending the user back to a button that fails again.
        const started = await api.startAutoSwitch();
        if (!started.ok) {
          if (started.code === 'too-few-accounts') {
            setStartBlocked(true);
            // Keep the stored setting honest about what is actually running.
            if (cfg.enabled) await patchAuto({ enabled: false });
            return;
          }
          setStartError(started.error);
          return;
        }
        await patchAuto({ enabled: true });
      }
    } finally {
      setPending(null);
    }
  }, [api, cfg.enabled, patchAuto, running]);

  // --- live preview --------------------------------------------------------

  const activeAccount = useMemo(
    () => accounts.find((a) => a.active) ?? accounts.find((a) => a.slot === state.activeSlot),
    [accounts, state.activeSlot],
  );

  // Re-ask the engine only when something it reads has actually moved.
  const accountsKey = useMemo(
    () =>
      accounts
        .map((a) => `${a.slot}:${a.active ? 1 : 0}:${a.disabled ? 1 : 0}:${a.quarantinedAt ? 1 : 0}:${a.usageStatus}`)
        .join('|'),
    [accounts],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await api.previewSwitch({ strategy: cfg.strategy, dryRun: true, reason: 'threshold' });
        if (cancelled) return;
        setPreview(result);
        setPreviewError(null);
      } catch (cause) {
        if (cancelled) return;
        setPreview(null);
        setPreviewError(cause instanceof Error ? cause.message : 'the main process did not answer');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, cfg.strategy, accountsKey]);

  const previewTarget = useMemo(
    () => (preview?.to ? accounts.find((a) => a.slot === preview.to?.slot) : undefined),
    [accounts, preview],
  );
  const previewWindows = windowsOf(previewTarget);

  const activeBinding = bindingWindow(activeAccount);
  const activePeak = activeBinding ? round1(activeBinding.pct) : null;

  // --- per-model windows ---------------------------------------------------

  const modelOptions = useMemo(() => {
    const found = new Map<string, string>();
    for (const account of accounts) {
      const usage = account.usage ?? account.lastGoodUsage;
      for (const w of usage?.scoped ?? []) found.set(w.key, w.label);
    }
    // Keep selected-but-unreported windows visible so they can be unselected.
    for (const key of cfg.models) if (!found.has(key)) found.set(key, `${key} (not reported right now)`);
    return [...found.entries()].map(([key, label]) => ({ key, label }));
  }, [accounts, cfg.models]);

  const toggleModel = (key: string) => {
    const next = cfg.models.includes(key) ? cfg.models.filter((m) => m !== key) : [...cfg.models, key];
    void patchAuto({ models: next });
  };

  // --- event log -----------------------------------------------------------

  useEffect(() => api.onAutoSwitchEvent((event) => {
    setLiveEvents((prev) => [event, ...prev].slice(0, LOG_CAP));
  }), [api]);

  const events = useMemo(() => {
    // The pushed stream and the snapshot in `lastEvents` overlap; identity is
    // the tuple, because the engine does not hand out event ids.
    const seen = new Set<string>();
    const merged: AutoSwitchEvent[] = [];
    for (const event of [...liveEvents, ...state.lastEvents]) {
      const key = eventKey(event);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(event);
    }
    return merged.sort((a, b) => b.ts - a.ts).slice(0, LOG_CAP);
  }, [liveEvents, state.lastEvents]);

  // --- copy ----------------------------------------------------------------

  const strategyTitle = STRATEGIES.find((s) => s.id === cfg.strategy)?.title ?? cfg.strategy;

  const heroLine = running
    ? `Polling every ${cfg.pollIntervalSec}s and moving off the active account at ${cfg.threshold}%, using “${strategyTitle}”.`
    : 'Nothing is polling. Quota only updates when you refresh by hand, and no account will be rotated.';

  // The engine refuses below two accounts (`too-few-accounts`), so the button
  // that would trigger that refusal is not offered at all.
  const tooFewToRotate = accounts.length < 2 || startBlocked;

  const mismatch =
    cfg.enabled && !running && !tooFewToRotate
      ? 'Auto-switch is turned on in settings but the engine is not running in this session. Press Start auto-switch to bring it back up.'
      : !cfg.enabled && running
        ? 'The engine is running even though auto-switch is turned off in settings. Press Stop auto-switch to bring the two back in line.'
        : null;

  let triggerLine: string;
  if (!activeAccount) {
    triggerLine = 'No account is active, so there is nothing to move off. Activate one from the Accounts view first.';
  } else if (activePeak === null) {
    triggerLine = `${describeAccount(activeAccount)} has not reported usage yet, so the engine cannot tell whether it is past ${threshold}%. Refresh usage from the title bar.`;
  } else if (activePeak >= threshold) {
    triggerLine = `${describeAccount(activeAccount)} is at ${activePeak}% on its ${activeBinding?.label ?? 'binding'} window — at or past ${threshold}%, so the next poll would switch.`;
  } else {
    triggerLine = `${describeAccount(activeAccount)} is at ${activePeak}% on its ${activeBinding?.label ?? 'binding'} window — ${round1(threshold - activePeak)} points below ${threshold}%, so nothing would move yet.`;
  }

  return (
    <div className="cd-view">
      <style href="cd-automation" precedence="cd-view">
        {VIEW_CSS}
      </style>

      <header className="cd-view-head">
        <h1 className="cd-h1">Automation</h1>
        <p className="cd-view-sub">Rotate accounts before a rate limit lands, on rules you can read back.</p>
      </header>

      {safeMode ? (
        <Note tone="warning" icon="alert-triangle">
          Safe mode is on. ClaudeDeck refuses every disk write, so changes here cannot be saved and the engine cannot
          switch accounts. Turn safe mode off in Settings first.
        </Note>
      ) : null}

      {saveError ? (
        <Note tone="critical" icon="alert-octagon">
          That change was not saved: {saveError}
        </Note>
      ) : null}

      {/* --- master switch --- */}
      <section className="cd-card cd-card--raised">
        <div className="cda-hero" data-running={running ? 'true' : 'false'}>
          <span className="cda-hero-icon">
            <Icon name={running ? 'play' : 'pause'} size={22} />
          </span>
          <span className="cda-hero-text">
            <span className="cda-hero-title">Auto-switch is {running ? 'running' : 'stopped'}</span>
            <span className="cd-secondary">{heroLine}</span>
          </span>
          <span className="cd-spacer" />
          <span className="cd-row">
            {cfg.dryRun ? (
              <Badge tone="warning" icon="alert-triangle">
                Dry run
              </Badge>
            ) : null}
            <Badge tone={running ? 'good' : 'neutral'} icon={running ? 'check' : 'minus'}>
              {running ? 'Running' : 'Stopped'}
            </Badge>
            <Button
              variant={running ? 'secondary' : 'primary'}
              icon="power"
              busy={pending === 'engine'}
              disabled={!running && tooFewToRotate}
              onClick={() => void toggleEngine()}
            >
              {running ? 'Stop auto-switch' : 'Start auto-switch'}
            </Button>
          </span>
        </div>
        {tooFewToRotate ? (
          <Note tone="warning" icon="alert-triangle">
            <span>
              Rotation needs two accounts to move between, and ClaudeDeck is managing {accounts.length}.
              {cfg.enabled ? ' Auto-switch is on in settings, but it cannot start until there is a second one.' : ''}
            </span>
            <div className="cd-row">
              <Button icon="plus" onClick={goToAccounts}>
                Add an account
              </Button>
              {cfg.enabled ? (
                <Button variant="ghost" onClick={() => void patchAuto({ enabled: false })}>
                  Turn the setting off
                </Button>
              ) : null}
            </div>
          </Note>
        ) : null}
        {startError ? (
          <Note tone="critical" icon="alert-octagon">
            Auto-switch did not start, so it was left off: {startError}
          </Note>
        ) : null}
        {mismatch ? (
          <Note tone="warning" icon="alert-triangle">
            {mismatch}
          </Note>
        ) : null}
      </section>

      {/* --- strategy --- */}
      <section className="cd-card">
        <div className="cd-card-head">
          <Icon name="chevron" />
          <h2 className="cd-h2">When it switches, where does it go?</h2>
        </div>
        <fieldset className="cda-opts">
          <legend className="cd-sr-only">Switch strategy</legend>
          {STRATEGIES.map((option) => (
            <label key={option.id} className="cda-opt" data-selected={cfg.strategy === option.id ? 'true' : 'false'}>
              <input
                type="radio"
                name="cda-strategy"
                value={option.id}
                checked={cfg.strategy === option.id}
                onChange={() => void patchAuto({ strategy: option.id })}
              />
              <span>
                <span className="cda-opt-title">{option.title}</span>
                <span className="cda-opt-desc">{option.desc}</span>
              </span>
            </label>
          ))}
        </fieldset>
      </section>

      {/* --- threshold + live preview --- */}
      <section className="cd-card">
        <div className="cd-card-head">
          <Icon name="activity" />
          <h2 className="cd-h2">Switch threshold</h2>
        </div>
        <p className="cd-secondary">
          How far the active account is allowed to get before ClaudeDeck moves on. Lower switches early and leaves quota
          on the table; higher cuts it finer.
        </p>
        <div className="cda-range-row">
          <input
            className="cda-range"
            type="range"
            min={25}
            max={100}
            step={1}
            value={threshold}
            aria-label="Switch threshold, percent utilization"
            aria-valuetext={`${threshold} percent`}
            onChange={(e) => setThreshold(Number(e.target.value))}
            onPointerUp={commitThreshold}
            onKeyUp={commitThreshold}
            onBlur={commitThreshold}
          />
          <output className="cda-range-value">{threshold}%</output>
        </div>

        <div className="cda-preview">
          <p>
            <strong>Right now:</strong> {triggerLine}
          </p>
          {previewError ? (
            <Note tone="warning" icon="alert-triangle">
              The engine could not be asked where it would go ({previewError}). Rotation still works; refresh usage and
              this preview will come back.
            </Note>
          ) : preview?.to ? (
            <>
              <p>
                It would hand over to{' '}
                <strong>{describeAccount(previewTarget, preview.to.slot, preview.to.email)}</strong>
                {previewTarget?.alias ? ` (${previewTarget.email})` : ''}.
              </p>
              {previewWindows.length > 0 ? (
                <UsageMeter windows={previewWindows} compact />
              ) : (
                <p className="cd-muted">
                  That account has not reported usage yet, so its headroom stays unknown until the next poll.
                </p>
              )}
            </>
          ) : (
            <p>
              No account is eligible to take over{preview?.reason ? `: ${preview.reason}` : ''}. Add another account, or
              re-enable a disabled one, from the Accounts view.
            </p>
          )}
        </div>
      </section>

      {/* --- timing --- */}
      <section className="cd-card">
        <div className="cd-card-head">
          <Icon name="clock" />
          <h2 className="cd-h2">Timing</h2>
        </div>
        <div className="cda-fields">
          <NumberField
            label="Poll interval"
            unit="seconds"
            help="How often usage is re-read. Shorter reacts faster and makes more API calls."
            value={cfg.pollIntervalSec}
            min={15}
            max={3600}
            step={15}
            onCommit={(next) => void patchAuto({ pollIntervalSec: next })}
          />
          <NumberField
            label="Cooldown"
            unit="seconds"
            help="Quiet period after a switch. Stops one bad poll from cascading through every account you own."
            value={cfg.cooldownSec}
            min={0}
            max={86400}
            step={30}
            onCommit={(next) => void patchAuto({ cooldownSec: next })}
          />
          <NumberField
            label="Hysteresis margin"
            unit="points"
            help="Extra headroom a candidate must beat the current account by before the engine moves. Stops it flapping between two near-equal accounts."
            value={cfg.hysteresisMargin}
            min={0}
            max={50}
            onCommit={(next) => void patchAuto({ hysteresisMargin: next })}
          />
        </div>
      </section>

      {/* --- scope --- */}
      <section className="cd-card">
        <div className="cd-card-head">
          <Icon name="layout" />
          <h2 className="cd-h2">What counts toward the decision</h2>
        </div>

        <div className="cd-stack">
          <span className="cda-field-label">Per-model weekly windows</span>
          {modelOptions.length === 0 ? (
            <p className="cda-field-help">
              No per-model windows have been reported yet. They appear here once a poll returns model-scoped limits;
              until then the 5-hour and 7-day windows are the only inputs.
            </p>
          ) : (
            <>
              <div className="cda-chips">
                {modelOptions.map((option) => {
                  const selected = cfg.models.includes(option.key);
                  return (
                    <label key={option.key} className="cda-chip" data-selected={selected ? 'true' : 'false'}>
                      <input type="checkbox" checked={selected} onChange={() => toggleModel(option.key)} />
                      <span>{option.label}</span>
                      {selected ? <Icon name="check" size={12} /> : null}
                    </label>
                  );
                })}
              </div>
              <p className="cda-field-help">
                Selected windows are weighed alongside the 5-hour and 7-day windows. With none selected, a model-specific
                limit will not on its own trigger a switch.
              </p>
            </>
          )}
        </div>

        <hr className="cd-divider" />

        <Toggle
          checked={cfg.includeApiKeyAccounts}
          onChange={(next) => void patchAuto({ includeApiKeyAccounts: next })}
          label="Include API-key accounts"
          description="Managed sk-ant-api… keys have no subscription window, so they never report usage and can never be rate limited. Include them only as a last-resort fallback."
        />

        <Toggle
          checked={cfg.dryRun}
          onChange={(next) => void patchAuto({ dryRun: next })}
          label="Dry run"
          description="Make the whole decision and write it to the log below, but never touch the credential store."
        />
      </section>

      {/* --- log --- */}
      <section className="cd-card">
        <div className="cd-card-head">
          <Icon name="activity" />
          <h2 className="cd-h2">Engine log</h2>
          <span className="cd-spacer" />
          <span className="cd-muted">
            {events.length === 0 ? 'No entries' : `Newest first · ${events.length} of the last ${LOG_CAP}`}
          </span>
        </div>
        {events.length === 0 ? (
          <EmptyState
            icon="clock"
            title="The engine has not reported anything yet"
            description={
              running
                ? `Entries appear on every poll — the first one lands within ${cfg.pollIntervalSec}s.`
                : tooFewToRotate
                  ? 'The engine needs a second account before it can run, so there is nothing to record yet.'
                  : 'Start auto-switch and every poll, skip, and switch will be recorded here.'
            }
          />
        ) : (
          <ol className="cda-log" role="log">
            {events.map((event) => {
              const meta = EVENT_META[event.kind] ?? UNKNOWN_EVENT;
              const label = 'label' in meta ? meta.label : event.kind;
              const when = new Date(event.ts);
              return (
                <li className="cda-log-row" key={eventKey(event)}>
                  <Badge tone={meta.tone} icon={meta.icon}>
                    {label}
                  </Badge>
                  <time className="cda-log-time" dateTime={when.toISOString()} title={when.toLocaleString()}>
                    {TIME_FMT.format(when)}
                  </time>
                  <span className="cda-log-msg">
                    {event.slot === undefined ? null : <span className="cda-log-slot">slot {event.slot} · </span>}
                    {event.message}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </div>
  );
}
