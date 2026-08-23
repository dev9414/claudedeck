/**
 * ClaudeDeck domain contract.
 *
 * This is the single source of truth shared by the main process, the preload
 * bridge, the renderer, and the CLI. Every module in the app is written
 * against these types; nothing here may import from `electron`, `node:*`, or
 * any renderer code, so the file stays loadable from all four contexts.
 */

// ---------------------------------------------------------------------------
// Platform + paths
// ---------------------------------------------------------------------------

export type PlatformKind = 'windows' | 'macos' | 'linux' | 'wsl';

/** Resolved locations of the Claude Code installation we manage. */
export interface ClaudePaths {
  /** `CLAUDE_CONFIG_DIR` or `~/.claude`. */
  configHome: string;
  /** `<configHome>/.config.json` when present, else `~/.claude.json`. */
  globalConfig: string;
  /** `<configHome>/.credentials.json`. */
  credentials: string;
  /** ClaudeDeck's own data root. */
  deckHome: string;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/** The OAuth blob Claude Code persists under `claudeAiOauth`. */
export interface ClaudeOAuth {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt?: number;
  scopes?: string[];
  subscriptionType?: string;
}

/** Full shape of `~/.claude/.credentials.json`. */
export interface ClaudeCredentialFile {
  claudeAiOauth?: ClaudeOAuth;
  [key: string]: unknown;
}

/** The `oauthAccount` object inside the global config. */
export interface ClaudeAccountIdentity {
  emailAddress?: string;
  accountUuid?: string;
  organizationUuid?: string;
  organizationName?: string;
  displayName?: string;
}

export type CredentialKind = 'oauth' | 'setup-token' | 'api-key';

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/** One rate-limit window as ClaudeDeck models it. */
export interface UsageWindow {
  /** Stable key: `5h`, `7d`, `spend`, or a model display name. */
  key: string;
  /** Human label shown in the UI. */
  label: string;
  /** Utilization 0-100. */
  pct: number;
  /** ISO-8601 reset instant, when the API reports one. */
  resetsAt?: string;
}

/** Pay-as-you-go extra-usage credits. A separate axis from the quota windows. */
export interface SpendWindow {
  used: number;
  limit: number;
  pct: number;
  currency: string;
  resetsAt?: string;
}

export interface UsageSnapshot {
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
  /** Per-model weekly windows, keyed by the API's `display_name`. */
  scoped: UsageWindow[];
  spend?: SpendWindow;
  /** Epoch ms when this snapshot was fetched. */
  fetchedAt: number;
}

export type UsageStatus =
  | 'ok'
  | 'unavailable'
  | 'token-expired'
  | 'rate-limited'
  | 'quarantined'
  | 'no-quota';

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export interface Account {
  /** Slot number, 1-based and stable. Also the CLI's positional selector. */
  slot: number;
  email: string;
  /** Optional short handle, usable anywhere a slot number is. */
  alias?: string;
  kind: CredentialKind;
  /** True for the account currently written into Claude Code's store. */
  active: boolean;
  /** Held out of auto-rotation but still a valid explicit switch target. */
  disabled: boolean;
  identity?: ClaudeAccountIdentity;
  usage?: UsageSnapshot;
  usageStatus: UsageStatus;
  /** Last snapshot good enough to display, even if too stale to act on. */
  lastGoodUsage?: UsageSnapshot;
  /** Epoch ms; when the stored access token stops being valid. */
  tokenExpiresAt?: number;
  /** Set when the refresh token is known dead; account is skipped until fixed. */
  quarantinedAt?: number;
  quarantineReason?: string;
  addedAt: number;
}

/** Remaining headroom before the binding window hits 100%. */
export interface Headroom {
  /** `100 - max(pct)` across the windows that gate this account. */
  remaining: number;
  /** Which window is currently binding. */
  bindingWindow: string;
}

// ---------------------------------------------------------------------------
// History + forecasting
// ---------------------------------------------------------------------------

/** One recorded observation, appended on every successful poll. */
export interface HistoryPoint {
  /** Epoch ms. */
  t: number;
  slot: number;
  /** Window key -> utilization at time `t`. */
  windows: Record<string, number>;
}

export interface BurnRate {
  /** Utilization points consumed per hour, least-squares over the window. */
  pctPerHour: number;
  /** How many observations backed the fit. */
  samples: number;
  /** 0-1; low confidence must be rendered as such, never as fact. */
  confidence: number;
}

export interface Forecast {
  windowKey: string;
  burn: BurnRate;
  /** ISO-8601 projected 100% instant, or null when not trending toward it. */
  exhaustionAt: string | null;
  /** True when the projection says the window survives to its own reset. */
  lastsToReset: boolean;
  /** Where usage would sit if spread evenly across the window so far. */
  expectedPct?: number;
  /** True when meaningfully above `expectedPct`. */
  aheadOfPace: boolean;
}

// ---------------------------------------------------------------------------
// Switching
// ---------------------------------------------------------------------------

export type SwitchStrategy = 'next' | 'best' | 'next-available' | 'consume-first';

export type SwitchReason =
  | 'manual'
  | 'threshold'
  | 'pace'
  | 'quarantine'
  | 'startup';

export interface SwitchRequest {
  /** Slot, email, or alias. Omit to rotate per `strategy`. */
  target?: string | number;
  strategy?: SwitchStrategy;
  /** Compute and report the plan without touching disk. */
  dryRun?: boolean;
  /** Re-activate even when the target is already active. */
  force?: boolean;
  reason?: SwitchReason;
}

export interface SwitchResult {
  switched: boolean;
  from?: { slot: number; email: string };
  to?: { slot: number; email: string };
  reason: string;
  dryRun: boolean;
  /** Human-readable list of the file writes a non-dry run would perform. */
  plannedWrites?: string[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Auto-switch engine
// ---------------------------------------------------------------------------

export interface AutoSwitchConfig {
  enabled: boolean;
  /** Utilization percent that triggers a proactive switch. */
  threshold: number;
  /** Seconds between polls at the base cadence. */
  pollIntervalSec: number;
  /** Seconds a switch suppresses the next one. */
  cooldownSec: number;
  /** Extra headroom a candidate must beat the incumbent by, to stop flapping. */
  hysteresisMargin: number;
  strategy: SwitchStrategy;
  /** Per-model weekly windows folded into the decision, by display name. */
  models: string[];
  includeApiKeyAccounts: boolean;
  /** Log decisions without acting. */
  dryRun: boolean;
}

export type AutoSwitchEventKind =
  | 'poll'
  | 'switch'
  | 'no-switch'
  | 'blocked'
  | 'account-quarantined'
  | 'all-exhausted'
  | 'error';

export interface AutoSwitchEvent {
  kind: AutoSwitchEventKind;
  ts: number;
  message: string;
  slot?: number;
  detail?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type ThemeMode = 'light' | 'dark' | 'system';

export interface NotificationConfig {
  enabled: boolean;
  /** Notify when the active account crosses this utilization. */
  warnAtPct: number;
  onSwitch: boolean;
  onQuarantine: boolean;
  onExhausted: boolean;
}

export interface Settings {
  theme: ThemeMode;
  autoswitch: AutoSwitchConfig;
  notifications: NotificationConfig;
  /** Keep the app running in the tray when the window is closed. */
  minimizeToTray: boolean;
  launchAtLogin: boolean;
  /** Retain history points for this many days. */
  historyRetentionDays: number;
  /** Global read-only guard: blocks every disk write the app would make. */
  safeMode: boolean;
  /** Directory -> slot bindings for per-project account selection. */
  directoryMappings: DirectoryMapping[];
}

export interface DirectoryMapping {
  path: string;
  slot: number;
}

// ---------------------------------------------------------------------------
// App state as the renderer sees it
// ---------------------------------------------------------------------------

export interface DeckState {
  accounts: Account[];
  activeSlot: number | null;
  settings: Settings;
  paths: ClaudePaths;
  platform: PlatformKind;
  /** False until Claude Code is detected and at least one account is managed. */
  onboarded: boolean;
  autoSwitchRunning: boolean;
  lastEvents: AutoSwitchEvent[];
  /** True when running against synthetic fixtures instead of a real install. */
  demoMode: boolean;
  version: string;
}

// ---------------------------------------------------------------------------
// Result envelope
// ---------------------------------------------------------------------------

export type Ok<T> = { ok: true; value: T };
export type Err = { ok: false; error: string; code?: string };
export type Result<T> = Ok<T> | Err;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = (error: string, code?: string): Err => ({ ok: false, error, code });
