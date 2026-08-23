/**
 * `claudedeck` — the headless half of the app.
 *
 * Everything the GUI can do to accounts is reachable from a terminal, over the
 * exact same service layer the IPC handlers call, so there is one behaviour and
 * one set of bugs rather than two. This entry ships inside the Electron main
 * bundle but must never require a window: only the `gui` command touches
 * Electron, and it does so through a lazy import.
 *
 * Output discipline: `--json` puts exactly one machine-readable object on
 * stdout; every human notice, warning and error goes to stderr, so
 * `claudedeck list --json | jq` is always safe to pipe.
 */

import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

import { INVOKE_CHANNELS, type DeckApi, type InvokeChannel } from '../shared/ipc';
import type {
  Account,
  AutoSwitchEvent,
  DeckState,
  Forecast,
  HistoryPoint,
  Result,
  SwitchReason,
  SwitchResult,
  SwitchStrategy,
  UsageWindow,
} from '../shared/types';
import { createServices } from '../main/services';
import { createDemoServices, isDemoMode } from '../main/demo';

/** Bumped whenever the shape of any `--json` document changes incompatibly. */
const SCHEMA_VERSION = 1;

/** Exit codes are part of the CLI's contract with scripts. */
const EXIT = {
  ok: 0,
  error: 1,
  nothingToDo: 2,
  blocked: 3,
} as const;

/** A snapshot older than this is shown, but flagged as not worth acting on. */
const STALE_AFTER_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** An expected failure with a message meant for a human, not a stack trace. */
class CliError extends Error {
  readonly exitCode: number;
  readonly code: string | undefined;

  constructor(message: string, opts: { exitCode?: number; code?: string } = {}) {
    super(message);
    this.name = 'CliError';
    this.exitCode = opts.exitCode ?? EXIT.error;
    this.code = opts.code;
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

// ---------------------------------------------------------------------------
// Argument parsing (hand-rolled: the project ships zero runtime dependencies)
// ---------------------------------------------------------------------------

/** Flags that consume the next token when not written as `--flag=value`. */
const VALUE_FLAGS = new Set([
  'slot',
  'alias',
  'strategy',
  'threshold',
  'since',
  'until',
  'token',
  'email',
  'reason',
]);

const SHORT_FLAGS: Record<string, string> = {
  '-h': 'help',
  '-v': 'version',
  '-j': 'json',
  '-n': 'dry-run',
  '-f': 'force',
  '-s': 'slot',
  '-a': 'alias',
};

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  let literal = false;

  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i] ?? '';

    if (literal) {
      positionals.push(raw);
      continue;
    }
    if (raw === '--') {
      literal = true;
      continue;
    }

    let name: string | null = null;
    let inlineValue: string | null = null;

    if (raw.startsWith('--')) {
      const body = raw.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        name = body.slice(0, eq);
        inlineValue = body.slice(eq + 1);
      } else {
        name = body;
      }
    } else if (raw.length > 1 && raw.startsWith('-')) {
      const mapped = SHORT_FLAGS[raw];
      if (mapped === undefined) throw new CliError(`unknown option: ${raw}`);
      name = mapped;
    }

    if (name === null) {
      positionals.push(raw);
      continue;
    }
    if (name.length === 0) throw new CliError(`unknown option: ${raw}`);

    if (inlineValue !== null) {
      flags.set(name, inlineValue);
      continue;
    }
    if (VALUE_FLAGS.has(name)) {
      const next = argv[i + 1];
      // A leading `-` only disqualifies a value when it is not a number, so
      // `--threshold -1` still reaches the range check with a real message.
      if (next === undefined || (next.startsWith('-') && Number.isNaN(Number(next)))) {
        throw new CliError(`option --${name} requires a value`);
      }
      flags.set(name, next);
      i += 1;
      continue;
    }
    flags.set(name, true);
  }

  const command = positionals.shift() ?? '';
  return { command, positionals, flags };
}

function flagStr(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

function flagBool(args: ParsedArgs, name: string): boolean {
  const value = args.flags.get(name);
  if (value === undefined) return false;
  return value !== 'false' && value !== '0';
}

function flagNum(args: ParsedArgs, name: string): number | undefined {
  const raw = flagStr(args, name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new CliError(`option --${name} expects a number, got "${raw}"`);
  return parsed;
}

/** Rejects typos instead of silently ignoring them. */
function assertFlags(args: ParsedArgs, allowed: readonly string[]): void {
  const permitted = new Set([...allowed, 'help', 'json']);
  for (const name of args.flags.keys()) {
    if (!permitted.has(name)) throw new CliError(`unknown option --${name} for this command`);
  }
}

const STRATEGIES: readonly SwitchStrategy[] = ['next', 'best', 'next-available', 'consume-first'];

function readStrategy(args: ParsedArgs): SwitchStrategy | undefined {
  const raw = flagStr(args, 'strategy');
  if (raw === undefined) return undefined;
  const match = STRATEGIES.find((s) => s === raw);
  if (match === undefined) {
    throw new CliError(`unknown strategy "${raw}" (expected: ${STRATEGIES.join(', ')})`);
  }
  return match;
}

function readThreshold(args: ParsedArgs): number | undefined {
  const value = flagNum(args, 'threshold');
  if (value === undefined) return undefined;
  if (value < 0 || value > 100) throw new CliError('--threshold must be between 0 and 100');
  return value;
}

const DURATION_UNITS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** `7d`, `36h`, `90m`, or a bare ISO date / epoch-ms. Returns epoch ms. */
function parseSince(raw: string, now: number): number {
  const relative = /^(\d+(?:\.\d+)?)([smhdw])$/i.exec(raw.trim());
  if (relative) {
    const amount = Number(relative[1]);
    const unit = DURATION_UNITS[(relative[2] ?? 'd').toLowerCase()] ?? DURATION_UNITS['d'] ?? 0;
    return now - amount * unit;
  }
  if (/^\d{10,}$/.test(raw)) return Number(raw);
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    throw new CliError(`cannot read "${raw}" as a duration (try 7d, 12h) or a date`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Output primitives
// ---------------------------------------------------------------------------

/**
 * Colour is opt-out via NO_COLOR (any non-empty value, per the informal
 * standard) and off by default when stdout is redirected, so captured output
 * never carries escape sequences. FORCE_COLOR wins for CI logs that do render.
 */
const COLOR_ON = ((): boolean => {
  const noColor = process.env['NO_COLOR'];
  if (noColor !== undefined && noColor !== '') return false;
  const force = process.env['FORCE_COLOR'];
  if (force !== undefined && force !== '' && force !== '0') return true;
  if (process.env['TERM'] === 'dumb') return false;
  return process.stdout.isTTY === true;
})();

/**
 * Legacy Windows consoles still default to a codepage without block glyphs, so
 * bars degrade to ASCII unless we can see a terminal known to cope.
 */
const UNICODE_ON =
  process.platform !== 'win32' ||
  Boolean(process.env['WT_SESSION']) ||
  process.env['TERM_PROGRAM'] === 'vscode' ||
  Boolean(process.env['ConEmuANSI']);

/** Marks the active row; shares the ASCII fallback with the usage bars. */
const ACTIVE_MARK = UNICODE_ON ? '●' : '*';

/** Built from a char code so no raw escape byte ever sits in the source file. */
const ESC = String.fromCharCode(27);

const ANSI = {
  reset: `${ESC}[0m`,
  dim: `${ESC}[2m`,
  bold: `${ESC}[1m`,
  red: `${ESC}[31m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
  cyan: `${ESC}[36m`,
} as const;

type ColorName = Exclude<keyof typeof ANSI, 'reset'>;

function paint(text: string, color: ColorName): string {
  return COLOR_ON ? `${ANSI[color]}${text}${ANSI.reset}` : text;
}

const ANSI_PATTERN = new RegExp(`${ESC}\[[0-9;]*m`, 'g');

/** Column widths must count glyphs, not escape bytes. */
function visibleWidth(text: string): number {
  return text.replace(ANSI_PATTERN, '').length;
}

function padCell(text: string, width: number, align: 'left' | 'right'): string {
  const gap = Math.max(0, width - visibleWidth(text));
  return align === 'right' ? ' '.repeat(gap) + text : text + ' '.repeat(gap);
}

interface Column {
  header: string;
  align?: 'left' | 'right';
}

function renderTable(columns: readonly Column[], rows: readonly (readonly string[])[]): string[] {
  const widths = columns.map((column, index) => {
    let width = visibleWidth(column.header);
    for (const row of rows) width = Math.max(width, visibleWidth(row[index] ?? ''));
    return width;
  });

  const line = (cells: readonly string[]): string =>
    columns
      .map((column, index) => padCell(cells[index] ?? '', widths[index] ?? 0, column.align ?? 'left'))
      .join('  ')
      .trimEnd();

  const rendered = [paint(line(columns.map((c) => c.header)), 'dim')];
  for (const row of rows) rendered.push(line(row));
  return rendered;
}

const BAR_WIDTH = 8;

function usageBar(pct: number | null): string {
  if (pct === null) return (UNICODE_ON ? '·' : '.').repeat(BAR_WIDTH);
  const clamped = Math.min(100, Math.max(0, pct));
  const filled = Math.min(BAR_WIDTH, Math.round((clamped / 100) * BAR_WIDTH));
  const full = UNICODE_ON ? '█' : '#';
  const empty = UNICODE_ON ? '░' : '.';
  return paint(full.repeat(filled) + empty.repeat(BAR_WIDTH - filled), pressureColor(clamped));
}

function pressureColor(pct: number): ColorName {
  if (pct >= 90) return 'red';
  if (pct >= 70) return 'yellow';
  return 'green';
}

function formatPct(pct: number | null): string {
  return pct === null ? '  --' : `${Math.round(pct)}%`.padStart(4, ' ');
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return '--';
  if (ms <= 0) return 'now';
  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return '<1m';
}

function formatEta(isoOrMs: string | number | undefined, now: number): string {
  if (isoOrMs === undefined) return '--';
  const at = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs);
  if (Number.isNaN(at)) return '--';
  return formatDuration(at - now);
}

function formatClock(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// Output sinks
// ---------------------------------------------------------------------------

/** Primary output. Carries the JSON document in `--json` mode, nothing else. */
function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** Anything a human reads while a machine reads stdout. */
function note(line: string): void {
  process.stderr.write(`${line}\n`);
}

function warn(line: string): void {
  note(`${paint('warning', 'yellow')}: ${line}`);
}

function fail(line: string): void {
  note(`${paint('error', 'red')}: ${line}`);
}

/** The single stdout document every `--json` command produces. */
function emitJson(command: string, body: Record<string, unknown>): void {
  out(JSON.stringify({ schemaVersion: SCHEMA_VERSION, command, ...body }));
}

// ---------------------------------------------------------------------------
// Domain helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function displayName(account: Account): string {
  return account.alias ?? account.email;
}

/** Freshest snapshot worth showing, plus whether it is too old to act on. */
function latestUsage(account: Account, now: number): { snapshot: Account['usage']; stale: boolean } {
  const snapshot = account.usage ?? account.lastGoodUsage;
  if (snapshot === undefined) return { snapshot: undefined, stale: false };
  return { snapshot, stale: now - snapshot.fetchedAt > STALE_AFTER_MS };
}

/** Every window that can gate this account, honouring the configured models. */
function gatingWindows(account: Account, models: readonly string[], now: number): UsageWindow[] {
  const { snapshot } = latestUsage(account, now);
  if (snapshot === undefined) return [];
  const wanted = new Set(models.map((m) => m.toLowerCase()));
  const windows: UsageWindow[] = [];
  if (snapshot.fiveHour) windows.push(snapshot.fiveHour);
  if (snapshot.sevenDay) windows.push(snapshot.sevenDay);
  for (const scoped of snapshot.scoped) {
    if (wanted.has(scoped.key.toLowerCase()) || wanted.has(scoped.label.toLowerCase())) {
      windows.push(scoped);
    }
  }
  return windows;
}

interface Pressure {
  pct: number;
  window: string;
}

/** The binding window: the one closest to cutting this account off. */
function pressureOf(account: Account, models: readonly string[], now: number): Pressure | null {
  let worst: Pressure | null = null;
  for (const window of gatingWindows(account, models, now)) {
    if (worst === null || window.pct > worst.pct) worst = { pct: window.pct, window: window.key };
  }
  return worst;
}

/** Slot number, email, or alias — matched case-insensitively. */
function resolveTarget(accounts: readonly Account[], target: string): Account {
  const needle = target.trim();
  if (needle.length === 0) throw new CliError('expected an account (slot, email, or alias)');

  if (/^\d+$/.test(needle)) {
    const bySlot = accounts.find((a) => a.slot === Number(needle));
    if (bySlot) return bySlot;
    throw new CliError(`no account in slot ${needle}`, { code: 'not-found' });
  }

  const lower = needle.toLowerCase();
  const matches = accounts.filter(
    (a) => a.email.toLowerCase() === lower || (a.alias ?? '').toLowerCase() === lower,
  );
  const first = matches[0];
  if (first === undefined) {
    const known = accounts.map((a) => `${a.slot}:${displayName(a)}`).join(', ');
    throw new CliError(`no account matches "${needle}"${known.length > 0 ? ` (have ${known})` : ''}`, {
      code: 'not-found',
    });
  }
  if (matches.length > 1) {
    throw new CliError(
      `"${needle}" matches slots ${matches.map((a) => a.slot).join(', ')} — use the slot number`,
      { code: 'ambiguous' },
    );
  }
  return first;
}

function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  throw new CliError(result.error, { code: result.code });
}

function activeAccount(state: DeckState): Account | undefined {
  return (
    state.accounts.find((a) => a.active) ??
    (state.activeSlot === null
      ? undefined
      : state.accounts.find((a) => a.slot === state.activeSlot))
  );
}

/** Slot from `--slot`, else the active one, else an error naming the options. */
function slotFrom(args: ParsedArgs, state: DeckState): number {
  const explicit = flagNum(args, 'slot');
  if (explicit !== undefined) return resolveTarget(state.accounts, String(explicit)).slot;
  const positional = args.positionals[0];
  if (positional !== undefined) return resolveTarget(state.accounts, positional).slot;
  const active = activeAccount(state);
  if (active) return active.slot;
  throw new CliError('no active account — pass --slot N');
}

// ---------------------------------------------------------------------------
// Service layer
// ---------------------------------------------------------------------------

/**
 * The request/response half of `DeckApi`, minus the three calls that only make
 * sense with a window attached. The CLI has no renderer to push to and no
 * folder picker to open.
 */
type CliApi = Omit<Pick<DeckApi, InvokeChannel>, 'pickDirectory' | 'openExternal' | 'revealPath'>;

/** Optional push hook: present when the services own a running auto-switcher. */
type EventHook = (cb: (event: AutoSwitchEvent) => void) => () => void;

interface CliServices {
  api: CliApi;
  onAutoSwitchEvent: EventHook | null;
  dispose: () => Promise<void>;
}

/** Only these need to exist; the rest of `DeckApi` is renderer-only. */
const REQUIRED_METHODS: readonly InvokeChannel[] = [
  'getState',
  'refreshUsage',
  'addCurrentAccount',
  'removeAccount',
  'setAlias',
  'setDisabled',
  'switchAccount',
  'previewSwitch',
  'getHistory',
  'getForecasts',
  'getSettings',
  'exportAccounts',
  'importAccounts',
];

/**
 * Adapts whatever `createServices()` hands back into the surface the CLI uses.
 * The factory is shared with the GUI and evolves on its own schedule, so the
 * shape is checked structurally once, here, with an error that names the drift
 * instead of a `TypeError` from three frames deep.
 */
/**
 * Resolves once Electron's `app` is ready, or immediately outside Electron.
 * Imported lazily so a plain-Node run never touches the module at all.
 */
async function whenElectronReady(): Promise<void> {
  if (!UNDER_ELECTRON) return;
  const { app } = await import('electron');
  if (!app) return;
  if (!app.isReady()) await app.whenReady();
}

async function openServices(): Promise<CliServices> {
  let created: unknown;
  try {
    // Demo mode is honoured here as well as in the GUI: the CLI is the easiest
    // way to exercise the engine, and it should not need a real login to do it.
    if (isDemoMode()) {
      created = createDemoServices();
    } else {
      // Inside the Electron host, safeStorage is unusable until app-ready.
      await whenElectronReady();
      created = await createServices();
    }
  } catch (error) {
    throw new CliError(`could not start ClaudeDeck services: ${messageOf(error)}`, {
      code: 'services-unavailable',
    });
  }

  if (!isRecord(created)) throw new CliError('createServices() did not return an object');

  // The factory may expose the API under `api` or be the API itself.
  const holder = isRecord(created['api']) ? (created['api'] as Record<string, unknown>) : created;

  const missing = REQUIRED_METHODS.filter((name) => typeof holder[name] !== 'function');
  if (missing.length > 0) {
    throw new CliError(
      `the services factory is missing ${missing.join(', ')} — main/services and the CLI have drifted`,
      { code: 'contract-drift' },
    );
  }

  const hook = created['onAutoSwitchEvent'];
  const dispose = created['dispose'] ?? created['close'];

  return {
    // Methods are called through this object so any `this` binding survives.
    api: holder as unknown as CliApi,
    onAutoSwitchEvent: typeof hook === 'function' ? (hook as EventHook).bind(created) : null,
    dispose: async () => {
      if (typeof dispose !== 'function') return;
      try {
        await (dispose as () => unknown).call(created);
      } catch (error) {
        warn(`services did not shut down cleanly: ${messageOf(error)}`);
      }
    },
  };
}

/** Refresh live usage, downgrading a failure to a warning: cache still works. */
async function refreshQuietly(api: CliApi, slot?: number): Promise<string[]> {
  const problems: string[] = [];
  try {
    const result = await api.refreshUsage(slot);
    if (!result.ok) problems.push(`usage refresh failed: ${result.error}`);
  } catch (error) {
    problems.push(`usage refresh failed: ${messageOf(error)}`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Serialisation for --json
// ---------------------------------------------------------------------------

function windowJson(window: UsageWindow | undefined, now: number): Record<string, unknown> | null {
  if (window === undefined) return null;
  const resetsAt = window.resetsAt === undefined ? NaN : Date.parse(window.resetsAt);
  return {
    key: window.key,
    label: window.label,
    pct: window.pct,
    resetsAt: window.resetsAt ?? null,
    resetsInSec: Number.isNaN(resetsAt) ? null : Math.max(0, Math.round((resetsAt - now) / 1000)),
  };
}

function accountJson(account: Account, models: readonly string[], now: number): Record<string, unknown> {
  const { snapshot, stale } = latestUsage(account, now);
  const pressure = pressureOf(account, models, now);
  return {
    slot: account.slot,
    email: account.email,
    alias: account.alias ?? null,
    kind: account.kind,
    active: account.active,
    disabled: account.disabled,
    usageStatus: account.usageStatus,
    usage:
      snapshot === undefined
        ? null
        : {
            fiveHour: windowJson(snapshot.fiveHour, now),
            sevenDay: windowJson(snapshot.sevenDay, now),
            scoped: snapshot.scoped.map((w) => windowJson(w, now)),
            spend: snapshot.spend ?? null,
            fetchedAt: snapshot.fetchedAt,
            stale,
          },
    headroom:
      pressure === null
        ? null
        : { remaining: Math.max(0, 100 - pressure.pct), bindingWindow: pressure.window },
    tokenExpiresAt: account.tokenExpiresAt ?? null,
    quarantinedAt: account.quarantinedAt ?? null,
    quarantineReason: account.quarantineReason ?? null,
    identity: account.identity ?? null,
    addedAt: account.addedAt,
  };
}

function switchJson(result: SwitchResult, exitCode: number): Record<string, unknown> {
  return {
    ok: result.error === undefined,
    switched: result.switched,
    dryRun: result.dryRun,
    from: result.from ?? null,
    to: result.to ?? null,
    reason: result.reason,
    plannedWrites: result.plannedWrites ?? [],
    error: result.error ?? null,
    exitCode,
  };
}

/**
 * Turns a switch outcome into an exit code scripts can branch on:
 * 0 moved, 1 failed, 2 nothing to do, 3 no viable target.
 */
function switchExitCode(result: SwitchResult): number {
  if (result.error !== undefined) return EXIT.error;
  if (result.switched) return EXIT.ok;
  const sameAccount =
    result.to !== undefined && result.from !== undefined && result.to.slot === result.from.slot;
  if (sameAccount || /already/i.test(result.reason)) return EXIT.nothingToDo;
  // No destination at all means the rotation had nowhere to go.
  return result.to === undefined ? EXIT.blocked : EXIT.nothingToDo;
}

function describeSwitch(result: SwitchResult): string {
  if (result.error !== undefined) return `switch failed: ${result.error}`;
  if (!result.switched) return `no switch: ${result.reason}`;
  const from = result.from ? `slot ${result.from.slot} (${result.from.email})` : 'nothing';
  const to = result.to ? `slot ${result.to.slot} (${result.to.email})` : 'no candidate';
  return `${result.dryRun ? 'would switch' : 'switched'} ${from} -> ${to}`;
}

function statusLabel(account: Account, stale: boolean): string {
  if (account.quarantinedAt !== undefined) return paint('quarantined', 'red');
  if (account.disabled) return paint('disabled', 'dim');
  switch (account.usageStatus) {
    case 'rate-limited':
      return paint('rate-limited', 'red');
    case 'token-expired':
      return paint('token-expired', 'yellow');
    case 'unavailable':
      return paint('unavailable', 'yellow');
    case 'no-quota':
      return paint('no-quota', 'dim');
    case 'quarantined':
      return paint('quarantined', 'red');
    default:
      return stale ? paint('ok (stale)', 'yellow') : paint('ok', 'green');
  }
}

// ---------------------------------------------------------------------------
// Commands: read-only views
// ---------------------------------------------------------------------------

async function cmdList(services: CliServices, args: ParsedArgs): Promise<number> {
  assertFlags(args, ['no-refresh']);
  const json = flagBool(args, 'json');
  const now = Date.now();

  const problems = flagBool(args, 'no-refresh') ? [] : await refreshQuietly(services.api);
  const state = await services.api.getState();
  const models = state.settings.autoswitch.models;

  if (json) {
    emitJson('list', {
      ok: true,
      activeSlot: state.activeSlot,
      demoMode: state.demoMode,
      warnings: problems,
      accounts: state.accounts.map((a) => accountJson(a, models, now)),
    });
    for (const problem of problems) warn(problem);
    return EXIT.ok;
  }

  for (const problem of problems) warn(problem);
  if (state.accounts.length === 0) {
    note('no accounts yet - run "claudedeck add" while Claude Code is logged in');
    return EXIT.ok;
  }

  const showAlias = state.accounts.some((a) => a.alias !== undefined && a.alias.length > 0);
  const columns: Column[] = [
    { header: '' },
    { header: 'SLOT', align: 'right' },
    { header: 'ACCOUNT' },
    ...(showAlias ? [{ header: 'ALIAS' }] : []),
    { header: 'KIND' },
    { header: '5H' },
    { header: '', align: 'right' },
    { header: 'RESETS' },
    { header: '7D' },
    { header: '', align: 'right' },
    { header: 'RESETS' },
    { header: 'STATUS' },
  ];

  let anyStale = false;
  const rows = state.accounts.map((account) => {
    const { snapshot, stale } = latestUsage(account, now);
    anyStale = anyStale || stale;
    const five = snapshot?.fiveHour;
    const seven = snapshot?.sevenDay;
    return [
      account.active ? paint(ACTIVE_MARK, 'green') : ' ',
      String(account.slot),
      account.disabled ? paint(account.email, 'dim') : account.email,
      ...(showAlias ? [account.alias ?? '-'] : []),
      account.kind,
      usageBar(five?.pct ?? null),
      formatPct(five?.pct ?? null),
      formatEta(five?.resetsAt, now),
      usageBar(seven?.pct ?? null),
      formatPct(seven?.pct ?? null),
      formatEta(seven?.resetsAt, now),
      statusLabel(account, stale),
    ];
  });

  for (const line of renderTable(columns, rows)) out(line);
  if (anyStale) warn('some usage numbers are stale - a refresh did not reach the API');
  if (state.demoMode) note(paint('demo mode: these are synthetic fixtures', 'cyan'));
  return EXIT.ok;
}

async function cmdStatus(services: CliServices, args: ParsedArgs): Promise<number> {
  assertFlags(args, ['no-refresh']);
  const json = flagBool(args, 'json');
  const now = Date.now();

  const problems = flagBool(args, 'no-refresh') ? [] : await refreshQuietly(services.api);
  const state = await services.api.getState();
  const models = state.settings.autoswitch.models;
  const active = activeAccount(state);

  if (json) {
    emitJson('status', {
      ok: true,
      active: active === undefined ? null : accountJson(active, models, now),
      activeSlot: state.activeSlot,
      accountCount: state.accounts.length,
      autoSwitchRunning: state.autoSwitchRunning,
      autoswitch: state.settings.autoswitch,
      onboarded: state.onboarded,
      demoMode: state.demoMode,
      safeMode: state.settings.safeMode,
      platform: state.platform,
      paths: state.paths,
      version: state.version,
      warnings: problems,
    });
    for (const problem of problems) warn(problem);
    return EXIT.ok;
  }

  for (const problem of problems) warn(problem);
  if (active === undefined) {
    note('no active account');
    note(state.accounts.length === 0 ? 'run "claudedeck add" to manage one' : 'run "claudedeck switch <target>"');
    return EXIT.ok;
  }

  const rows: [string, string][] = [];
  rows.push(['active', `${paint(ACTIVE_MARK, 'green')} slot ${active.slot}  ${displayName(active)}`]);
  if (active.alias !== undefined) rows.push(['email', active.email]);
  const org = active.identity?.organizationName;
  rows.push(['kind', org === undefined ? active.kind : `${active.kind} (${org})`]);

  const { snapshot, stale } = latestUsage(active, now);
  const windows: UsageWindow[] = [];
  if (snapshot?.fiveHour) windows.push(snapshot.fiveHour);
  if (snapshot?.sevenDay) windows.push(snapshot.sevenDay);
  for (const scoped of snapshot?.scoped ?? []) windows.push(scoped);

  for (const window of windows) {
    const eta = window.resetsAt === undefined ? '' : `resets in ${formatEta(window.resetsAt, now)}`;
    rows.push([window.label, `${usageBar(window.pct)} ${formatPct(window.pct)}   ${eta}`]);
  }
  if (windows.length === 0) rows.push(['usage', 'not available for this account']);

  const spend = snapshot?.spend;
  if (spend) {
    const amount = `${spend.used.toFixed(2)} / ${spend.limit.toFixed(2)} ${spend.currency}`;
    rows.push(['spend', `${usageBar(spend.pct)} ${formatPct(spend.pct)}   ${amount}`]);
  }
  if (active.tokenExpiresAt !== undefined) {
    rows.push(['token', `expires in ${formatEta(active.tokenExpiresAt, now)}`]);
  }
  if (active.quarantinedAt !== undefined) {
    rows.push(['quarantine', paint(active.quarantineReason ?? 'refresh token rejected', 'red')]);
  }
  if (snapshot) {
    rows.push(['polled', formatClock(snapshot.fetchedAt) + (stale ? paint('  (stale)', 'yellow') : '')]);
  }

  const auto = state.settings.autoswitch;
  const running = state.autoSwitchRunning ? paint('running', 'green') : paint('stopped', 'dim');
  rows.push([
    'auto',
    `${running}  threshold ${auto.threshold}%  strategy ${auto.strategy}${auto.dryRun ? '  dry-run' : ''}`,
  ]);
  rows.push(['config', state.paths.configHome]);
  if (state.settings.safeMode) rows.push(['safe mode', paint('on - every write is refused', 'yellow')]);
  if (state.demoMode) rows.push(['demo', paint('synthetic fixtures', 'cyan')]);

  const keyWidth = rows.reduce((width, [key]) => Math.max(width, key.length), 0);
  for (const [key, value] of rows) out(`${paint(padCell(key, keyWidth, 'left'), 'dim')}  ${value}`);
  return EXIT.ok;
}

// ---------------------------------------------------------------------------
// Commands: switching
// ---------------------------------------------------------------------------

const REASONS: readonly SwitchReason[] = ['manual', 'threshold', 'pace', 'quarantine', 'startup'];

async function cmdSwitch(services: CliServices, args: ParsedArgs): Promise<number> {
  assertFlags(args, ['strategy', 'dry-run', 'force', 'reason', 'slot']);
  const json = flagBool(args, 'json');
  const dryRun = flagBool(args, 'dry-run');

  const rawTarget = args.positionals[0] ?? flagStr(args, 'slot');
  const strategy = readStrategy(args);
  const reasonFlag = flagStr(args, 'reason');
  const reason = REASONS.find((r) => r === reasonFlag) ?? 'manual';
  if (reasonFlag !== undefined && reason !== reasonFlag) {
    throw new CliError(`unknown reason "${reasonFlag}" (expected: ${REASONS.join(', ')})`);
  }

  // Resolving here rather than in the service keeps alias/email lookup and its
  // error messages identical to every other command.
  let target: string | number | undefined;
  if (rawTarget !== undefined) {
    const state = await services.api.getState();
    target = resolveTarget(state.accounts, rawTarget).slot;
  } else if (strategy === undefined) {
    throw new CliError('nothing to switch to - pass a target or --strategy best|next|next-available|consume-first');
  }

  const request = { target, strategy, dryRun, force: flagBool(args, 'force'), reason };
  const result = dryRun
    ? await services.api.previewSwitch(request)
    : await services.api.switchAccount(request);
  const code = switchExitCode(result);

  if (json) {
    emitJson('switch', switchJson(result, code));
  } else if (result.error !== undefined) {
    fail(describeSwitch(result));
  } else {
    out(describeSwitch(result));
    for (const write of result.plannedWrites ?? []) note(paint(`  would write ${write}`, 'dim'));
  }
  return code;
}

// ---------------------------------------------------------------------------
// Commands: account lifecycle
// ---------------------------------------------------------------------------

async function cmdAdd(services: CliServices, args: ParsedArgs): Promise<number> {
  assertFlags(args, ['slot', 'alias', 'force', 'token', 'email']);
  const slot = flagNum(args, 'slot');
  const alias = flagStr(args, 'alias');
  const force = flagBool(args, 'force');
  const token = flagStr(args, 'token');

  // A token never reaches stdout, stderr, or the JSON document - only the
  // service that stores it sees the value.
  const account = token === undefined
    ? unwrap(await services.api.addCurrentAccount({ slot, alias, force }))
    : unwrap(await services.api.addToken({ token, slot, alias, force, email: flagStr(args, 'email') }));

  if (flagBool(args, 'json')) {
    emitJson('add', { ok: true, account: accountRefJson(account) });
  } else {
    out(`added slot ${account.slot}  ${displayName(account)}  (${account.kind})`);
  }
  return EXIT.ok;
}

function accountRefJson(account: Account): Record<string, unknown> {
  return {
    slot: account.slot,
    email: account.email,
    alias: account.alias ?? null,
    kind: account.kind,
    active: account.active,
    disabled: account.disabled,
  };
}

async function cmdRemove(services: CliServices, args: ParsedArgs): Promise<number> {
  assertFlags(args, ['slot']);
  const state = await services.api.getState();
  const raw = args.positionals[0] ?? flagStr(args, 'slot');
  if (raw === undefined) throw new CliError('usage: claudedeck remove <slot|email|alias>');
  const account = resolveTarget(state.accounts, raw);

  unwrap(await services.api.removeAccount(account.slot));
  if (flagBool(args, 'json')) {
    emitJson('remove', { ok: true, removed: accountRefJson(account) });
  } else {
    out(`removed slot ${account.slot}  ${displayName(account)}`);
    if (account.active) warn('that account was active - Claude Code still holds its credentials');
  }
  return EXIT.ok;
}

async function cmdAlias(services: CliServices, args: ParsedArgs): Promise<number> {
  assertFlags(args, ['unset', 'slot', 'alias']);
  const state = await services.api.getState();
  const raw = args.positionals[0] ?? flagStr(args, 'slot');
  if (raw === undefined) throw new CliError('usage: claudedeck alias <target> <alias|--unset>');
  const account = resolveTarget(state.accounts, raw);

  const unset = flagBool(args, 'unset');
  const next = args.positionals[1] ?? flagStr(args, 'alias');
  if (!unset && next === undefined) {
    throw new CliError('usage: claudedeck alias <target> <alias|--unset>');
  }
  if (unset && next !== undefined) throw new CliError('pass an alias or --unset, not both');

  const updated = unwrap(await services.api.setAlias(account.slot, unset ? null : (next ?? null)));
  if (flagBool(args, 'json')) {
    emitJson('alias', { ok: true, account: accountRefJson(updated) });
  } else {
    out(
      updated.alias === undefined
        ? `cleared the alias on slot ${updated.slot}`
        : `slot ${updated.slot} is now "${updated.alias}"`,
    );
  }
  return EXIT.ok;
}

async function cmdSetDisabled(
  services: CliServices,
  args: ParsedArgs,
  disabled: boolean,
): Promise<number> {
  assertFlags(args, ['slot']);
  const verb = disabled ? 'disable' : 'enable';
  const state = await services.api.getState();
  const raw = args.positionals[0] ?? flagStr(args, 'slot');
  if (raw === undefined) throw new CliError(`usage: claudedeck ${verb} <slot|email|alias>`);
  const account = resolveTarget(state.accounts, raw);

  const updated = unwrap(await services.api.setDisabled(account.slot, disabled));
  if (flagBool(args, 'json')) {
    emitJson(verb, { ok: true, account: accountRefJson(updated) });
  } else {
    out(
      disabled
        ? `slot ${updated.slot} is held out of auto-rotation (still an explicit switch target)`
        : `slot ${updated.slot} is back in auto-rotation`,
    );
  }
  return EXIT.ok;
}

// ---------------------------------------------------------------------------
// Commands: auto-switch
// ---------------------------------------------------------------------------

interface AutoOptions {
  threshold: number | undefined;
  strategy: SwitchStrategy | undefined;
  dryRun: boolean;
}

interface AutoOutcome {
  event: AutoSwitchEvent;
  exitCode: number;
  threshold: number;
  active: { slot: number; email: string; pct: number | null; window: string | null } | null;
  result: SwitchResult | null;
  warnings: string[];
}

function autoEvent(
  kind: AutoSwitchEvent['kind'],
  message: string,
  extra: { slot?: number; detail?: Record<string, unknown> } = {},
): AutoSwitchEvent {
  return { kind, ts: Date.now(), message, slot: extra.slot, detail: extra.detail };
}

/**
 * One evaluation of the rotation rule: refresh, look at the binding window of
 * the active account, and move only when it is at or past the threshold. The
 * ranking of candidates stays in the service - this decides *whether*, not
 * *where*.
 */
async function runAutoOnce(services: CliServices, opts: AutoOptions): Promise<AutoOutcome> {
  const warnings = await refreshQuietly(services.api);
  const state = await services.api.getState();
  const now = Date.now();
  const threshold = opts.threshold ?? state.settings.autoswitch.threshold;
  const strategy = opts.strategy ?? state.settings.autoswitch.strategy;
  const models = state.settings.autoswitch.models;
  const active = activeAccount(state);

  const base = { threshold, warnings, result: null } as const;

  if (state.accounts.length === 0) {
    return {
      ...base,
      active: null,
      event: autoEvent('error', 'no accounts are managed'),
      exitCode: EXIT.error,
    };
  }

  let reason: SwitchReason = 'threshold';
  let trigger: string;

  if (active === undefined) {
    reason = 'startup';
    trigger = 'no account is active';
  } else if (active.quarantinedAt !== undefined || active.usageStatus === 'quarantined') {
    reason = 'quarantine';
    trigger = `slot ${active.slot} is quarantined`;
  } else if (active.usageStatus === 'rate-limited') {
    trigger = `slot ${active.slot} is rate limited`;
  } else if (active.kind === 'api-key' || active.usageStatus === 'no-quota') {
    // An API key has no subscription window to exhaust, so there is nothing
    // for a threshold to fire on.
    return {
      ...base,
      active: { slot: active.slot, email: active.email, pct: null, window: null },
      event: autoEvent('no-switch', `slot ${active.slot} has no subscription quota to track`, {
        slot: active.slot,
      }),
      exitCode: EXIT.nothingToDo,
    };
  } else {
    const pressure = pressureOf(active, models, now);
    if (pressure === null) {
      return {
        ...base,
        active: { slot: active.slot, email: active.email, pct: null, window: null },
        event: autoEvent('poll', `no usage data for slot ${active.slot}; holding`, {
          slot: active.slot,
        }),
        exitCode: EXIT.nothingToDo,
      };
    }
    if (pressure.pct < threshold) {
      return {
        ...base,
        active: {
          slot: active.slot,
          email: active.email,
          pct: pressure.pct,
          window: pressure.window,
        },
        event: autoEvent(
          'no-switch',
          `slot ${active.slot} at ${Math.round(pressure.pct)}% of ${threshold}% on ${pressure.window}`,
          { slot: active.slot, detail: { pct: pressure.pct, window: pressure.window, threshold } },
        ),
        exitCode: EXIT.nothingToDo,
      };
    }
    trigger = `slot ${active.slot} at ${Math.round(pressure.pct)}% on ${pressure.window}`;
  }

  const result = await services.api.switchAccount({
    strategy,
    dryRun: opts.dryRun,
    reason,
  });
  const activeInfo =
    active === undefined
      ? null
      : {
          slot: active.slot,
          email: active.email,
          pct: pressureOf(active, models, now)?.pct ?? null,
          window: pressureOf(active, models, now)?.window ?? null,
        };
  const code = switchExitCode(result);
  const detail = { trigger, threshold, strategy, dryRun: opts.dryRun };

  if (result.error !== undefined) {
    return {
      ...base,
      active: activeInfo,
      result,
      event: autoEvent('error', `${trigger}; ${result.error}`, { detail }),
      exitCode: EXIT.error,
    };
  }
  if (result.switched) {
    return {
      ...base,
      active: activeInfo,
      result,
      event: autoEvent('switch', `${trigger}; ${describeSwitch(result)}`, {
        slot: result.to?.slot,
        detail,
      }),
      exitCode: EXIT.ok,
    };
  }
  if (code === EXIT.blocked) {
    return {
      ...base,
      active: activeInfo,
      result,
      event: autoEvent('all-exhausted', `${trigger}; no viable target (${result.reason})`, {
        detail,
      }),
      exitCode: EXIT.blocked,
    };
  }
  return {
    ...base,
    active: activeInfo,
    result,
    event: autoEvent('no-switch', `${trigger}; ${result.reason}`, { detail }),
    exitCode: code,
  };
}

function autoEventLine(event: AutoSwitchEvent): string {
  const stamp = paint(formatClock(event.ts), 'dim');
  const kindColor: ColorName =
    event.kind === 'switch'
      ? 'green'
      : event.kind === 'error' || event.kind === 'all-exhausted' || event.kind === 'blocked'
        ? 'red'
        : event.kind === 'account-quarantined'
          ? 'yellow'
          : 'dim';
  return `${stamp}  ${paint(padCell(event.kind, 18, 'left'), kindColor)}  ${event.message}`;
}

/** JSONL: one self-describing event per line, so `| jq -c` streams live. */
function emitAutoEvent(event: AutoSwitchEvent, json: boolean): void {
  if (json) {
    out(
      JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        command: 'auto',
        kind: event.kind,
        ts: event.ts,
        message: event.message,
        slot: event.slot ?? null,
        detail: event.detail ?? null,
      }),
    );
  } else {
    out(autoEventLine(event));
  }
}

/** Resolves on SIGINT/SIGTERM, or after `ms` when a duration is given. */
function waitForStop(stop: StopSignal, ms?: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = ms === undefined ? null : setTimeout(finish, ms);
    stop.onStop(finish);
    function finish(): void {
      if (timer !== null) clearTimeout(timer);
      stop.offStop(finish);
      resolve();
    }
  });
}

interface StopSignal {
  stopped: () => boolean;
  onStop: (cb: () => void) => void;
  offStop: (cb: () => void) => void;
}

function installStopSignal(): StopSignal {
  let stopped = false;
  const listeners = new Set<() => void>();
  const trip = (): void => {
    stopped = true;
    for (const cb of [...listeners]) cb();
  };
  process.on('SIGINT', trip);
  process.on('SIGTERM', trip);
  return {
    stopped: () => stopped,
    onStop: (cb) => {
      if (stopped) cb();
      else listeners.add(cb);
    },
    offStop: (cb) => listeners.delete(cb),
  };
}

async function cmdAuto(services: CliServices, args: ParsedArgs): Promise<number> {
  assertFlags(args, ['once', 'threshold', 'dry-run', 'strategy', 'interval']);
  const json = flagBool(args, 'json');
  const opts: AutoOptions = {
    threshold: readThreshold(args),
    strategy: readStrategy(args),
    dryRun: flagBool(args, 'dry-run'),
  };

  if (flagBool(args, 'once')) {
    const outcome = await runAutoOnce(services, opts);
    if (json) {
      emitJson('auto', {
        ok: outcome.exitCode !== EXIT.error,
        once: true,
        action: outcome.event.kind,
        message: outcome.event.message,
        threshold: outcome.threshold,
        dryRun: opts.dryRun,
        active: outcome.active,
        switch: outcome.result === null ? null : switchJson(outcome.result, outcome.exitCode),
        warnings: outcome.warnings,
        exitCode: outcome.exitCode,
      });
    } else if (outcome.exitCode === EXIT.error) {
      fail(outcome.event.message);
    } else {
      out(outcome.event.message);
    }
    for (const problem of outcome.warnings) warn(problem);
    return outcome.exitCode;
  }

  const stop = installStopSignal();
  const state = await services.api.getState();
  const intervalSec = flagNum(args, 'interval') ?? state.settings.autoswitch.pollIntervalSec;
  if (intervalSec <= 0) throw new CliError('--interval must be greater than zero');

  // The main-process engine owns cadence, cooldown and hysteresis, so prefer it
  // whenever it is reachable and the run has no CLI-only overrides to honour.
  const overridden =
    opts.threshold !== undefined ||
    opts.strategy !== undefined ||
    opts.dryRun ||
    args.flags.has('interval');
  const hook = services.onAutoSwitchEvent;

  if (hook !== null && !overridden) {
    const unsubscribe = hook((event) => emitAutoEvent(event, json));
    const started = await services.api.startAutoSwitch();
    if (!started.ok) {
      unsubscribe();
      throw new CliError(started.error, { code: started.code });
    }
    note(paint('auto-switch running - Ctrl+C to stop', 'dim'));
    await waitForStop(stop);
    unsubscribe();
    await services.api.stopAutoSwitch();
    return EXIT.ok;
  }

  // Fallback loop: same rule as --once on a timer. Used when the engine is not
  // exposed, or when --threshold/--strategy/--dry-run must not touch settings.
  note(paint(`polling every ${intervalSec}s - Ctrl+C to stop`, 'dim'));
  while (!stop.stopped()) {
    try {
      const outcome = await runAutoOnce(services, opts);
      for (const problem of outcome.warnings) {
        emitAutoEvent(autoEvent('error', problem), json);
      }
      emitAutoEvent(outcome.event, json);
    } catch (error) {
      emitAutoEvent(autoEvent('error', messageOf(error)), json);
    }
    if (stop.stopped()) break;
    await waitForStop(stop, intervalSec * 1000);
  }
  return EXIT.ok;
}

// ---------------------------------------------------------------------------
// Commands: history + forecasting
// ---------------------------------------------------------------------------

/** Newest-last, and never more than this many rows for a human. */
const HISTORY_ROW_CAP = 50;

async function cmdHistory(services: CliServices, args: ParsedArgs): Promise<number> {
  assertFlags(args, ['slot', 'since', 'until']);
  const json = flagBool(args, 'json');
  const now = Date.now();
  const state = await services.api.getState();

  const slotFlag = flagNum(args, 'slot');
  const slot = slotFlag === undefined ? undefined : resolveTarget(state.accounts, String(slotFlag)).slot;
  const sinceRaw = flagStr(args, 'since');
  const untilRaw = flagStr(args, 'until');
  // A day of history is the useful default; anything longer is opt-in.
  const since = parseSince(sinceRaw ?? '24h', now);
  const until = untilRaw === undefined ? undefined : parseSince(untilRaw, now);

  const points = await services.api.getHistory({ slot, since, until });
  const sorted = [...points].sort((a, b) => a.t - b.t);

  if (json) {
    emitJson('history', {
      ok: true,
      slot: slot ?? null,
      since,
      until: until ?? null,
      count: sorted.length,
      points: sorted,
    });
    return EXIT.ok;
  }

  if (sorted.length === 0) {
    note(`no history since ${formatClock(since)}`);
    return EXIT.ok;
  }

  const keys = historyColumns(sorted);
  const shown = sorted.slice(-HISTORY_ROW_CAP);
  const columns: Column[] = [
    { header: 'TIME' },
    { header: 'SLOT', align: 'right' },
    ...keys.map((key) => ({ header: key.toUpperCase(), align: 'right' as const })),
  ];
  const rows = shown.map((point) => [
    formatClock(point.t),
    String(point.slot),
    ...keys.map((key) => formatPct(point.windows[key] ?? null)),
  ]);

  for (const line of renderTable(columns, rows)) out(line);
  if (sorted.length > shown.length) {
    note(paint(`showing the last ${shown.length} of ${sorted.length} points - use --json for all`, 'dim'));
  }
  return EXIT.ok;
}

/** 5h and 7d lead; any per-model windows follow in a stable order. */
function historyColumns(points: readonly HistoryPoint[]): string[] {
  const seen = new Set<string>();
  for (const point of points) for (const key of Object.keys(point.windows)) seen.add(key);
  const lead = ['5h', '7d'].filter((key) => seen.has(key));
  const rest = [...seen].filter((key) => !lead.includes(key)).sort();
  return [...lead, ...rest].slice(0, 6);
}

async function cmdForecast(services: CliServices, args: ParsedArgs): Promise<number> {
  assertFlags(args, ['slot']);
  const json = flagBool(args, 'json');
  const state = await services.api.getState();
  const slot = slotFrom(args, state);
  const forecasts = await services.api.getForecasts(slot);

  if (json) {
    emitJson('forecast', { ok: true, slot, forecasts });
    return EXIT.ok;
  }

  if (forecasts.length === 0) {
    note(`not enough history to forecast slot ${slot}`);
    return EXIT.ok;
  }

  const now = Date.now();
  const columns: Column[] = [
    { header: 'WINDOW' },
    { header: 'BURN/H', align: 'right' },
    { header: 'SAMPLES', align: 'right' },
    { header: 'CONFIDENCE' },
    { header: 'PACE' },
    { header: 'EXHAUSTS' },
  ];
  const rows = forecasts.map((forecast) => [
    forecast.windowKey,
    `${forecast.burn.pctPerHour.toFixed(1)}%`,
    String(forecast.burn.samples),
    confidenceLabel(forecast.burn.confidence),
    paceLabel(forecast),
    exhaustionLabel(forecast, now),
  ]);
  for (const line of renderTable(columns, rows)) out(line);
  if (forecasts.some((f) => f.burn.confidence < 0.4)) {
    warn('low-confidence fits are guesses, not predictions');
  }
  return EXIT.ok;
}

function confidenceLabel(confidence: number): string {
  const pct = `${Math.round(confidence * 100)}%`;
  if (confidence >= 0.7) return paint(pct, 'green');
  if (confidence >= 0.4) return paint(pct, 'yellow');
  return paint(pct, 'red');
}

function paceLabel(forecast: Forecast): string {
  if (!forecast.aheadOfPace) return paint('on pace', 'green');
  const expected =
    forecast.expectedPct === undefined ? '' : ` (expected ${Math.round(forecast.expectedPct)}%)`;
  return paint(`ahead${expected}`, 'yellow');
}

function exhaustionLabel(forecast: Forecast, now: number): string {
  if (forecast.exhaustionAt === null) return paint('not trending to 100%', 'dim');
  const eta = formatEta(forecast.exhaustionAt, now);
  return forecast.lastsToReset
    ? paint(`in ${eta} (after reset)`, 'green')
    : paint(`in ${eta}`, 'red');
}

// ---------------------------------------------------------------------------
// Commands: transfer
// ---------------------------------------------------------------------------

async function cmdExport(services: CliServices, args: ParsedArgs): Promise<number> {
  assertFlags(args, ['full', 'slot', 'force']);
  const full = flagBool(args, 'full');
  const slotFlag = flagNum(args, 'slot');
  const slot =
    slotFlag === undefined
      ? undefined
      : resolveTarget((await services.api.getState()).accounts, String(slotFlag)).slot;

  // A full export carries credential material. Refusing to paint it across a
  // terminal is the one place the CLI second-guesses the operator.
  if (full && process.stdout.isTTY === true && !flagBool(args, 'force')) {
    throw new CliError(
      '--full writes credentials to stdout; redirect it to a file or add --force to print it here',
      { code: 'unsafe-output' },
    );
  }

  const payload = unwrap(await services.api.exportAccounts({ slot, full }));
  if (flagBool(args, 'json')) {
    emitJson('export', { ok: true, full, slot: slot ?? null, payload });
  } else {
    out(payload);
  }
  if (full) warn('this export contains credentials - store it like a password');
  return EXIT.ok;
}

async function cmdImport(services: CliServices, args: ParsedArgs): Promise<number> {
  assertFlags(args, ['force']);
  const source = args.positionals[0];
  if (source === undefined) throw new CliError('usage: claudedeck import <file> [--force]');

  const payload =
    source === '-'
      ? await readStdin()
      : await readFile(isAbsolute(source) ? source : resolvePath(process.cwd(), source), 'utf8');

  const accounts = unwrap(await services.api.importAccounts(payload, { force: flagBool(args, 'force') }));
  if (flagBool(args, 'json')) {
    emitJson('import', {
      ok: true,
      count: accounts.length,
      accounts: accounts.map(accountRefJson),
    });
  } else {
    out(`imported ${accounts.length} account${accounts.length === 1 ? '' : 's'}`);
    for (const account of accounts) out(`  slot ${account.slot}  ${displayName(account)}`);
  }
  return EXIT.ok;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// ---------------------------------------------------------------------------
// Commands: launching the desktop app
// ---------------------------------------------------------------------------

/** Nearest ancestor directory holding a package.json, walking up from `from`. */
function findAppRoot(from: string): string {
  let dir = from;
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new CliError('cannot locate the ClaudeDeck app root (no package.json above the CLI bundle)');
}

function moduleDir(): string {
  // The CLI ships inside the CommonJS main bundle, so `__dirname` is the
  // bundle directory. Guarded because the tests import this module directly.
  return typeof __dirname === 'string' ? __dirname : process.cwd();
}

/**
 * Outside Electron, `import('electron')` resolves to the path of the runtime
 * binary rather than the API; inside it, we are already running that binary.
 * Either way the window is started as a detached child so the shell returns.
 */
async function cmdGui(args: ParsedArgs): Promise<number> {
  assertFlags(args, []);
  let electronPath: string | null = null;
  try {
    const mod: unknown = await import('electron');
    const entry = isRecord(mod) ? mod['default'] : undefined;
    if (typeof entry === 'string' && entry.length > 0) electronPath = entry;
  } catch {
    electronPath = null;
  }
  if (electronPath === null && typeof process.versions['electron'] === 'string') {
    electronPath = process.execPath;
  }
  if (electronPath === null) {
    throw new CliError('the Electron runtime is not installed alongside this CLI');
  }

  const appRoot = findAppRoot(moduleDir());
  const child = spawn(electronPath, [appRoot, ...args.positionals], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  if (flagBool(args, 'json')) {
    emitJson('gui', { ok: true, pid: child.pid ?? null, appRoot });
  } else {
    note('ClaudeDeck is starting');
  }
  return EXIT.ok;
}

/** Version comes from the bundle's own package.json, not a build-time inline. */
function resolveVersion(): string {
  try {
    const raw = readFileSync(join(findAppRoot(moduleDir()), 'package.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && typeof parsed['version'] === 'string') return parsed['version'];
  } catch {
    // Version is cosmetic; never fail a command over it.
  }
  return '0.0.0';
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

const GENERAL_HELP = [
  'claudedeck - mission control for your Claude Code accounts',
  '',
  'USAGE',
  '  claudedeck <command> [options]',
  '',
  'COMMANDS',
  '  list                      accounts with 5h/7d usage and reset times',
  '  status                    the active account, in detail',
  '  switch [target]           activate an account, or rotate by strategy',
  '  add                       capture the current Claude Code login into a slot',
  '  remove <target>           stop managing an account',
  '  alias <target> <name>     name a slot (--unset clears it)',
  '  enable|disable <target>   put a slot in or out of auto-rotation',
  '  auto                      run the rotation rule; --once evaluates and exits',
  '  history                   recorded utilization points',
  '  forecast                  burn rate and projected exhaustion',
  '  export [--full]           write a transfer payload to stdout',
  '  import <file>             read a transfer payload (use - for stdin)',
  '  gui                       open the desktop window',
  '  help                      this text',
  '',
  'TARGETS',
  '  a slot number, an email address, or an alias',
  '',
  'GLOBAL OPTIONS',
  '  --json          one machine-readable object on stdout; notices go to stderr',
  '  -h, --help      help for a command',
  '  -v, --version   print the version',
  '',
  'EXIT CODES for switch and auto --once',
  '  0 switched    1 error    2 nothing to do    3 no viable target',
  '',
  'EXAMPLES',
  '  claudedeck list --json | jq -r ".accounts[] | select(.active) | .email"',
  '  claudedeck switch --strategy best --dry-run',
  '  claudedeck auto --once --threshold 85',
  '  claudedeck history --slot 2 --since 7d --json',
];

const COMMAND_HELP: Record<string, readonly string[]> = {
  list: ['claudedeck list [--json] [--no-refresh]', '  Every managed account with its 5h and 7d windows.'],
  status: ['claudedeck status [--json] [--no-refresh]', '  The active account, its windows, spend and auto-switch settings.'],
  switch: [
    'claudedeck switch [target] [--strategy best|next|next-available|consume-first]',
    '                  [--dry-run] [--force] [--json]',
    '  With a target, activates it. Without one, rotates using --strategy.',
    '  --dry-run reports the plan and the writes it would make.',
  ],
  add: [
    'claudedeck add [--slot N] [--alias A] [--force] [--token <sk-ant-...>] [--email E]',
    '  Captures whatever Claude Code is logged in as. --token stores a setup',
    '  token or managed API key instead; the value is never echoed.',
  ],
  remove: ['claudedeck remove <target> [--json]'],
  alias: ['claudedeck alias <target> <alias>', 'claudedeck alias <target> --unset'],
  enable: ['claudedeck enable <target>', '  Returns a slot to auto-rotation.'],
  disable: ['claudedeck disable <target>', '  Holds a slot out of auto-rotation; it stays an explicit target.'],
  auto: [
    'claudedeck auto [--once] [--threshold N] [--strategy S] [--dry-run] [--interval SEC] [--json]',
    '  --once evaluates the rule a single time and exits 0/1/2/3.',
    '  Without --once it streams one event per line until Ctrl+C.',
  ],
  history: [
    'claudedeck history [--slot N] [--since 7d] [--until 1h] [--json]',
    '  --since accepts 30m, 12h, 7d, 2w, an ISO date, or epoch ms. Default 24h.',
  ],
  forecast: ['claudedeck forecast [--slot N] [--json]', '  Burn rate, pace, and projected exhaustion per window.'],
  export: [
    'claudedeck export [--slot N] [--full] [--force] [--json]',
    '  --full includes credentials; it refuses to print to a terminal without --force.',
  ],
  import: ['claudedeck import <file|-> [--force] [--json]'],
  gui: ['claudedeck gui', '  Starts the desktop window and returns immediately.'],
};

function printHelp(command: string): void {
  const specific = COMMAND_HELP[command];
  if (specific === undefined) {
    for (const line of GENERAL_HELP) out(line);
    return;
  }
  for (const line of specific) out(line);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const ALIASES: Record<string, string> = {
  ls: 'list',
  rm: 'remove',
  use: 'switch',
  st: 'status',
  '--help': 'help',
  '--version': 'version',
};

/** Commands that must not pay the cost of booting the service layer. */
const OFFLINE_COMMANDS = new Set(['help', 'version', 'gui']);

/**
 * True when this process *is* the Electron runtime, rather than plain Node or
 * Electron forced into Node mode. Only in that state does `safeStorage` exist.
 */
const UNDER_ELECTRON =
  Boolean(process.versions.electron) && process.env['ELECTRON_RUN_AS_NODE'] !== '1';

/** Escape hatch: skip the re-exec and accept whatever the vault can give us. */
const REEXEC_DISABLED = process.env['CLAUDEDECK_NO_REEXEC'] === '1';

/**
 * Re-runs this same bundle under the Electron runtime and proxies the exit code.
 *
 * The account vault is encrypted with Electron's `safeStorage`, which is backed
 * by DPAPI / Keychain / libsecret and simply does not exist outside the Electron
 * process. Run from plain Node, every vault read would fail with `no-decryptor`
 * — so `claudedeck list` would be broken for exactly the users who did the
 * right thing and let the GUI encrypt their credentials.
 *
 * Rather than degrade to plaintext (which would quietly weaken the thing the
 * vault is for), the CLI hands itself to Electron and carries on there. Returns
 * false when re-exec is impossible or unnecessary, in which case the caller
 * proceeds in-process and the vault reports honestly if it cannot decrypt.
 */
async function reexecUnderElectron(argv: readonly string[]): Promise<number | false> {
  if (UNDER_ELECTRON || REEXEC_DISABLED || isDemoMode()) return false;

  let electronBin: string;
  try {
    // Under plain Node the `electron` package's main export is the path to the
    // runtime binary — which is precisely what we need here.
    const req = createRequire(__filename);
    const resolved: unknown = req('electron');
    if (typeof resolved !== 'string' || !existsSync(resolved)) return false;
    electronBin = resolved;
  } catch {
    // Electron is not installed beside us (a packaged app already runs under
    // it). Nothing to escalate to.
    return false;
  }

  return await new Promise<number>((resolveExit) => {
    const child = spawn(electronBin, [__filename, ...argv], {
      stdio: 'inherit',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, CLAUDEDECK_CLI_HOST: '1' },
    });
    child.on('error', () => resolveExit(EXIT.error));
    child.on('exit', (code, signal) => resolveExit(signal ? EXIT.error : (code ?? EXIT.ok)));
  });
}

async function run(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const named = ALIASES[args.command] ?? args.command;
  const command = named === '' ? (flagBool(args, 'version') ? 'version' : 'help') : named;

  if (flagBool(args, 'help') && command !== 'help') {
    printHelp(command);
    return EXIT.ok;
  }

  if (command === 'help') {
    printHelp(args.positionals[0] ?? '');
    return EXIT.ok;
  }
  if (command === 'version') {
    const version = resolveVersion();
    if (flagBool(args, 'json')) emitJson('version', { ok: true, version });
    else out(version);
    return EXIT.ok;
  }
  if (command === 'gui') return cmdGui(args);

  if (OFFLINE_COMMANDS.has(command)) throw new CliError(`unhandled command: ${command}`);

  // Everything below this line opens the vault, so escalate to the Electron
  // runtime first if that is where the decryption key lives.
  const delegated = await reexecUnderElectron(argv);
  if (delegated !== false) return delegated;

  const services = await openServices();
  try {
    switch (command) {
      case 'list':
        return await cmdList(services, args);
      case 'status':
        return await cmdStatus(services, args);
      case 'switch':
        return await cmdSwitch(services, args);
      case 'add':
        return await cmdAdd(services, args);
      case 'remove':
        return await cmdRemove(services, args);
      case 'alias':
        return await cmdAlias(services, args);
      case 'enable':
        return await cmdSetDisabled(services, args, false);
      case 'disable':
        return await cmdSetDisabled(services, args, true);
      case 'auto':
        return await cmdAuto(services, args);
      case 'history':
        return await cmdHistory(services, args);
      case 'forecast':
        return await cmdForecast(services, args);
      case 'export':
        return await cmdExport(services, args);
      case 'import':
        return await cmdImport(services, args);
      default:
        throw new CliError(`unknown command "${command}" - try: claudedeck help`);
    }
  } finally {
    await services.dispose();
  }
}

/** Renders a thrown failure once, in whichever format the run asked for. */
function reportFailure(error: unknown, argv: readonly string[]): number {
  const cliError = error instanceof CliError ? error : null;
  const exitCode = cliError?.exitCode ?? EXIT.error;
  const message = messageOf(error);
  // Only argv[0] can be the command. Scanning further could pick up a flag
  // value - `add --token sk-ant-...` - and print a secret into the document.
  const first = argv[0];
  const command = first !== undefined && !first.startsWith('-') ? first : 'claudedeck';

  if (argv.includes('--json') || argv.includes('-j')) {
    emitJson(command, { ok: false, error: message, code: cliError?.code ?? null, exitCode });
  }
  fail(message);
  if (cliError === null && error instanceof Error && error.stack !== undefined) {
    // An unexpected throw is a bug; keep the trace behind a flag so normal
    // failures stay one readable line.
    if (process.env['CLAUDEDECK_DEBUG'] === '1') note(paint(error.stack, 'dim'));
    else note(paint('set CLAUDEDECK_DEBUG=1 for the stack trace', 'dim'));
  }
  return exitCode;
}

/** Exits only once stdout has drained, so piped output is never truncated. */
function finish(code: number): void {
  process.exitCode = code;
  process.stdout.write('', () => {
    // An Electron host with no window will never exit by itself.
    if (UNDER_ELECTRON) {
      void import('electron').then(({ app }) => app?.exit(code)).catch(() => process.exit(code));
      return;
    }
    process.exit(code);
  });
}

async function cli(): Promise<void> {
  // `claudedeck list | head -1` closes the pipe under us; that is not an error.
  process.stdout.on('error', (error: unknown) => {
    if (isRecord(error) && error['code'] === 'EPIPE') process.exit(EXIT.ok);
  });

  const argv = process.argv.slice(2);
  let code: number;
  try {
    code = await run(argv);
  } catch (error) {
    code = reportFailure(error, argv);
  }
  finish(code);
}

void cli();
