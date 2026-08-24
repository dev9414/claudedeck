/**
 * Finding the Claude Code CLI.
 *
 * `claude` is frequently not on PATH, and a desktop app is the worst case for
 * it: a GUI launched from Explorer or the Start menu inherits a login
 * environment, not the shell PATH a terminal would give it. Worse, the most
 * common way to have Claude Code today is the VS Code extension, which ships
 * the binary inside its own extension directory and never puts it on PATH at
 * all. "Install Claude Code" is the wrong advice for someone who plainly has it.
 *
 * There is also a decoy. Claude *Desktop* installs an executable called
 * `claude.exe` (under `%LOCALAPPDATA%\\AnthropicClaude`) which is a different
 * program with a different version scheme and no `-p` flag. Picking it would
 * fail in a way that looks like Claude Code misbehaving, so a candidate is only
 * accepted once `--version` says what it is.
 *
 * Pure: this module only computes *where to look* and *what counts as a match*.
 * The probing lives in the main process, which owns the filesystem.
 */

import type { PlatformKind } from '@shared/types';

/**
 * `claude --version` prints e.g. `2.1.241 (Claude Code)`. Claude Desktop prints
 * a bare `1.34493.1`, so the parenthesised name is the discriminator.
 */
export const CLAUDE_CODE_MARK = 'claude code';

/** Executable names to try, in order, for a platform. */
export function claudeFileNames(platform: PlatformKind): string[] {
  // `.exe` first: it is a real image, so it runs without a shell. The `.cmd`
  // shim works but has to go through one.
  return platform === 'windows' ? ['claude.exe', 'claude.cmd', 'claude.bat', 'claude'] : ['claude'];
}

/** Directories on `PATH`, split for the host and stripped of empty entries. */
export function pathDirs(env: NodeJS.ProcessEnv, platform: PlatformKind): string[] {
  const raw = env['PATH'] ?? env['Path'] ?? env['path'] ?? '';
  const sep = platform === 'windows' ? ';' : ':';
  return raw
    .split(sep)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter((entry) => entry.length > 0);
}

/**
 * `anthropic.claude-code-2.1.241-win32-x64` -> `[2, 1, 241]`, or null when the
 * directory is not a Claude Code extension. Used to prefer the newest install
 * when several versions are left side by side, which VS Code routinely does.
 */
export function extensionVersion(dirName: string): number[] | null {
  const m = /^anthropic\.claude-code-(\d+(?:\.\d+)*)/.exec(dirName);
  if (!m || m[1] === undefined) return null;
  return m[1].split('.').map((part) => Number(part));
}

/** Newest first. Non-extension names are dropped. */
export function sortExtensionDirs(dirNames: readonly string[]): string[] {
  return dirNames
    .map((name) => ({ name, version: extensionVersion(name) }))
    .filter((entry): entry is { name: string; version: number[] } => entry.version !== null)
    .sort((a, b) => {
      const len = Math.max(a.version.length, b.version.length);
      for (let i = 0; i < len; i += 1) {
        const diff = (b.version[i] ?? 0) - (a.version[i] ?? 0);
        if (diff !== 0) return diff;
      }
      return 0;
    })
    .map((entry) => entry.name);
}

export interface SearchInput {
  env: NodeJS.ProcessEnv;
  homeDir: string;
  platform: PlatformKind;
  /** VS Code extension directory names, as read from disk. */
  extensionDirs?: readonly string[];
}

/**
 * Directories to search for the CLI, most-likely first. PATH comes first so a
 * deliberate install always wins over a bundled one.
 */
export function claudeSearchDirs(input: SearchInput): string[] {
  const { env, homeDir, platform } = input;
  const win = platform === 'windows';
  const dirs = [...pathDirs(env, platform)];

  const push = (...parts: string[]) => {
    const joined = parts.filter((p) => p.length > 0).join(win ? '\\' : '/');
    if (joined.length > 0) dirs.push(joined);
  };

  if (win) {
    // npm's global bin, which a GUI launch often cannot see.
    push(env['APPDATA'] ?? '', 'npm');
    push(env['LOCALAPPDATA'] ?? '', 'npm');
    push(homeDir, 'AppData', 'Roaming', 'npm');
    push(env['LOCALAPPDATA'] ?? '', 'Programs', 'claude-code');
  } else {
    push(homeDir, '.local', 'bin');
    push('/usr/local/bin');
    push('/opt/homebrew/bin');
    push(homeDir, '.npm-global', 'bin');
    if (platform === 'macos') push('/Applications/Claude Code.app/Contents/MacOS');
  }

  // Claude Code's own local install, used by its installer and updater.
  push(homeDir, '.claude', 'local');
  push(homeDir, '.claude', 'bin');

  // The VS Code extension, newest first. This is the common case for anyone who
  // has only ever used Claude Code inside the editor.
  const extRoot = win
    ? [homeDir, '.vscode', 'extensions']
    : [homeDir, '.vscode', 'extensions'];
  for (const name of sortExtensionDirs(input.extensionDirs ?? [])) {
    push(...extRoot, name, 'resources', 'native-binary');
    push(...extRoot, name, 'resources', 'bin');
  }

  // De-duplicate while keeping order; a repeated PATH entry is common.
  const seen = new Set<string>();
  return dirs.filter((dir) => {
    const key = win ? dir.toLowerCase() : dir;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** True when `claude --version` output identifies Claude Code, not Claude Desktop. */
export function isClaudeCodeVersion(output: string): boolean {
  return output.toLowerCase().includes(CLAUDE_CODE_MARK);
}

/** Where the VS Code extensions live, for the caller to enumerate. */
export function vscodeExtensionsRoot(homeDir: string, platform: PlatformKind): string {
  return platform === 'windows' ? `${homeDir}\\.vscode\\extensions` : `${homeDir}/.vscode/extensions`;
}
