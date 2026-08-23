/**
 * Settings — every persisted preference, plus the honest "what is this install
 * actually doing" block at the bottom.
 *
 * Two rules shape this view. Nothing is saved on a timer or a blur you cannot
 * see: each control writes through `updateSettings` and any refusal (safe mode,
 * a locked file) is surfaced verbatim. And the About block reports what is
 * true, not what is intended — if the vault fell back to plaintext, it says so
 * with an icon and words, never a colour alone.
 *
 * Styling comes from `views.css` for anything the other views also use — notes,
 * inputs, key/value lists — and from the view-local block below only for chrome
 * that exists nowhere else, like the path list and the export payload area.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  Account,
  ClaudePaths,
  DeckState,
  NotificationConfig,
  PlatformKind,
  Settings as DeckSettings,
  ThemeMode,
} from '@shared/types';
import type { DeckApi } from '@shared/ipc';
import { useDeckState } from '../hooks/useDeckState';
import { Badge } from '../components/Badge';
import { Button, IconButton } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { Icon, type IconName } from '../components/Icon';
import { Toggle } from '../components/Toggle';
import './views.css';

const VIEW_CSS = `
.cds-seg { display: flex; flex-wrap: wrap; gap: var(--space-2); border: 0; margin: 0; padding: 0; }
.cds-seg > legend { padding: 0; }
.cds-seg-opt {
  display: inline-flex; align-items: center; gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--surface-1); font-size: 13px; cursor: pointer;
}
.cds-seg-opt:hover { border-color: var(--border-strong); }
.cds-seg-opt[data-selected="true"] { border-color: var(--accent); background: var(--accent-wash); }
.cds-seg-opt input { accent-color: var(--accent); }

.cds-fields { display: grid; gap: var(--space-4); grid-template-columns: repeat(auto-fit, minmax(212px, 1fr)); }
.cds-field { display: flex; flex-direction: column; gap: var(--space-1); min-width: 0; }
.cds-label { font-size: 12px; font-weight: 600; color: var(--text-secondary); }
.cds-help { font-size: 12px; line-height: 1.45; color: var(--text-muted); }
.cds-field .cd-input, .cds-field .cd-select { width: 100%; }
.cds-num { font-variant-numeric: tabular-nums; }

.cds-area {
  width: 100%; min-height: 148px; padding: var(--space-2);
  border: 1px solid var(--border-strong); border-radius: var(--radius);
  background: var(--surface-raised); color: var(--text-primary);
  font-family: var(--font-mono); font-size: 11px; line-height: 1.5; resize: vertical;
}

.cds-paths { display: flex; flex-direction: column; gap: var(--space-3); }
.cds-path { display: flex; align-items: flex-start; gap: var(--space-3); }
.cds-path-body { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.cds-path-value {
  font-family: var(--font-mono); font-size: 11px; color: var(--text-primary);
  overflow-wrap: anywhere;
}

.cds-inline { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--space-3); }
.cds-inline .cds-field { flex: 1 1 240px; }
`;

// ---------------------------------------------------------------------------
// Static tables
// ---------------------------------------------------------------------------

const THEMES: readonly { id: ThemeMode; label: string; icon: IconName }[] = [
  { id: 'light', label: 'Light', icon: 'sun' },
  { id: 'dark', label: 'Dark', icon: 'moon' },
  { id: 'system', label: 'Match system', icon: 'monitor' },
];

const PLATFORM_LABEL: Record<PlatformKind, string> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
  wsl: 'Windows Subsystem for Linux',
};

/** What actually holds the key on each platform, in the user's words. */
const SECRET_SERVICE: Record<PlatformKind, string> = {
  windows: 'Windows DPAPI',
  macos: 'the macOS Keychain',
  linux: 'libsecret or KWallet',
  wsl: 'libsecret or KWallet, which a WSL session usually does not provide',
};

const PATH_ROWS: readonly { key: keyof ClaudePaths; label: string; help: string }[] = [
  {
    key: 'configHome',
    label: 'Claude Code config home',
    help: 'CLAUDE_CONFIG_DIR when it is set, otherwise ~/.claude.',
  },
  {
    key: 'globalConfig',
    label: 'Claude Code global config',
    help: 'Carries the signed-in identity: email, account and organization ids.',
  },
  {
    key: 'credentials',
    label: 'Claude Code credentials',
    help: 'The file ClaudeDeck reads on capture and rewrites on every switch.',
  },
  {
    key: 'deckHome',
    label: 'ClaudeDeck data',
    help: 'Vault, usage history, and this settings file — everything this app owns.',
  },
];

/**
 * The texture channel lives outside `Settings` because it is a rendering
 * preference, not app state the main process needs: it only ever stamps an
 * attribute on the document element.
 */
const TEXTURE_KEY = 'claudedeck:texture';

function readTexture(): boolean {
  try {
    return window.localStorage.getItem(TEXTURE_KEY) === 'on';
  } catch {
    return false;
  }
}

function applyTexture(on: boolean): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-texture', on ? 'on' : 'off');
}

// Stamp the saved preference the moment this chunk loads, so returning to the
// view does not briefly drop the pattern fills.
if (typeof document !== 'undefined') applyTexture(readTexture());

// ---------------------------------------------------------------------------
// Vault reporting
// ---------------------------------------------------------------------------

interface VaultProbe {
  plaintext: boolean;
  encryption?: string;
}

/**
 * Reads the vault envelope's own verdict out of the state payload when the
 * build ships one. It is deliberately structural: the About block must degrade
 * to "not reported" rather than guess, because claiming encryption that is not
 * there is the one lie this screen cannot tell.
 */
function probeVault(state: DeckState): VaultProbe | null {
  const bag: Record<string, unknown> = state as unknown as Record<string, unknown>;
  const raw = bag['vault'] ?? bag['vaultStatus'];
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const plaintext = record['plaintext'];
  if (typeof plaintext !== 'boolean') return null;
  const encryption = record['encryption'];
  return { plaintext, encryption: typeof encryption === 'string' ? encryption : undefined };
}

// ---------------------------------------------------------------------------
// Field primitives
// ---------------------------------------------------------------------------

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

interface NumberFieldProps {
  label: string;
  unit: string;
  help: string;
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  onCommit: (next: number) => void;
}

/** Commits a clamped integer on blur or Enter, never mid-keystroke. */
function NumberField({ label, unit, help, value, min, max, disabled, onCommit }: NumberFieldProps) {
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
    <label className="cds-field">
      <span className="cds-label">
        {label} <span className="cd-muted">({unit})</span>
      </span>
      <input
        className="cd-input cds-num"
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
      />
      <span className="cds-help">{help}</span>
    </label>
  );
}

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
  const role = tone === 'critical' ? 'Error' : tone === 'warning' ? 'Warning' : 'Note';
  return (
    <div className={`cd-note${variant}`}>
      <Icon name={icon} title={role} />
      <div className="cd-note-body">{children}</div>
    </div>
  );
}

function Section({ icon, title, children }: { icon: IconName; title: string; children: ReactNode }) {
  return (
    <section className="cd-card">
      <div className="cd-card-head">
        <Icon name={icon} />
        <h2 className="cd-h2">{title}</h2>
      </div>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export default function Settings() {
  const deck = useDeckState();
  if (!deck.state) {
    return (
      <div className="cd-view">
        <p className="cd-view-loading">
          <Icon name="refresh" className="cd-spin" />
          Reading your settings…
        </p>
      </div>
    );
  }
  return <SettingsPanel state={deck.state} api={deck.api} stubbed={deck.stubbed} />;
}

function SettingsPanel({ state, api, stubbed }: { state: DeckState; api: DeckApi; stubbed: boolean }) {
  const settings = state.settings;
  const accounts = state.accounts;

  const [saveError, setSaveError] = useState<string | null>(null);
  const [texture, setTexture] = useState<boolean>(readTexture);

  const save = useCallback(
    async (patch: Partial<DeckSettings>) => {
      const result = await api.updateSettings(patch);
      setSaveError(result.ok ? null : result.error);
      return result.ok;
    },
    [api],
  );

  const patchNotifications = useCallback(
    (patch: Partial<NotificationConfig>) => void save({ notifications: { ...settings.notifications, ...patch } }),
    [save, settings.notifications],
  );

  useEffect(() => {
    applyTexture(texture);
    try {
      window.localStorage.setItem(TEXTURE_KEY, texture ? 'on' : 'off');
    } catch {
      /* a lost rendering preference is not worth an error banner */
    }
  }, [texture]);

  return (
    <div className="cd-view">
      <style href="cd-settings" precedence="cd-view">
        {VIEW_CSS}
      </style>

      <header className="cd-view-head">
        <h1 className="cd-h1">Settings</h1>
        <p className="cd-view-sub">Appearance, alerts, safety, and where everything is kept.</p>
      </header>

      {stubbed ? (
        <Note tone="warning" icon="alert-triangle">
          This window has no main-process bridge, so nothing on this page is being written to disk. Launch ClaudeDeck as
          the desktop app to change real settings.
        </Note>
      ) : null}

      {saveError ? (
        <Note tone="critical" icon="alert-octagon">
          That change was not saved: {saveError}
        </Note>
      ) : null}

      <AppearanceSection theme={settings.theme} texture={texture} onTheme={save} onTexture={setTexture} />

      <NotificationsSection config={settings.notifications} onPatch={patchNotifications} />

      <Section icon="monitor" title="Window and startup">
        <Toggle
          checked={settings.minimizeToTray}
          onChange={(next) => void save({ minimizeToTray: next })}
          label="Keep running in the tray"
          description="Closing the window hides it instead of quitting, so auto-switch keeps polling in the background."
        />
        <Toggle
          checked={settings.launchAtLogin}
          onChange={(next) => void save({ launchAtLogin: next })}
          label="Launch at login"
          description="Start ClaudeDeck when you sign in to this computer."
        />
      </Section>

      <Section icon="activity" title="History">
        <div className="cds-fields">
          <NumberField
            label="Keep history for"
            unit="days"
            help="Usage points older than this are pruned on the next write. Longer history makes burn-rate forecasts steadier."
            value={settings.historyRetentionDays}
            min={1}
            max={3650}
            onCommit={(next) => void save({ historyRetentionDays: next })}
          />
        </div>
      </Section>

      <SafetySection safeMode={settings.safeMode} deckHome={state.paths.deckHome} onSave={save} />

      <MappingsSection state={state} api={api} accounts={accounts} onError={setSaveError} />

      <TransferSection api={api} />

      <AboutSection state={state} api={api} stubbed={stubbed} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function AppearanceSection({
  theme,
  texture,
  onTheme,
  onTexture,
}: {
  theme: ThemeMode;
  texture: boolean;
  onTheme: (patch: Partial<DeckSettings>) => Promise<boolean>;
  onTexture: (next: boolean) => void;
}) {
  return (
    <Section icon="sun" title="Appearance">
      <fieldset className="cds-seg">
        <legend className="cds-label">Theme</legend>
        {THEMES.map((option) => (
          <label key={option.id} className="cds-seg-opt" data-selected={theme === option.id ? 'true' : 'false'}>
            <input
              type="radio"
              name="cds-theme"
              value={option.id}
              checked={theme === option.id}
              onChange={() => void onTheme({ theme: option.id })}
            />
            <Icon name={option.icon} />
            <span>{option.label}</span>
          </label>
        ))}
      </fieldset>

      <hr className="cd-divider" />

      <Toggle
        checked={texture}
        onChange={onTexture}
        label="Add patterns to charts and status fills"
        description="Stamps data-texture on the document so every fill carries a hatch as well as a colour. Turn it on if colour alone is hard to separate; printing and forced-colours mode switch it on regardless."
      />
    </Section>
  );
}

function NotificationsSection({
  config,
  onPatch,
}: {
  config: NotificationConfig;
  onPatch: (patch: Partial<NotificationConfig>) => void;
}) {
  const off = !config.enabled;
  const hint = off ? 'Turn on desktop notifications first.' : undefined;

  return (
    <Section icon="alert-triangle" title="Notifications">
      <Toggle
        checked={config.enabled}
        onChange={(next) => onPatch({ enabled: next })}
        label="Desktop notifications"
        description="The master switch. With this off, nothing below fires — the events are still recorded in the engine log."
      />

      <hr className="cd-divider" />

      <Toggle
        checked={config.onSwitch}
        onChange={(next) => onPatch({ onSwitch: next })}
        disabled={off}
        hint={hint}
        label="An account was switched"
        description="Tells you which account Claude Code is signed in as now."
      />
      <Toggle
        checked={config.onQuarantine}
        onChange={(next) => onPatch({ onQuarantine: next })}
        disabled={off}
        hint={hint}
        label="An account was quarantined"
        description="Its refresh token came back permanently dead and the account is being skipped until you sign in again."
      />
      <Toggle
        checked={config.onExhausted}
        onChange={(next) => onPatch({ onExhausted: next })}
        disabled={off}
        hint={hint}
        label="Every account is exhausted"
        description="There is nowhere left to rotate to — the loudest one to keep on."
      />

      <div className="cds-fields">
        <NumberField
          label="Warn at"
          unit="% utilization"
          help="Notify once the active account crosses this on any window it is gated by."
          value={config.warnAtPct}
          min={1}
          max={100}
          disabled={off}
          onCommit={(next) => onPatch({ warnAtPct: next })}
        />
      </div>
    </Section>
  );
}

function SafetySection({
  safeMode,
  deckHome,
  onSave,
}: {
  safeMode: boolean;
  deckHome: string;
  onSave: (patch: Partial<DeckSettings>) => Promise<boolean>;
}) {
  const [stuck, setStuck] = useState(false);

  const toggle = async (next: boolean) => {
    const saved = await onSave({ safeMode: next });
    // Safe mode blocking its own removal is the one deadlock worth naming.
    setStuck(!saved && !next);
  };

  return (
    <Section icon="ban" title="Safe mode">
      <Toggle
        checked={safeMode}
        onChange={(next) => void toggle(next)}
        label="Read-only guard"
        description="Blocks every disk write ClaudeDeck would make: no switching, no capture, no settings, no history."
      />
      {safeMode ? (
        <Note tone="warning" icon="alert-triangle">
          Safe mode is on. ClaudeDeck can read and display your accounts, but it will refuse to change anything on disk.
        </Note>
      ) : null}
      {stuck ? (
        <Note tone="critical" icon="alert-octagon">
          Safe mode refused the write that would have turned it off. Edit the settings file under{' '}
          <span className="cd-mono">{deckHome}</span> by hand, set <span className="cd-mono">safeMode</span> to false,
          then restart ClaudeDeck.
        </Note>
      ) : null}
    </Section>
  );
}

function MappingsSection({
  state,
  api,
  accounts,
  onError,
}: {
  state: DeckState;
  api: DeckApi;
  accounts: Account[];
  onError: (message: string | null) => void;
}) {
  const mappings = state.settings.directoryMappings;
  const [path, setPath] = useState('');
  const [slot, setSlot] = useState<number | null>(accounts[0]?.slot ?? null);
  const [picking, setPicking] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  useEffect(() => {
    if (slot === null && accounts.length > 0) setSlot(accounts[0]?.slot ?? null);
  }, [accounts, slot]);

  const pick = async () => {
    setPicking(true);
    try {
      const chosen = await api.pickDirectory();
      if (chosen === null) setHint('No folder was chosen. You can also type or paste a path here.');
      else {
        setPath(chosen);
        setHint(null);
      }
    } finally {
      setPicking(false);
    }
  };

  const add = async () => {
    const trimmed = path.trim();
    if (trimmed === '' || slot === null) return;
    const result = await api.mapDirectory(trimmed, slot);
    if (result.ok) {
      setPath('');
      setHint(null);
      onError(null);
    } else {
      onError(result.error);
    }
  };

  const remove = async (target: string) => {
    const result = await api.unmapDirectory(target);
    onError(result.ok ? null : result.error);
  };

  const nameOf = (target: number): string => {
    const account = accounts.find((a) => a.slot === target);
    if (!account) return `slot ${target} (no account in this slot)`;
    return `${account.alias ?? account.email}`;
  };

  return (
    <Section icon="folder" title="Directory mappings">
      <p className="cd-secondary">
        Bind a project folder to an account. When you work inside that folder, ClaudeDeck treats its account as the one
        that belongs to the project instead of whichever slot happens to be active.
      </p>

      <div className="cds-inline">
        <label className="cds-field">
          <span className="cds-label">Folder</span>
          <input
            className="cd-input"
            type="text"
            value={path}
            placeholder="/path/to/your/project"
            spellCheck={false}
            onChange={(e) => setPath(e.target.value)}
          />
        </label>
        <label className="cds-field" style={{ flex: '0 1 220px' }}>
          <span className="cds-label">Account</span>
          <select
            className="cd-select"
            value={slot ?? ''}
            disabled={accounts.length === 0}
            onChange={(e) => setSlot(Number(e.target.value))}
          >
            {accounts.map((account) => (
              <option key={account.slot} value={account.slot}>
                {account.slot} — {account.alias ?? account.email}
              </option>
            ))}
          </select>
        </label>
        <Button icon="folder" busy={picking} onClick={() => void pick()}>
          Choose folder…
        </Button>
        <Button
          variant="primary"
          icon="plus"
          disabled={path.trim() === '' || slot === null}
          onClick={() => void add()}
        >
          Add mapping
        </Button>
      </div>

      {accounts.length === 0 ? (
        <Note tone="info" icon="info">
          There are no accounts to map to yet. Add one from the Accounts view first.
        </Note>
      ) : null}
      {hint ? (
        <Note tone="info" icon="info">
          {hint}
        </Note>
      ) : null}

      {mappings.length === 0 ? (
        <EmptyState
          icon="folder"
          title="No folders are mapped"
          description="Every project uses whichever account is active. Map a folder above to pin one."
        />
      ) : (
        <table className="cd-table">
          <caption>
            {mappings.length} folder{mappings.length === 1 ? '' : 's'} mapped to an account
          </caption>
          <thead>
            <tr>
              <th scope="col">Folder</th>
              <th scope="col">Account</th>
              <th scope="col">
                <span className="cd-sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {mappings.map((mapping) => (
              <tr key={mapping.path}>
                <td className="cd-mono">{mapping.path}</td>
                <td>
                  <span className="cd-num">{mapping.slot}</span> — {nameOf(mapping.slot)}
                </td>
                <td>
                  <span className="cd-row" style={{ justifyContent: 'flex-end', gap: 'var(--space-2)' }}>
                    <IconButton
                      icon="external-link"
                      label={`Reveal ${mapping.path}`}
                      variant="ghost"
                      size="sm"
                      onClick={() => void api.revealPath(mapping.path)}
                    />
                    <IconButton
                      icon="trash"
                      label={`Remove the mapping for ${mapping.path}`}
                      variant="ghost"
                      size="sm"
                      onClick={() => void remove(mapping.path)}
                    />
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

function TransferSection({ api }: { api: DeckApi }) {
  const [full, setFull] = useState(false);
  const [payload, setPayload] = useState('');
  const [exportError, setExportError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const [importText, setImportText] = useState('');
  const [importForce, setImportForce] = useState(false);
  const [importNote, setImportNote] = useState<{ tone: 'good' | 'critical'; text: string } | null>(null);

  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(id);
  }, [copied]);

  const runExport = async () => {
    setBusy('export');
    try {
      const result = await api.exportAccounts({ full });
      if (result.ok) {
        setPayload(result.value);
        setExportError(null);
      } else {
        setPayload('');
        setExportError(result.error);
      }
    } finally {
      setBusy(null);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(payload);
      setCopied(true);
    } catch {
      setExportError('The clipboard was refused. Select the text below and copy it by hand.');
    }
  };

  const runImport = async () => {
    setBusy('import');
    try {
      const result = await api.importAccounts(importText, { force: importForce });
      if (result.ok) {
        const n = result.value.length;
        setImportNote({ tone: 'good', text: `Imported ${n} account${n === 1 ? '' : 's'}.` });
        setImportText('');
      } else {
        setImportNote({ tone: 'critical', text: result.error });
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section icon="download" title="Export and import">
      <Note tone="warning" icon="alert-triangle">
        An export contains live Claude credentials in clear text. Treat the result like a password: never paste it into a
        chat, an issue, or a shared drive.
      </Note>

      <Toggle
        checked={full}
        onChange={setFull}
        label="Full backup"
        description="Include every key found in each credential file, not just the account's own OAuth block. Only useful for restoring onto the same machine."
      />

      <div className="cd-row">
        <Button variant="primary" icon="download" busy={busy === 'export'} onClick={() => void runExport()}>
          Create export
        </Button>
        {payload === '' ? null : (
          <>
            <Button icon={copied ? 'check' : 'copy'} onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy to clipboard'}
            </Button>
            <Button
              variant="ghost"
              icon="x"
              onClick={() => {
                setPayload('');
                setExportError(null);
              }}
            >
              Clear
            </Button>
          </>
        )}
      </div>

      {exportError ? (
        <Note tone="critical" icon="alert-octagon">
          Export failed: {exportError}
        </Note>
      ) : null}

      {payload === '' ? null : (
        <label className="cds-field">
          <span className="cds-label">Export payload</span>
          <textarea className="cds-area" readOnly value={payload} spellCheck={false} />
        </label>
      )}

      <hr className="cd-divider" />

      <label className="cds-field">
        <span className="cds-label">Import payload</span>
        <textarea
          className="cds-area"
          value={importText}
          spellCheck={false}
          placeholder="Paste a ClaudeDeck export here"
          onChange={(e) => setImportText(e.target.value)}
        />
        <span className="cds-help">Accounts land in their exported slots, or the next free slot when that is taken.</span>
      </label>

      <Toggle
        checked={importForce}
        onChange={setImportForce}
        label="Overwrite occupied slots"
        description="Replace whatever is already in a slot instead of moving the incoming account to a free one."
      />

      <div className="cd-row">
        <Button
          variant="primary"
          icon="upload"
          busy={busy === 'import'}
          disabled={importText.trim() === ''}
          onClick={() => void runImport()}
        >
          Import accounts
        </Button>
      </div>

      {importNote ? (
        <Note tone={importNote.tone} icon={importNote.tone === 'good' ? 'check' : 'alert-octagon'}>
          {importNote.tone === 'good' ? importNote.text : `Import failed: ${importNote.text}`}
        </Note>
      ) : null}
    </Section>
  );
}

function AboutSection({ state, api, stubbed }: { state: DeckState; api: DeckApi; stubbed: boolean }) {
  const probe = useMemo(() => probeVault(state), [state]);
  const service = SECRET_SERVICE[state.platform];
  const vaultPath = `${state.paths.deckHome}${state.paths.deckHome.includes('\\') ? '\\' : '/'}vault.json`;

  return (
    <Section icon="info" title="About this install">
      <dl className="cd-kv">
        <dt>Version</dt>
        <dd className="cd-mono">{state.version}</dd>
        <dt>Platform</dt>
        <dd>{PLATFORM_LABEL[state.platform]}</dd>
        <dt>Data source</dt>
        <dd>
          {stubbed ? (
            <Badge tone="warning" icon="alert-triangle">
              Stub data, no main process
            </Badge>
          ) : state.demoMode ? (
            <Badge tone="info" icon="info">
              Demo fixtures, not a real install
            </Badge>
          ) : (
            <Badge tone="good" icon="check">
              Your real Claude Code install
            </Badge>
          )}
        </dd>
      </dl>

      <hr className="cd-divider" />

      <h3 className="cd-h3">Token storage</h3>
      {probe === null ? (
        <Note tone="info" icon="info">
          This build did not report a vault status, so ClaudeDeck will not claim one either. On{' '}
          {PLATFORM_LABEL[state.platform]} it seals the vault with {service} when that is available and writes clear text
          when it is not. Open <span className="cd-mono">{vaultPath}</span> to check: an encrypted vault records{' '}
          <span className="cd-mono">&quot;plaintext&quot;: false</span> next to a base64 payload.
        </Note>
      ) : probe.plaintext ? (
        <Note tone="critical" icon="alert-octagon">
          <strong>Your tokens are stored in clear text.</strong> No OS secret service was available here, so{' '}
          <span className="cd-mono">{vaultPath}</span> holds your refresh tokens readable by anything that can read the
          file. Restrict that folder&apos;s permissions, or run ClaudeDeck in a desktop session where {service} is
          reachable, then remove and re-add the accounts to re-seal them.
        </Note>
      ) : (
        <Note tone="good" icon="check">
          Encrypted at rest. Tokens are sealed with{' '}
          {probe.encryption && probe.encryption !== 'safeStorage' ? probe.encryption : service} before anything is
          written to <span className="cd-mono">{vaultPath}</span>.
        </Note>
      )}

      <hr className="cd-divider" />

      <h3 className="cd-h3">Where things live</h3>
      <div className="cds-paths">
        {PATH_ROWS.map((row) => {
          const value = state.paths[row.key];
          return (
            <div className="cds-path" key={row.key}>
              <span className="cds-path-body">
                <span className="cds-label">{row.label}</span>
                <span className="cds-path-value">{value}</span>
                <span className="cds-help">{row.help}</span>
              </span>
              <span className="cd-spacer" />
              <IconButton
                icon="external-link"
                label={`Reveal ${row.label} in your file manager`}
                variant="ghost"
                size="sm"
                onClick={() => void api.revealPath(value)}
              />
            </div>
          );
        })}
      </div>
    </Section>
  );
}
