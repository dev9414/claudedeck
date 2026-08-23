/**
 * Where Claude Code keeps its state, and where ClaudeDeck keeps its own.
 *
 * Resolution mirrors Claude Code's own rules so we always read and write the
 * exact files it does. The one trap worth naming up front: the config *home*
 * and the global *config file* do not nest. `.claude.json` sits in the home
 * directory next to `.claude/`, not inside it, unless `CLAUDE_CONFIG_DIR`
 * overrides the base or a legacy `.config.json` is still present.
 *
 * Everything takes `env` and `homeDir` as parameters so tests can point the
 * whole app at a temp directory and never touch a developer's real install.
 */

import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { ClaudePaths, PlatformKind } from '@shared/types';
import { detectPlatform } from './platform';

const CLAUDE_DIRNAME = '.claude';
const LEGACY_GLOBAL_CONFIG = '.config.json';
const GLOBAL_CONFIG = '.claude.json';
const CREDENTIALS = '.credentials.json';

/** Product directory name: capitalised on Windows/macOS, lowercase under XDG. */
const DECK_DIRNAME = 'ClaudeDeck';
const DECK_DIRNAME_XDG = 'claudedeck';

/** Escape hatch for portable installs and for tests that need a sandbox root. */
const DECK_HOME_ENV = 'CLAUDEDECK_HOME';

export interface ClaudeCodeDetection {
  /** A Claude Code config layout exists on disk. */
  installed: boolean;
  /** That install currently holds usable credentials. */
  loggedIn: boolean;
  /** Present only when something is missing; never contains secret material. */
  reason?: string;
}

/** Resolve every path the app reads or writes, for one environment. */
export function resolvePaths(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir(),
): ClaudePaths {
  const override = trimmed(env['CLAUDE_CONFIG_DIR']);
  const configHome = override ? expandHome(override, homeDir) : join(homeDir, CLAUDE_DIRNAME);
  return {
    configHome,
    globalConfig: resolveGlobalConfig(configHome, homeDir, override !== undefined),
    credentials: join(configHome, CREDENTIALS),
    deckHome: resolveDeckHome(detectPlatform(process.platform, env), env, homeDir),
  };
}

/**
 * ClaudeDeck's own data root, per platform convention.
 *
 * Exported separately from `resolvePaths` so tests can exercise the macOS and
 * Windows branches from a Linux runner (and vice versa) without faking
 * `process.platform`.
 */
export function resolveDeckHome(
  platform: PlatformKind,
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir(),
): string {
  const override = trimmed(env[DECK_HOME_ENV]);
  if (override) return expandHome(override, homeDir);

  if (platform === 'windows') {
    const appData = trimmed(env['APPDATA']);
    // %APPDATA% is absent for services and some CI shells; the location it
    // would have pointed at is still the right answer.
    return join(appData ?? join(homeDir, 'AppData', 'Roaming'), DECK_DIRNAME);
  }
  if (platform === 'macos') {
    return join(homeDir, 'Library', 'Application Support', DECK_DIRNAME);
  }

  // Linux and WSL follow the XDG Base Directory spec, which says to ignore
  // XDG_DATA_HOME when it is unset, empty, or relative. `~` is expanded because
  // systemd units and Dockerfiles set the value with no shell to do it for them.
  const xdg = trimmed(env['XDG_DATA_HOME']);
  const expanded = xdg ? expandHome(xdg, homeDir) : undefined;
  if (expanded && isAbsolute(expanded)) return join(expanded, DECK_DIRNAME_XDG);
  return join(homeDir, '.local', 'share', DECK_DIRNAME_XDG);
}

/**
 * Best-effort answer to "is there a Claude Code install here, and is it logged
 * in?" — used by onboarding and by the CLI's diagnostics.
 *
 * Presence of the config layout stands in for "installed": we deliberately do
 * not shell out to look for the `claude` binary, because the binary can live
 * anywhere (npm global, Homebrew, a bun shim) while the config layout is the
 * thing we actually operate on.
 */
export async function detectClaudeCode(paths: ClaudePaths): Promise<ClaudeCodeDetection> {
  const [configHomeExists, globalConfig] = await Promise.all([
    isDirectory(paths.configHome),
    probeJson(paths.globalConfig),
  ]);

  const installed = configHomeExists || globalConfig.state !== 'missing';
  if (!installed) {
    return {
      installed: false,
      loggedIn: false,
      reason: `no Claude Code configuration at ${paths.configHome}`,
    };
  }

  const credentials = await probeJson(paths.credentials);
  if (credentials.state === 'ok') {
    const oauth = asRecord(credentials.value['claudeAiOauth']);
    if (oauth && nonEmptyString(oauth['accessToken'])) {
      return { installed: true, loggedIn: true };
    }
  }

  // macOS keeps the OAuth blob in the login Keychain instead of the file, so a
  // missing .credentials.json proves nothing on its own. The global config's
  // oauthAccount is written on every platform when a login succeeds, which
  // makes it the portable signal.
  if (globalConfig.state === 'ok') {
    const account = asRecord(globalConfig.value['oauthAccount']);
    const identified =
      account && (nonEmptyString(account['accountUuid']) || nonEmptyString(account['emailAddress']));
    if (identified || nonEmptyString(globalConfig.value['primaryApiKey'])) {
      return { installed: true, loggedIn: true };
    }
  }

  return { installed: true, loggedIn: false, reason: loggedOutReason(credentials, globalConfig) };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * The legacy `<configHome>/.config.json` wins whenever it is still on disk;
 * otherwise the file lives beside the home directory, or inside
 * `CLAUDE_CONFIG_DIR` when that was set.
 */
function resolveGlobalConfig(configHome: string, homeDir: string, hasOverride: boolean): string {
  const legacy = join(configHome, LEGACY_GLOBAL_CONFIG);
  if (existsSync(legacy)) return legacy;
  return join(hasOverride ? configHome : homeDir, GLOBAL_CONFIG);
}

type JsonProbe =
  | { state: 'ok'; value: Record<string, unknown> }
  | { state: 'missing' }
  | { state: 'unreadable'; reason: string };

/**
 * A corrupt file is a different problem from a logged-out one, so say which —
 * an unreadable file explains the verdict far better than "not logged in".
 */
function loggedOutReason(credentials: JsonProbe, globalConfig: JsonProbe): string {
  if (credentials.state === 'unreadable') return credentials.reason;
  if (globalConfig.state === 'unreadable') return globalConfig.reason;
  return 'Claude Code is installed but not logged in';
}

async function probeJson(file: string): Promise<JsonProbe> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return { state: 'missing' };
    return { state: 'unreadable', reason: `cannot read ${file} (${code ?? 'unknown error'})` };
  }
  try {
    const record = asRecord(JSON.parse(raw));
    // Reasons never echo the file body — that body is exactly what holds tokens.
    if (!record) return { state: 'unreadable', reason: `${file} is not a JSON object` };
    return { state: 'ok', value: record };
  } catch {
    return { state: 'unreadable', reason: `${file} is not valid JSON` };
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** An env var set to whitespace means "unset", matching Claude Code's reading. */
function trimmed(value: string | undefined): string | undefined {
  const out = value?.trim();
  return out ? out : undefined;
}

function expandHome(path: string, homeDir: string): string {
  if (path === '~') return homeDir;
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homeDir, path.slice(2));
  return path;
}
