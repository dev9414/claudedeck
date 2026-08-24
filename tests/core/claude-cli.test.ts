/**
 * `src/core/claude-cli.ts` — finding the Claude Code CLI.
 *
 * The cases that matter are the ones that bit a real install: the binary is not
 * on PATH at all because it ships inside the VS Code extension, several
 * extension versions sit side by side, and a *different* program called
 * `claude` (Claude Desktop) is also on the machine.
 *
 * Windows paths are written with `String.raw` so a single backslash in the
 * expectation stays a single backslash.
 */

import { describe, expect, it } from 'vitest';

import {
  claudeFileNames,
  claudeSearchDirs,
  extensionVersion,
  isClaudeCodeVersion,
  pathDirs,
  sortExtensionDirs,
  vscodeExtensionsRoot,
} from '@core/claude-cli';

describe('extensionVersion', () => {
  it('reads the version out of an extension directory name', () => {
    expect(extensionVersion('anthropic.claude-code-2.1.241-win32-x64')).toEqual([2, 1, 241]);
  });

  it('handles a platform-less name', () => {
    expect(extensionVersion('anthropic.claude-code-1.0.0')).toEqual([1, 0, 0]);
  });

  it.each(['ms-vscode.cpptools-1.2.3', 'anthropic.claude-code', 'claude-code-2.1.241', ''])(
    'returns null for %s',
    (name) => {
      expect(extensionVersion(name)).toBeNull();
    },
  );
});

describe('sortExtensionDirs', () => {
  it('puts the newest first and drops unrelated extensions', () => {
    expect(
      sortExtensionDirs([
        'anthropic.claude-code-2.1.238-win32-x64',
        'ms-python.python-2024.1',
        'anthropic.claude-code-2.1.241-win32-x64',
        'anthropic.claude-code-2.1.240-win32-x64',
      ]),
    ).toEqual([
      'anthropic.claude-code-2.1.241-win32-x64',
      'anthropic.claude-code-2.1.240-win32-x64',
      'anthropic.claude-code-2.1.238-win32-x64',
    ]);
  });

  it('compares numerically, not lexically', () => {
    // The bug this guards: "2.1.9" sorts after "2.1.10" as a string.
    expect(sortExtensionDirs(['anthropic.claude-code-2.1.9-x', 'anthropic.claude-code-2.1.10-x'])[0]).toBe(
      'anthropic.claude-code-2.1.10-x',
    );
  });

  it('treats a missing segment as zero', () => {
    expect(sortExtensionDirs(['anthropic.claude-code-2.1-x', 'anthropic.claude-code-2.1.1-x'])[0]).toBe(
      'anthropic.claude-code-2.1.1-x',
    );
  });

  it('is empty for no input', () => {
    expect(sortExtensionDirs([])).toEqual([]);
  });
});

describe('pathDirs', () => {
  it('splits on the host separator and strips quotes', () => {
    expect(pathDirs({ PATH: String.raw`C:\Windows;"C:\Program Files\nodejs";` }, 'windows')).toEqual([
      String.raw`C:\Windows`,
      String.raw`C:\Program Files\nodejs`,
    ]);
  });

  it('reads the Windows-cased variants', () => {
    expect(pathDirs({ Path: '/usr/bin' }, 'linux')).toEqual(['/usr/bin']);
    expect(pathDirs({ path: '/usr/bin' }, 'linux')).toEqual(['/usr/bin']);
  });

  it('is empty when PATH is absent', () => {
    expect(pathDirs({}, 'linux')).toEqual([]);
  });
});

describe('claudeFileNames', () => {
  it('tries the real image before the shell shim on Windows', () => {
    const names = claudeFileNames('windows');
    expect(names[0]).toBe('claude.exe');
    expect(names).toContain('claude.cmd');
  });

  it('is just the bare name elsewhere', () => {
    expect(claudeFileNames('linux')).toEqual(['claude']);
    expect(claudeFileNames('macos')).toEqual(['claude']);
  });
});

describe('claudeSearchDirs', () => {
  const home = String.raw`C:\Users\me`;

  it('searches PATH before anything bundled', () => {
    // A deliberate install has to win over the editor's copy.
    const dirs = claudeSearchDirs({
      env: { PATH: String.raw`C:\Windows` },
      homeDir: home,
      platform: 'windows',
      extensionDirs: ['anthropic.claude-code-2.1.241-win32-x64'],
    });
    expect(dirs[0]).toBe(String.raw`C:\Windows`);
  });

  it("includes the VS Code extension's bundled binary directory", () => {
    const dirs = claudeSearchDirs({
      env: { PATH: String.raw`C:\Windows` },
      homeDir: home,
      platform: 'windows',
      extensionDirs: ['anthropic.claude-code-2.1.241-win32-x64'],
    });
    expect(dirs).toContain(
      String.raw`C:\Users\me\.vscode\extensions\anthropic.claude-code-2.1.241-win32-x64\resources\native-binary`,
    );
  });

  it('orders several extension versions newest first', () => {
    const dirs = claudeSearchDirs({
      env: {},
      homeDir: home,
      platform: 'windows',
      extensionDirs: [
        'anthropic.claude-code-2.1.238-win32-x64',
        'anthropic.claude-code-2.1.241-win32-x64',
      ],
    });
    const newest = dirs.findIndex((d) => d.includes('2.1.241'));
    const older = dirs.findIndex((d) => d.includes('2.1.238'));
    expect(newest).toBeGreaterThanOrEqual(0);
    expect(newest).toBeLessThan(older);
  });

  it("includes npm's global bin, which a GUI launch cannot see", () => {
    const dirs = claudeSearchDirs({
      env: { APPDATA: String.raw`C:\Users\me\AppData\Roaming` },
      homeDir: home,
      platform: 'windows',
    });
    expect(dirs).toContain(String.raw`C:\Users\me\AppData\Roaming\npm`);
  });

  it("includes Claude Code's own local install", () => {
    const dirs = claudeSearchDirs({ env: {}, homeDir: '/home/me', platform: 'linux' });
    expect(dirs).toContain('/home/me/.claude/local');
  });

  it('uses POSIX conventions off Windows', () => {
    const dirs = claudeSearchDirs({ env: {}, homeDir: '/home/me', platform: 'linux' });
    expect(dirs).toContain('/usr/local/bin');
    expect(dirs).toContain('/home/me/.local/bin');
    expect(dirs.every((d) => !d.includes('\\'))).toBe(true);
  });

  it('de-duplicates a repeated PATH entry', () => {
    const dirs = claudeSearchDirs({
      env: { PATH: '/usr/bin:/usr/bin' },
      homeDir: '/home/me',
      platform: 'linux',
    });
    expect(dirs.filter((d) => d === '/usr/bin')).toHaveLength(1);
  });

  it('de-duplicates case-insensitively on Windows only', () => {
    const win = claudeSearchDirs({
      env: { PATH: String.raw`C:\Windows;c:\windows` },
      homeDir: home,
      platform: 'windows',
    });
    expect(win.filter((d) => d.toLowerCase() === String.raw`c:\windows`)).toHaveLength(1);

    const nix = claudeSearchDirs({ env: { PATH: '/Bin:/bin' }, homeDir: '/home/me', platform: 'linux' });
    expect(nix.filter((d) => d === '/Bin' || d === '/bin')).toHaveLength(2);
  });

  it('survives an empty environment', () => {
    expect(() => claudeSearchDirs({ env: {}, homeDir: '', platform: 'windows' })).not.toThrow();
  });
});

describe('isClaudeCodeVersion', () => {
  it('accepts Claude Code', () => {
    expect(isClaudeCodeVersion('2.1.241 (Claude Code)')).toBe(true);
  });

  it('rejects Claude Desktop, which also installs a `claude`', () => {
    // The real decoy: %LOCALAPPDATA%\AnthropicClaude\claude.exe prints this.
    expect(isClaudeCodeVersion('1.34493.1')).toBe(false);
  });

  it.each(['', 'claude 0.0.0', 'not a version'])('rejects %s', (out) => {
    expect(isClaudeCodeVersion(out)).toBe(false);
  });
});

describe('vscodeExtensionsRoot', () => {
  it('is host-shaped', () => {
    expect(vscodeExtensionsRoot(String.raw`C:\Users\me`, 'windows')).toBe(
      String.raw`C:\Users\me\.vscode\extensions`,
    );
    expect(vscodeExtensionsRoot('/home/me', 'linux')).toBe('/home/me/.vscode/extensions');
  });
});
