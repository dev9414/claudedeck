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
  /**
   * Additive: window key -> that window's reset instant (epoch ms) as reported
   * at `t`. Absent on points recorded before the session planner existed, so
   * every reader must tolerate `undefined` and fall back to inferring a
   * boundary from a drop in utilization.
   */
  resets?: Record<string, number>;
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
// Session window planning
// ---------------------------------------------------------------------------

/*
 * The 5-hour window is *anchored by your first message*, not by wall-clock, so
 * the anchor is the one thing about it you actually control. Message at 09:00
 * and your resets land at 14:00, 19:00, ...; message at 11:00 and they land at
 * 16:00, 21:00, ...
 *
 * That matters when a heavy stretch would exhaust a window mid-flight: an
 * anchor placed earlier makes the reset arrive *during* the busy stretch
 * instead of after it. The planner simulates the day and finds the anchor that
 * costs you the fewest blocked minutes.
 *
 * The live anchor is observable rather than assumed: `anchor = resetsAt - 5h`.
 */

/** The 5-hour window's length. The window's identity, not a tunable. */
export const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;

/** Minutes from local midnight, 0..1439. */
export type MinuteOfDay = number;

/** A half-open local-time span. `end` may be <= `start` to mean "past midnight". */
export interface DaySpan {
  start: MinuteOfDay;
  end: MinuteOfDay;
}

/** 0 = Sunday .. 6 = Saturday, matching `Date#getDay`. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface WorkSchedule {
  /** The user's own label, e.g. "Weekdays" or "Saturday". */
  label: string;
  /** Weekdays this schedule applies to. */
  days: Weekday[];
  /** The working day as a whole. */
  work: DaySpan;
  /** The stretch you most need capacity for. Should sit inside `work`. */
  peak: DaySpan;
}

export interface PlannerConfig {
  enabled: boolean;
  /**
   * The user's declared hours. This is the input the whole feature turns on --
   * nothing here is inferred, because only the user knows when their day
   * actually matters. Several schedules may coexist (weekdays vs. a different
   * Saturday); `days` decides which one applies.
   */
  schedules: WorkSchedule[];
  /**
   * True once the user has saved their own hours. While false, `schedules`
   * holds a default the app invented, and every surface must label the plan as
   * running on unconfirmed hours rather than presenting it as the user's own.
   */
  configured: boolean;
  /**
   * How many times heavier a blocked *peak* minute counts than a blocked
   * working minute when scoring a plan.
   */
  peakWeight: number;
  /** Notify when a recommended anchor time arrives. */
  remind: boolean;
  /** Minutes of warning before the anchor. */
  remindLeadMin: number;
  /**
   * Place the anchor automatically by running the Claude Code CLI with a
   * throwaway prompt. Off by default: it sends a real message and spends a
   * small amount of your own quota, so it must be a deliberate choice.
   */
  autoAnchor: boolean;
  /** The prompt used when anchoring. Kept tiny on purpose. */
  anchorPrompt: string;
}

/**
 * Utilization gained per hour of the day, learned from recorded history.
 * This is what makes the plan yours rather than a generic guess.
 */
export interface UsageProfile {
  /** 24 entries: mean utilization points gained during each local hour. */
  hourly: number[];
  /** Observations behind each hour, so thin data can be shown as thin. */
  samples: number[];
  /** 0-1 over the profile as a whole. */
  confidence: number;
  /** Weekdays the observations came from. */
  days: Weekday[];
}

/** One simulated 5-hour window. */
export interface WindowSpan {
  /** Epoch ms. */
  start: number;
  end: number;
  /** Simulated utilization when the window closes. May exceed 100. */
  endPct: number;
  /** Epoch ms the window is predicted to hit 100%, or null if it never does. */
  exhaustedAt: number | null;
  /** Minutes of this window spent blocked inside working hours. */
  blockedMin: number;
}

export interface PlanOutcome {
  /** Epoch ms of the anchoring first message. */
  anchorAt: number;
  windows: WindowSpan[];
  /** Predicted blocked minutes inside working hours. */
  blockedWorkMin: number;
  /** Predicted blocked minutes inside peak hours. */
  blockedPeakMin: number;
  /** `blockedWorkMin + peakWeight * blockedPeakMin`. Lower is better. */
  cost: number;
}

export interface AccountPlan {
  slot: number;
  email: string;
  alias?: string;
  outcome: PlanOutcome;
  /** Why this account got this anchor, in one plain-English line. */
  note: string;
}

export interface SessionPlan {
  /** The local day planned, `YYYY-MM-DD`. */
  day: string;
  schedule: WorkSchedule;
  profile: UsageProfile;
  /** Recommended anchors, staggered so windows tile the working day. */
  accounts: AccountPlan[];
  /** The same day with no deliberate anchoring, for comparison. */
  baseline: PlanOutcome;
  /** Blocked peak minutes the plan avoids versus `baseline`. Can be 0. */
  peakMinutesSaved: number;
  /** The reasoning, shown to the user rather than hidden in a score. */
  rationale: string[];
  /**
   * True when history is too thin for the profile to be worth acting on. The
   * UI must say so instead of presenting a confident-looking schedule.
   */
  lowConfidence: boolean;
  /**
   * True when the plan ran against default hours the user has never confirmed.
   * Distinct from `lowConfidence`: the history can be excellent and the hours
   * still be a guess. Both must be surfaced separately.
   */
  usingDefaultSchedule: boolean;
}

/** A 5-hour anchor as actually observed, derived from `resetsAt - 5h`. */
export interface AnchorObservation {
  slot: number;
  /** Epoch ms. */
  anchorAt: number;
  /** Epoch ms of the snapshot it came from. */
  observedAt: number;
}

export interface AnchorResult {
  ok: boolean;
  slot: number;
  /** Epoch ms the window now starts, once known. */
  anchoredAt?: number;
  /** Epoch ms the resulting window will reset. */
  resetsAt?: number;
  /** What was run, for the log. Never contains a token. */
  command?: string;
  error?: string;
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
  /** Session window planning: work hours and how anchors are placed. */
  planner: PlannerConfig;
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
