/**
 * The main <-> renderer contract.
 *
 * `DeckApi` is exactly what `contextBridge` exposes on `window.claudedeck`.
 * Channel names are derived from the method names, so adding a method here and
 * implementing it in `src/main/ipc.ts` is the whole job — there is no separate
 * channel registry to keep in sync.
 */

import type {
  Account,
  AnchorObservation,
  AnchorResult,
  AutoSwitchEvent,
  DeckState,
  DirectoryMapping,
  Forecast,
  HistoryPoint,
  Result,
  SessionPlan,
  Settings,
  SwitchRequest,
  SwitchResult,
  UsageProfile,
} from './types';

export interface AddAccountOptions {
  /** Target slot; the next free slot when omitted. */
  slot?: number;
  alias?: string;
  /** Overwrite an occupied slot. */
  force?: boolean;
}

export interface AddTokenOptions extends AddAccountOptions {
  /** A `sk-ant-oat…` setup token or `sk-ant-api…` managed key. */
  token: string;
  email?: string;
}

export interface HistoryQuery {
  slot?: number;
  /** Epoch ms lower bound, inclusive. */
  since?: number;
  /** Epoch ms upper bound, inclusive. */
  until?: number;
}

export interface DeckApi {
  // --- state -------------------------------------------------------------
  getState(): Promise<DeckState>;
  refreshUsage(slot?: number): Promise<Result<Account[]>>;

  // --- account lifecycle -------------------------------------------------
  /** Capture whatever Claude Code is currently logged in as into a slot. */
  addCurrentAccount(opts?: AddAccountOptions): Promise<Result<Account>>;
  addToken(opts: AddTokenOptions): Promise<Result<Account>>;
  removeAccount(slot: number): Promise<Result<void>>;
  setAlias(slot: number, alias: string | null): Promise<Result<Account>>;
  setDisabled(slot: number, disabled: boolean): Promise<Result<Account>>;
  moveAccount(from: number, to: number): Promise<Result<Account[]>>;

  // --- switching ---------------------------------------------------------
  switchAccount(req: SwitchRequest): Promise<SwitchResult>;
  /** Compute the plan for `req` without writing anything. */
  previewSwitch(req: SwitchRequest): Promise<SwitchResult>;

  // --- auto-switch -------------------------------------------------------
  startAutoSwitch(): Promise<Result<void>>;
  stopAutoSwitch(): Promise<Result<void>>;

  // --- history + forecasting --------------------------------------------
  getHistory(query: HistoryQuery): Promise<HistoryPoint[]>;
  getForecasts(slot: number): Promise<Forecast[]>;

  // --- session window planning ------------------------------------------
  /** The plan for a local day (`YYYY-MM-DD`); today when omitted. */
  getSessionPlan(day?: string): Promise<Result<SessionPlan>>;
  /** The learned hourly usage profile, for the planner's own charts. */
  getUsageProfile(slot?: number): Promise<Result<UsageProfile>>;
  /** The 5-hour anchors currently observed per account. */
  getAnchors(): Promise<AnchorObservation[]>;
  /**
   * Place a 5-hour anchor now by running the Claude Code CLI with a throwaway
   * prompt. Spends a little of that account's own quota — always explicit.
   */
  anchorNow(slot: number): Promise<AnchorResult>;

  // --- settings ----------------------------------------------------------
  getSettings(): Promise<Settings>;
  updateSettings(patch: Partial<Settings>): Promise<Result<Settings>>;
  mapDirectory(path: string, slot: number): Promise<Result<DirectoryMapping[]>>;
  unmapDirectory(path: string): Promise<Result<DirectoryMapping[]>>;
  /** Native folder picker; resolves null when the user cancels. */
  pickDirectory(): Promise<string | null>;

  // --- transfer ----------------------------------------------------------
  exportAccounts(opts: { slot?: number; full?: boolean }): Promise<Result<string>>;
  importAccounts(payload: string, opts: { force?: boolean }): Promise<Result<Account[]>>;

  // --- misc --------------------------------------------------------------
  openExternal(url: string): Promise<void>;
  revealPath(path: string): Promise<void>;

  // --- push channels -----------------------------------------------------
  /** Fires whenever any part of `DeckState` changes. Returns an unsubscribe fn. */
  onStateChanged(cb: (state: DeckState) => void): () => void;
  onAutoSwitchEvent(cb: (event: AutoSwitchEvent) => void): () => void;
}

/** Methods the preload bridge turns into `ipcRenderer.invoke` calls. */
export const INVOKE_CHANNELS = [
  'getState',
  'refreshUsage',
  'addCurrentAccount',
  'addToken',
  'removeAccount',
  'setAlias',
  'setDisabled',
  'moveAccount',
  'switchAccount',
  'previewSwitch',
  'startAutoSwitch',
  'stopAutoSwitch',
  'getHistory',
  'getForecasts',
  'getSessionPlan',
  'getUsageProfile',
  'getAnchors',
  'anchorNow',
  'getSettings',
  'updateSettings',
  'mapDirectory',
  'unmapDirectory',
  'pickDirectory',
  'exportAccounts',
  'importAccounts',
  'openExternal',
  'revealPath',
] as const;

export type InvokeChannel = (typeof INVOKE_CHANNELS)[number];

/** Main -> renderer push channels. */
export const EVENT_CHANNELS = {
  stateChanged: 'deck:state-changed',
  autoSwitchEvent: 'deck:autoswitch-event',
} as const;

declare global {
  interface Window {
    claudedeck: DeckApi;
  }
}
