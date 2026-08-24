/**
 * Onboarding — the three-step wizard shown while `state.onboarded` is false.
 *
 * The shape of it is deliberate. Step 1 reports what ClaudeDeck can actually
 * see rather than claiming a clean bill of health; step 2 spends more words on
 * the /logout hazard than on the button, because that mistake is unrecoverable
 * and the button is not; step 3 asks one question. Every failure path names the
 * next action, so no state on this screen is a dead end.
 *
 * Progress is kept in sessionStorage: this view is mounted by the shell purely
 * on `onboarded`, so if the main process flips that flag as soon as the first
 * account lands, a remount resumes where the user was instead of restarting.
 *
 * The wizard replaces the whole shell, so it lays out its own page; shared
 * notes and inputs still come from `views.css`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Account, DeckState, WorkSchedule } from '@shared/types';
import type { DeckApi } from '@shared/ipc';
import { useDeckState } from '../hooks/useDeckState';
import { Badge, type BadgeTone } from '../components/Badge';
import { Button, IconButton } from '../components/Button';
import { Icon, type IconName } from '../components/Icon';
import { Logo } from '../components/Logo';
import { ScheduleEditor } from '../components/ScheduleEditor';
import { DEFAULT_SCHEDULE, validateSchedule } from '@core/schedule';
import './views.css';

const DOCS_URL = 'https://docs.claude.com/en/docs/claude-code/overview';

const VIEW_CSS = `
.cdo-root { height: 100vh; overflow: auto; background: var(--plane); padding: var(--space-6) var(--space-5); }
.cdo-shell { display: flex; flex-direction: column; gap: var(--space-5); max-width: 760px; margin: 0 auto; }
.cdo-brand { display: flex; align-items: center; gap: var(--space-2); color: var(--text-secondary); font-size: 13px; font-weight: 600; }

.cdo-steps { display: flex; gap: var(--space-3); margin: 0; padding: 0; list-style: none; }
.cdo-step { flex: 1 1 0; display: flex; flex-direction: column; gap: var(--space-2); font-size: 12px; color: var(--text-muted); }
.cdo-step-bar { height: 4px; border-radius: 999px; background: var(--grid); }
.cdo-step[data-state="done"] .cdo-step-bar { background: var(--border-strong); }
.cdo-step[data-state="current"] .cdo-step-bar { background: var(--accent); }
.cdo-step[data-state="current"] { color: var(--text-primary); font-weight: 600; }
.cdo-step-label { display: flex; align-items: center; gap: 6px; }

.cdo-checks { display: flex; flex-direction: column; gap: var(--space-3); }
.cdo-check {
  display: flex; flex-wrap: wrap; align-items: flex-start; gap: var(--space-3);
  padding: var(--space-3); border: 1px solid var(--border);
  border-radius: var(--radius); background: var(--surface-1);
}
.cdo-check-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 260px; }
.cdo-check-title { font-size: 13px; font-weight: 600; }
.cdo-check-desc { font-size: 12px; line-height: 1.5; color: var(--text-secondary); overflow-wrap: anywhere; }

.cdo-paths { display: flex; flex-direction: column; gap: var(--space-2); margin-top: var(--space-2); }
.cdo-path { display: flex; align-items: center; gap: var(--space-2); }
.cdo-path-value { font-family: var(--font-mono); font-size: 11px; overflow-wrap: anywhere; min-width: 0; }

.cdo-opts { display: grid; gap: var(--space-2); grid-template-columns: repeat(auto-fit, minmax(268px, 1fr)); border: 0; margin: 0; padding: 0; }
.cdo-opt {
  display: flex; gap: var(--space-3); padding: var(--space-3);
  border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--surface-1); cursor: pointer;
}
.cdo-opt:hover { border-color: var(--border-strong); }
.cdo-opt[data-selected="true"] { border-color: var(--accent); background: var(--accent-wash); }
.cdo-opt input { margin: 3px 0 0; accent-color: var(--accent); }
.cdo-opt[data-disabled="true"] { cursor: not-allowed; background: var(--surface-2); }
.cdo-opt[data-disabled="true"]:hover { border-color: var(--border); }
.cdo-opt[data-disabled="true"] .cdo-opt-title { color: var(--text-secondary); }
.cdo-opt-title { display: block; font-size: 13px; font-weight: 600; }
.cdo-opt-desc { display: block; margin-top: 2px; font-size: 12px; line-height: 1.45; color: var(--text-secondary); }

.cdo-field { display: flex; flex-direction: column; gap: var(--space-1); }
.cdo-label { font-size: 12px; font-weight: 600; color: var(--text-secondary); }
.cdo-help { font-size: 12px; line-height: 1.45; color: var(--text-muted); }
.cdo-field .cd-input { width: 100%; }

.cdo-range-row { display: flex; align-items: center; gap: var(--space-3); }
.cdo-range { flex: 1 1 auto; min-width: 160px; accent-color: var(--accent); }
.cdo-range-value { min-width: 68px; text-align: right; font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }

.cdo-root .cd-note ul { margin: var(--space-2) 0 0; padding-left: var(--space-4); list-style: disc; }
.cdo-root .cd-note li { margin-bottom: 4px; }

.cdo-alt { border: 1px solid var(--border); border-radius: var(--radius); padding: var(--space-3); background: var(--surface-1); }
.cdo-alt > summary { cursor: pointer; font-size: 13px; font-weight: 600; }
.cdo-alt > div { display: flex; flex-direction: column; gap: var(--space-3); margin-top: var(--space-3); }

.cdo-nav { display: flex; align-items: center; gap: var(--space-3); }
`;

const STEPS = [
  { title: 'Detect', heading: 'Find your Claude Code install' },
  { title: 'Add an account', heading: 'Capture your first account' },
  { title: 'Your hours', heading: 'When does your day actually matter?' },
  { title: 'Choose behavior', heading: 'Decide how switching works' },
] as const;

const STEP_KEY = 'claudedeck:onboarding-step';

function readStoredStep(): number | null {
  try {
    const raw = window.sessionStorage.getItem(STEP_KEY);
    if (raw === null) return null;
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed >= 0 && parsed < STEPS.length ? parsed : null;
  } catch {
    return null;
  }
}

function writeStoredStep(step: number | null): void {
  try {
    if (step === null) window.sessionStorage.removeItem(STEP_KEY);
    else window.sessionStorage.setItem(STEP_KEY, String(step));
  } catch {
    /* a lost wizard position costs one click, not an error banner */
  }
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function Note({
  tone,
  icon,
  children,
}: {
  tone: 'info' | 'good' | 'warning' | 'critical';
  icon: IconName;
  children: ReactNode;
}) {
  const variant = tone === 'critical' ? ' cd-note--error' : tone === 'warning' ? ' cd-note--warning' : '';
  const role = tone === 'critical' ? 'Important' : tone === 'warning' ? 'Warning' : 'Note';
  return (
    <div className={`cd-note${variant}`}>
      <Icon name={icon} title={role} />
      <div className="cd-note-body">{children}</div>
    </div>
  );
}

interface CheckRow {
  title: string;
  detail: ReactNode;
  tone: BadgeTone;
  icon: IconName;
  label: string;
}

function Check({ row }: { row: CheckRow }) {
  return (
    <div className="cdo-check">
      <span className="cdo-check-body">
        <span className="cdo-check-title">{row.title}</span>
        <span className="cdo-check-desc">{row.detail}</span>
      </span>
      <Badge tone={row.tone} icon={row.icon}>
        {row.label}
      </Badge>
    </div>
  );
}

/**
 * Classifies a pasted secret by prefix so the user gets told what they are
 * adding. The value never leaves this component and is never logged — only the
 * first characters are inspected, in memory.
 */
function tokenHint(token: string): { tone: 'info' | 'good' | 'warning'; icon: IconName; text: string } | null {
  const trimmed = token.trim();
  if (trimmed === '') return null;
  if (trimmed.startsWith('sk-ant-oat')) {
    return {
      tone: 'good',
      icon: 'check',
      text: 'Setup token. It behaves like a normal login: it reports quota and takes part in rotation.',
    };
  }
  if (trimmed.startsWith('sk-ant-api')) {
    return {
      tone: 'info',
      icon: 'info',
      text: 'Managed API key. It has no subscription window, so it never reports usage and auto-switch skips it unless you turn on “Include API-key accounts”.',
    };
  }
  return {
    tone: 'warning',
    icon: 'alert-triangle',
    text: 'That does not begin with sk-ant-oat… or sk-ant-api…. Check that the whole token was pasted.',
  };
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export default function Onboarding() {
  const deck = useDeckState();
  if (!deck.state) {
    return (
      <div className="cdo-root">
        <style href="cd-onboarding" precedence="cd-view">
          {VIEW_CSS}
        </style>
        <p className="cd-view-loading">
          <Icon name="refresh" className="cd-spin" />
          Looking for your Claude Code install…
        </p>
      </div>
    );
  }
  return <Wizard state={deck.state} api={deck.api} stubbed={deck.stubbed} reload={deck.reload} />;
}

function Wizard({
  state,
  api,
  stubbed,
  reload,
}: {
  state: DeckState;
  api: DeckApi;
  stubbed: boolean;
  reload: () => Promise<void>;
}) {
  const accounts = state.accounts;

  const [step, setStep] = useState<number>(() => readStoredStep() ?? (accounts.length > 0 ? 1 : 0));
  const [done, setDone] = useState(false);

  useEffect(() => {
    writeStoredStep(step);
  }, [step]);

  const goTo = useCallback((next: number) => {
    setStep(Math.max(0, Math.min(STEPS.length - 1, next)));
  }, []);

  if (done) {
    return (
      <div className="cdo-root">
        <style href="cd-onboarding" precedence="cd-view">
          {VIEW_CSS}
        </style>
        <div className="cdo-shell">
          <span className="cdo-brand">
            <Logo size={20} animate />
            ClaudeDeck
          </span>
          <section className="cd-card cd-card--raised">
            <div className="cd-card-head">
              <Icon name="check" />
              <h1 className="cd-h1">You are set up</h1>
            </div>
            <p className="cd-secondary">
              ClaudeDeck is managing {accounts.length} account{accounts.length === 1 ? '' : 's'}.{' '}
              {accounts.length < 2
                ? 'Switching needs a second one: add it from the Accounts view whenever you are ready, then turn auto-switch on in Automation.'
                : 'The dashboard shows live quota; Automation holds every rotation rule.'}
            </p>
            <Note tone="info" icon="info">
              Still seeing this wizard instead of the dashboard? The main process has not marked setup complete yet.
              Press Re-check, or restart ClaudeDeck.
            </Note>
            <div className="cdo-nav">
              <Button variant="primary" icon="refresh" onClick={() => void reload()}>
                Re-check
              </Button>
              <Button variant="ghost" icon="chevron-left" onClick={() => setDone(false)}>
                Back to the wizard
              </Button>
            </div>
          </section>
        </div>
      </div>
    );
  }

  const current = STEPS[step] ?? STEPS[0];

  return (
    <div className="cdo-root">
      <style href="cd-onboarding" precedence="cd-view">
        {VIEW_CSS}
      </style>

      <div className="cdo-shell">
        <span className="cdo-brand">
          <Logo size={20} animate />
          ClaudeDeck
        </span>

        <header className="cd-stack">
          <h1 className="cd-h1">{current.heading}</h1>
          <p className="cd-view-sub">
            Step {step + 1} of {STEPS.length}. Nothing is written to disk until you press a button that says so.
          </p>
        </header>

        <ol className="cdo-steps">
          {STEPS.map((entry, index) => {
            const stepState = index === step ? 'current' : index < step ? 'done' : 'todo';
            return (
              <li
                key={entry.title}
                className="cdo-step"
                data-state={stepState}
                aria-current={index === step ? 'step' : undefined}
              >
                <span className="cdo-step-bar" />
                <span className="cdo-step-label">
                  {index < step ? <Icon name="check" size={12} title="Completed" /> : null}
                  {index + 1}. {entry.title}
                </span>
              </li>
            );
          })}
        </ol>

        {stubbed ? (
          <Note tone="warning" icon="alert-triangle">
            This window has no main-process bridge, so it is showing stub data and cannot capture a real account. Launch
            ClaudeDeck as the desktop app to finish setup.
          </Note>
        ) : null}

        {step === 0 ? (
          <DetectStep state={state} api={api} stubbed={stubbed} reload={reload} onNext={() => goTo(1)} />
        ) : null}
        {step === 1 ? (
          <AddAccountStep state={state} api={api} onBack={() => goTo(0)} onNext={() => goTo(2)} />
        ) : null}
        {step === 2 ? (
          <HoursStep state={state} api={api} onBack={() => goTo(1)} onNext={() => goTo(3)} />
        ) : null}
        {step === 3 ? (
          <BehaviorStep
            state={state}
            api={api}
            onBack={() => goTo(2)}
            onAddAccount={() => goTo(1)}
            onDone={() => {
              writeStoredStep(null);
              setDone(true);
              if (typeof window !== 'undefined') window.location.hash = '#/dashboard';
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — detect
// ---------------------------------------------------------------------------

function DetectStep({
  state,
  api,
  stubbed,
  reload,
  onNext,
}: {
  state: DeckState;
  api: DeckApi;
  stubbed: boolean;
  reload: () => Promise<void>;
  onNext: () => void;
}) {
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);

  const recheck = async () => {
    setChecking(true);
    try {
      await reload();
      setCheckedAt(Date.now());
    } finally {
      setChecking(false);
    }
  };

  const paths = state.paths;
  const located = !stubbed && paths.configHome.trim() !== '';
  const managed = state.accounts.length;

  const rows: CheckRow[] = [
    {
      title: 'Desktop bridge',
      detail: stubbed
        ? 'This page is running without the main process, so it can read nothing from disk. Start ClaudeDeck from its app icon or with npm run dev.'
        : 'The main process answered, so ClaudeDeck can read and write your Claude Code files.',
      tone: stubbed ? 'warning' : 'good',
      icon: stubbed ? 'alert-triangle' : 'check',
      label: stubbed ? 'Not connected' : 'Connected',
    },
    {
      title: 'Claude Code configuration',
      detail: located
        ? 'Resolved from CLAUDE_CONFIG_DIR when it is set, otherwise from your home directory. The exact locations are below.'
        : 'No config location resolved. Set CLAUDE_CONFIG_DIR to the directory Claude Code uses, then press Re-check.',
      tone: located ? 'good' : 'warning',
      icon: located ? 'check' : 'alert-triangle',
      label: located ? 'Found' : 'Not found',
    },
    {
      title: 'A login to capture',
      detail:
        managed > 0
          ? `ClaudeDeck already holds ${managed} account${managed === 1 ? '' : 's'}, so a sign-in has been read successfully before.`
          : 'Not verified yet. ClaudeDeck opens the credential store only at the moment you capture, so the next step is the real check — and it will say exactly what it found.',
      tone: managed > 0 ? 'good' : 'neutral',
      icon: managed > 0 ? 'check' : 'info',
      label: managed > 0 ? `${managed} managed` : 'Checked in step 2',
    },
  ];

  return (
    <>
      <section className="cd-card">
        <div className="cdo-checks">
          {rows.map((row) => (
            <Check key={row.title} row={row} />
          ))}
        </div>

        {state.demoMode ? (
          <Note tone="info" icon="info">
            Demo mode is on, so these are synthetic fixtures rather than a real install. Nothing you do here touches a
            real account.
          </Note>
        ) : null}

        <hr className="cd-divider" />

        <h2 className="cd-h3">Resolved locations</h2>
        <div className="cdo-paths">
          {(
            [
              ['Config home', paths.configHome],
              ['Global config', paths.globalConfig],
              ['Credentials', paths.credentials],
              ['ClaudeDeck data', paths.deckHome],
            ] as const
          ).map(([label, value]) => (
            <div className="cdo-path" key={label}>
              <span className="cdo-label" style={{ minWidth: 118 }}>
                {label}
              </span>
              <span className="cdo-path-value">{value}</span>
              <span className="cd-spacer" />
              <IconButton
                icon="external-link"
                label={`Reveal ${label}`}
                variant="ghost"
                size="sm"
                onClick={() => void api.revealPath(value)}
              />
            </div>
          ))}
        </div>

        {!located ? (
          <Note tone="warning" icon="alert-triangle">
            If Claude Code is installed somewhere unusual, point ClaudeDeck at it by setting CLAUDE_CONFIG_DIR before
            launching, then press Re-check. If it is not installed yet, install it first —{' '}
            <Button variant="ghost" size="sm" icon="external-link" onClick={() => void api.openExternal(DOCS_URL)}>
              open the Claude Code docs
            </Button>
          </Note>
        ) : null}
      </section>

      <div className="cdo-nav">
        <Button icon="refresh" busy={checking} onClick={() => void recheck()}>
          Re-check
        </Button>
        {checkedAt === null ? null : (
          <span className="cd-muted">Last checked {new Date(checkedAt).toLocaleTimeString()}</span>
        )}
        <span className="cd-spacer" />
        <Button variant="primary" trailingIcon="chevron" onClick={onNext}>
          Next
        </Button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — capture
// ---------------------------------------------------------------------------

function AddAccountStep({
  state,
  api,
  onBack,
  onNext,
}: {
  state: DeckState;
  api: DeckApi;
  onBack: () => void;
  onNext: () => void;
}) {
  const [alias, setAlias] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [captured, setCaptured] = useState<Account | null>(null);
  const [reused, setReused] = useState<{ email: string; slot: number } | null>(null);

  const [token, setToken] = useState('');
  const [tokenEmail, setTokenEmail] = useState('');
  const [tokenError, setTokenError] = useState<string | null>(null);

  const hint = useMemo(() => tokenHint(token), [token]);
  const accounts = state.accounts;

  const capture = async () => {
    setBusy('capture');
    setCaptureError(null);
    setReused(null);
    try {
      const trimmed = alias.trim();
      // Capture upserts by email, so pressing this again while Claude Code is
      // still signed in as the same person rewrites the slot it already holds.
      // Remember who was here, so that case can be named rather than reported
      // as a new account.
      const held = new Map(accounts.map((a) => [a.email.trim().toLowerCase(), a.slot]));
      const result = await api.addCurrentAccount({ alias: trimmed === '' ? undefined : trimmed });
      if (result.ok) {
        const already = held.get(result.value.email.trim().toLowerCase());
        setCaptured(already === undefined ? result.value : null);
        setReused(already === undefined ? null : { email: result.value.email, slot: already });
        setAlias('');
      } else {
        setCaptured(null);
        setCaptureError(result.error);
      }
    } finally {
      setBusy(null);
    }
  };

  const addToken = async () => {
    setBusy('token');
    setTokenError(null);
    const value = token.trim();
    const email = tokenEmail.trim();
    const trimmedAlias = alias.trim();
    // Drop the secret from component state before awaiting, so it lives for as
    // short a time as possible and never survives a failed round trip.
    setToken('');
    try {
      const result = await api.addToken({
        token: value,
        email: email === '' ? undefined : email,
        alias: trimmedAlias === '' ? undefined : trimmedAlias,
      });
      if (result.ok) {
        setCaptured(result.value);
        setTokenEmail('');
        setAlias('');
      } else {
        setTokenError(result.error);
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <section className="cd-card">
        <p className="cd-secondary">
          ClaudeDeck copies whatever Claude Code is signed in as right now — the credential blob and the account identity
          beside it — into a numbered slot. Claude Code stays signed in exactly as it is; nothing about your current
          session changes.
        </p>

        <Note tone="critical" icon="alert-octagon">
          <strong>Do not run /logout first.</strong> Signing out can revoke the refresh token for the account you are
          leaving, and a revoked refresh token cannot be recovered — that account would have to sign in from scratch.
          Capture first, and switch accounts from ClaudeDeck afterwards.
        </Note>

        <label className="cdo-field">
          <span className="cdo-label">Alias (optional)</span>
          <input
            className="cd-input"
            type="text"
            value={alias}
            spellCheck={false}
            placeholder="work"
            onChange={(e) => setAlias(e.target.value)}
          />
          <span className="cdo-help">
            A short handle you can use anywhere a slot number works, in the command palette and the CLI.
          </span>
        </label>

        {accounts.length > 0 ? (
          <Note tone="info" icon="info">
            Capture takes whoever Claude Code is signed in as right now. For a second account, run{' '}
            <span className="cd-mono">claude</span> in a terminal and log in as that account first — without{' '}
            <span className="cd-mono">/logout</span> — then press the button below.
          </Note>
        ) : null}

        <div className="cd-row">
          <Button variant="primary" icon="plus" busy={busy === 'capture'} onClick={() => void capture()}>
            {accounts.length === 0 ? 'Capture the current account' : 'Capture another account'}
          </Button>
        </div>

        {captured ? (
          <Note tone="good" icon="check">
            Captured <strong>{captured.email}</strong> into slot {captured.slot}
            {captured.alias ? ` as “${captured.alias}”` : ''}.
          </Note>
        ) : null}

        {reused ? (
          <Note tone="warning" icon="alert-triangle">
            <strong>That is already slot {reused.slot}.</strong> Claude Code is still signed in as {reused.email}, so
            slot {reused.slot} was refreshed and no account was added. Log in to Claude Code as your other account
            first, then press this again.
          </Note>
        ) : null}

        {captureError ? (
          <Note tone="critical" icon="alert-octagon">
            <strong>Could not capture an account:</strong> {captureError}
            <ul>
              <li>
                Run <span className="cd-mono">claude</span> in a terminal and sign in, then press the capture button
                again. Do not sign out of anything first.
              </li>
              <li>Confirm the credential path on the previous step is the one Claude Code actually uses.</li>
              <li>On macOS, Claude Code keeps the login in the Keychain — approve the access prompt when it appears.</li>
              <li>On a headless machine, use the token option below instead.</li>
            </ul>
          </Note>
        ) : null}

        <details className="cdo-alt">
          <summary>Add a token instead (headless machines and CI)</summary>
          <div>
            <p className="cd-secondary">
              Run <span className="cd-mono">claude setup-token</span> on a machine with a browser and paste the{' '}
              <span className="cd-mono">sk-ant-oat…</span> value here, or paste a managed{' '}
              <span className="cd-mono">sk-ant-api…</span> key. The token is sent straight to the main process and stored
              in the vault; it is never written to a log. The alias above applies to this account too.
            </p>

            <label className="cdo-field">
              <span className="cdo-label">Token</span>
              <input
                className="cd-input"
                type="password"
                value={token}
                autoComplete="off"
                spellCheck={false}
                placeholder="sk-ant-oat01-…"
                onChange={(e) => setToken(e.target.value)}
              />
            </label>

            {hint ? (
              <Note tone={hint.tone} icon={hint.icon}>
                {hint.text}
              </Note>
            ) : null}

            <label className="cdo-field">
              <span className="cdo-label">Email (optional)</span>
              <input
                className="cd-input"
                type="email"
                value={tokenEmail}
                autoComplete="off"
                spellCheck={false}
                placeholder="you@example.com"
                onChange={(e) => setTokenEmail(e.target.value)}
              />
              <span className="cdo-help">
                Only a label. ClaudeDeck fills it in from the account profile when the token can fetch one.
              </span>
            </label>

            <div className="cd-row">
              <Button
                icon="plus"
                busy={busy === 'token'}
                disabled={token.trim() === ''}
                onClick={() => void addToken()}
              >
                Add token account
              </Button>
            </div>

            {tokenError ? (
              <Note tone="critical" icon="alert-octagon">
                <strong>The token was not accepted:</strong> {tokenError} Generate a fresh one with{' '}
                <span className="cd-mono">claude setup-token</span> and try again — setup tokens expire.
              </Note>
            ) : null}
          </div>
        </details>
      </section>

      {accounts.length > 0 ? (
        <section className="cd-card">
          <div className="cd-card-head">
            <Icon name="users" />
            <h2 className="cd-h2">Managed accounts</h2>
          </div>
          <table className="cd-table">
            <caption>
              {accounts.length === 1
                ? '1 account. Switching needs two — capture the second whenever you like.'
                : `${accounts.length} accounts ClaudeDeck can switch between`}
            </caption>
            <thead>
              <tr>
                <th scope="col" className="cd-num">
                  Slot
                </th>
                <th scope="col">Account</th>
                <th scope="col">Kind</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => (
                <tr key={account.slot}>
                  <td className="cd-num">{account.slot}</td>
                  <td>
                    {account.email}
                    {account.alias ? <span className="cd-muted"> · {account.alias}</span> : null}
                  </td>
                  <td>
                    {account.kind === 'api-key' ? (
                      <Badge tone="neutral" icon="minus">
                        API key, no quota
                      </Badge>
                    ) : (
                      <Badge tone="good" icon="check">
                        Subscription login
                      </Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      <div className="cdo-nav">
        <Button icon="chevron-left" onClick={onBack}>
          Back
        </Button>
        <span className="cd-spacer" />
        {accounts.length === 0 ? (
          <span className="cd-muted">Capture an account, or add a token, to continue.</span>
        ) : null}
        <Button variant="primary" trailingIcon="chevron" disabled={accounts.length === 0} onClick={onNext}>
          {accounts.length === 1 ? 'Continue with 1 account' : 'Next'}
        </Button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — behavior
// ---------------------------------------------------------------------------

/**
 * The user's hours.
 *
 * Asked here rather than left in Settings because it is the one input the
 * session planner cannot infer, and a planner running on hours nobody confirmed
 * is worse than no planner. Skipping is allowed and honest: the planner simply
 * stays off until there is something real to plan against.
 */
function HoursStep({
  state,
  api,
  onBack,
  onNext,
}: {
  state: DeckState;
  api: DeckApi;
  onBack: () => void;
  onNext: () => void;
}) {
  const cfg = state.settings.planner;
  const [schedule, setSchedule] = useState<WorkSchedule>(cfg.schedules[0] ?? DEFAULT_SCHEDULE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const problems = validateSchedule(schedule);
  const blocking = problems.length > 0 && schedule.days.length === 0;

  const save = async (enable: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const saved = await api.updateSettings({
        planner: {
          ...cfg,
          enabled: enable,
          // Only a real save marks the hours as the user's own; skipping leaves
          // `configured` false so every surface keeps calling them defaults.
          configured: enable,
          schedules: enable ? [schedule] : cfg.schedules,
        },
      });
      if (!saved.ok) {
        setError(
          `Your hours were not saved: ${saved.error}. If safe mode is on, turn it off in Settings and try again.`,
        );
        return;
      }
      onNext();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="cd-card">
        <div className="cd-stack">
          {/* The Planner's "How this works" copy, word for word. Concrete
              clock times are what make the mechanism land; the interpolated
              version this replaced ended on "5 hours after that", which had no
              referent. One explanation, one phrasing. */}
          <p className="cd-view-sub">
            Your 5-hour window starts at your <strong>first message</strong>, not on the clock. Start at 09:00 and
            resets land 14:00 and 19:00; start at 11:00 and they land 16:00 and 21:00.
          </p>
          <p className="cd-view-sub">
            Tell ClaudeDeck when your day actually matters and it can work out which start time keeps a reset inside
            that stretch, instead of just after it.
          </p>
        </div>

        <ScheduleEditor
          value={schedule}
          onChange={setSchedule}
          showLabel={false}
          disabled={busy}
          footnote="You can change this any time, and keep more than one schedule, in the Planner view."
        />
      </section>

      {error ? (
        <Note tone="warning" icon="alert-triangle">
          {error}
        </Note>
      ) : null}

      <div className="cdo-actions">
        <Button variant="ghost" icon="chevron-left" onClick={onBack} disabled={busy}>
          Back
        </Button>
        <span className="cd-spacer" />
        <Button variant="ghost" onClick={() => void save(false)} disabled={busy}>
          Skip for now
        </Button>
        <Button
          variant="primary"
          trailingIcon="chevron"
          onClick={() => void save(true)}
          busy={busy}
          disabled={blocking}
        >
          Save my hours
        </Button>
      </div>
    </>
  );
}

function BehaviorStep({
  state,
  api,
  onBack,
  onAddAccount,
  onDone,
}: {
  state: DeckState;
  api: DeckApi;
  onBack: () => void;
  onAddAccount: () => void;
  onDone: () => void;
}) {
  const cfg = state.settings.autoswitch;
  const [wantsAuto, setWantsAuto] = useState(cfg.enabled);
  const [threshold, setThreshold] = useState(cfg.threshold);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const managed = state.accounts.length;
  const rotatable = state.accounts.filter((a) => !a.disabled && a.kind !== 'api-key').length;
  // The engine refuses to start with nowhere to go, so automatic is not on
  // offer: an option that cannot be activated must not be selectable.
  const autoBlocked = rotatable < 2;
  const auto = wantsAuto && !autoBlocked;
  const heldText = managed === 0 ? 'none' : managed === 1 ? 'one' : String(managed);

  const finish = async () => {
    setBusy(true);
    setError(null);
    try {
      if (auto) {
        // Start first. `enabled: true` must never reach disk unless rotation is
        // really armed, or the app spends the session believing it is and
        // pointing the user at a button that fails again.
        const started = await api.startAutoSwitch();
        if (!started.ok) {
          await api.updateSettings({ autoswitch: { ...cfg, enabled: false, threshold } });
          if (started.code === 'too-few-accounts') {
            // Nothing to rotate between yet. Manual is the truthful state, and
            // setup ends either way rather than trapping anyone on this step.
            onDone();
            return;
          }
          setError(`Auto-switch did not start, so it was left off: ${started.error}`);
          return;
        }
      }
      const saved = await api.updateSettings({ autoswitch: { ...cfg, enabled: auto, threshold } });
      if (!saved.ok) {
        setError(
          auto
            ? `Auto-switch is running, but the choice was not saved: ${saved.error}. It will not come back after a restart. If safe mode is on, turn it off in Settings.`
            : `Your choice was not saved: ${saved.error}. If safe mode is on, turn it off in Settings and try again.`,
        );
        return;
      }
      onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="cd-card">
        <fieldset className="cdo-opts">
          <legend className="cd-sr-only">Switching behavior</legend>
          <label className="cdo-opt" data-selected={auto ? 'false' : 'true'}>
            <input type="radio" name="cdo-mode" checked={!auto} onChange={() => setWantsAuto(false)} />
            <span>
              <span className="cdo-opt-title">Switch manually</span>
              <span className="cdo-opt-desc">
                ClaudeDeck watches quota and tells you when an account is running out, but only changes accounts when
                you ask. Nothing rotates behind your back.
              </span>
            </span>
          </label>
          <label
            className="cdo-opt"
            data-selected={auto ? 'true' : 'false'}
            data-disabled={autoBlocked ? 'true' : 'false'}
          >
            <input
              type="radio"
              name="cdo-mode"
              checked={auto}
              disabled={autoBlocked}
              onChange={() => setWantsAuto(true)}
            />
            <span>
              <span className="cdo-opt-title">Switch automatically</span>
              <span className="cdo-opt-desc">
                {!autoBlocked
                  ? 'ClaudeDeck polls in the background and moves Claude Code to another account before the active one hits its limit.'
                  : rotatable === managed
                    ? `Needs two accounts to move between. ClaudeDeck is managing ${heldText}.`
                    : `Needs two accounts it can rotate between. API-key and disabled accounts are skipped, which leaves ${rotatable} of your ${managed}.`}
              </span>
            </span>
          </label>
        </fieldset>

        {auto ? (
          <>
            <hr className="cd-divider" />
            <h2 className="cd-h3">Switch when the active account reaches</h2>
            <div className="cdo-range-row">
              <input
                className="cdo-range"
                type="range"
                min={50}
                max={100}
                step={1}
                value={threshold}
                aria-label="Switch threshold, percent utilization"
                aria-valuetext={`${threshold} percent`}
                onChange={(e) => setThreshold(Number(e.target.value))}
              />
              <output className="cdo-range-value">{threshold}%</output>
            </div>
            <p className="cdo-help">
              At {threshold}%, ClaudeDeck hands over once any window it is watching crosses that mark, leaving{' '}
              {100 - threshold} points of headroom for whatever request is already in flight. Strategy, cooldown, and
              per-model windows are all tunable later in Automation.
            </p>
          </>
        ) : autoBlocked ? (
          <Note tone="warning" icon="alert-triangle">
            <span>
              ClaudeDeck switches between two logins; you have {heldText}. It still tracks quota and warns you before a
              limit lands, but there is nowhere to switch to.
            </span>
            <div className="cd-row">
              <Button icon="plus" onClick={onAddAccount}>
                Capture another account
              </Button>
              <span className="cd-muted">Or add it later from the Accounts view.</span>
            </div>
          </Note>
        ) : (
          <Note tone="info" icon="info">
            You can turn auto-switch on at any time from the Automation view — every rule stays visible and reversible
            there.
          </Note>
        )}

        {error ? (
          <Note tone="critical" icon="alert-octagon">
            {error}
          </Note>
        ) : null}
      </section>

      <div className="cdo-nav">
        <Button icon="chevron-left" onClick={onBack}>
          Back
        </Button>
        <span className="cd-spacer" />
        {error ? (
          <Button variant="ghost" onClick={onDone}>
            Open ClaudeDeck anyway
          </Button>
        ) : null}
        <Button variant="primary" icon="check" busy={busy} onClick={() => void finish()}>
          Finish setup
        </Button>
      </div>
    </>
  );
}
