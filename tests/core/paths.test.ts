/**
 * `src/core/paths.ts` — path resolution and install detection.
 *
 * These tests hit the real filesystem (`resolveGlobalConfig` uses `existsSync`,
 * `detectClaudeCode` uses `node:fs/promises`), so every one of them runs
 * against a `tempDir()` and asserts, via `assertSandboxed`, that nothing it
 * produced points into the developer's real `~/.claude`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { detectClaudeCode, resolveDeckHome, resolvePaths } from '@core/paths';
import type { PlatformKind } from '@shared/types';

import {
  SAMPLE_ACCESS_TOKEN,
  assertSandboxed,
  expectNoSecrets,
  makeCredentialFile,
  sandboxEnv,
  sandboxPaths,
  tempDir,
} from '../helpers/fixtures';

function write(path: string, contents: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents, 'utf8');
}

describe('the test sandbox itself', () => {
  it('never hands out a path inside the real Claude Code install', () => {
    const root = tempDir();
    const paths = sandboxPaths(root);

    // If this ever regresses, every other test in the suite is suspect.
    expect(() =>
      assertSandboxed(paths.configHome, paths.globalConfig, paths.credentials, paths.deckHome),
    ).not.toThrow();

    const realClaude = join(homedir(), '.claude');
    for (const p of Object.values(paths)) {
      expect(p.startsWith(realClaude)).toBe(false);
      expect(p.startsWith(root)).toBe(true);
    }
  });

  it('rejects a path that would touch the real install', () => {
    expect(() => assertSandboxed(join(homedir(), '.claude', '.credentials.json'))).toThrow(
      /sandbox violation/,
    );
    expect(() => assertSandboxed(join(homedir(), '.claude.json'))).toThrow(/sandbox violation/);
  });

  it('rejects a path that is merely outside the temp root', () => {
    expect(() => assertSandboxed(join(homedir(), 'Documents', 'notes.txt'))).toThrow(
      /not inside a test temp directory/,
    );
  });
});

describe('resolvePaths', () => {
  it('puts .claude.json in the home dir, not inside .claude/ (the asymmetry)', () => {
    const home = tempDir();
    const paths = resolvePaths({}, home);

    expect(paths.configHome).toBe(join(home, '.claude'));
    expect(paths.globalConfig).toBe(join(home, '.claude.json'));
    expect(paths.credentials).toBe(join(home, '.claude', '.credentials.json'));
    assertSandboxed(paths.configHome, paths.globalConfig, paths.credentials, paths.deckHome);
  });

  it('honours CLAUDE_CONFIG_DIR for both the home and the global config', () => {
    const home = tempDir();
    const override = join(home, 'custom-config');
    const paths = resolvePaths({ CLAUDE_CONFIG_DIR: override }, home);

    expect(paths.configHome).toBe(override);
    // With an override the config file moves *inside* the override dir.
    expect(paths.globalConfig).toBe(join(override, '.claude.json'));
    expect(paths.credentials).toBe(join(override, '.credentials.json'));
  });

  it('prefers a legacy <configHome>/.config.json when it exists', () => {
    const home = tempDir();
    const legacy = join(home, '.claude', '.config.json');
    write(legacy, '{}');

    expect(resolvePaths({}, home).globalConfig).toBe(legacy);
  });

  it('prefers the legacy file inside an overridden config dir too', () => {
    const home = tempDir();
    const override = join(home, 'cfg');
    write(join(override, '.config.json'), '{}');

    expect(resolvePaths({ CLAUDE_CONFIG_DIR: override }, home).globalConfig).toBe(
      join(override, '.config.json'),
    );
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['a tab', '\t'],
  ])('treats a %s CLAUDE_CONFIG_DIR as unset', (_label, value) => {
    const home = tempDir();
    expect(resolvePaths({ CLAUDE_CONFIG_DIR: value }, home).configHome).toBe(join(home, '.claude'));
  });

  it('expands a leading ~ in CLAUDE_CONFIG_DIR', () => {
    const home = tempDir();
    expect(resolvePaths({ CLAUDE_CONFIG_DIR: '~/elsewhere' }, home).configHome).toBe(
      join(home, 'elsewhere'),
    );
    expect(resolvePaths({ CLAUDE_CONFIG_DIR: '~' }, home).configHome).toBe(home);
  });

  it('resolves entirely inside the sandbox env produced by the fixtures', () => {
    const root = tempDir();
    const paths = resolvePaths(sandboxEnv(root), root);
    assertSandboxed(paths.configHome, paths.globalConfig, paths.credentials, paths.deckHome);
  });
});

describe('resolveDeckHome', () => {
  const home = '/home/tester';

  const cases: Array<{
    name: string;
    platform: PlatformKind;
    env: NodeJS.ProcessEnv;
    expected: string;
  }> = [
    {
      name: 'windows with %APPDATA%',
      platform: 'windows',
      env: { APPDATA: '/appdata' },
      expected: join('/appdata', 'ClaudeDeck'),
    },
    {
      name: 'windows without %APPDATA% falls back to the conventional location',
      platform: 'windows',
      env: {},
      expected: join(home, 'AppData', 'Roaming', 'ClaudeDeck'),
    },
    {
      name: 'macos uses Application Support',
      platform: 'macos',
      env: {},
      expected: join(home, 'Library', 'Application Support', 'ClaudeDeck'),
    },
    {
      name: 'linux honours an absolute XDG_DATA_HOME',
      platform: 'linux',
      env: { XDG_DATA_HOME: '/xdg/data' },
      expected: join('/xdg/data', 'claudedeck'),
    },
    {
      name: 'linux ignores a relative XDG_DATA_HOME, per the spec',
      platform: 'linux',
      env: { XDG_DATA_HOME: 'relative/data' },
      expected: join(home, '.local', 'share', 'claudedeck'),
    },
    {
      name: 'linux ignores an empty XDG_DATA_HOME',
      platform: 'linux',
      env: { XDG_DATA_HOME: '  ' },
      expected: join(home, '.local', 'share', 'claudedeck'),
    },
    {
      name: 'linux expands ~ in XDG_DATA_HOME',
      platform: 'linux',
      env: { XDG_DATA_HOME: '~/share' },
      expected: join(home, 'share', 'claudedeck'),
    },
    {
      name: 'wsl follows the XDG layout',
      platform: 'wsl',
      env: {},
      expected: join(home, '.local', 'share', 'claudedeck'),
    },
  ];

  it.each(cases)('$name', ({ platform, env, expected }) => {
    expect(resolveDeckHome(platform, env, home)).toBe(expected);
  });

  it('lets CLAUDEDECK_HOME override every platform rule', () => {
    for (const platform of ['windows', 'macos', 'linux', 'wsl'] as PlatformKind[]) {
      expect(resolveDeckHome(platform, { CLAUDEDECK_HOME: '/portable/deck' }, home)).toBe(
        '/portable/deck',
      );
    }
  });

  it('expands ~ in CLAUDEDECK_HOME', () => {
    expect(resolveDeckHome('linux', { CLAUDEDECK_HOME: '~/deck' }, home)).toBe(join(home, 'deck'));
  });

  it('ignores a blank CLAUDEDECK_HOME', () => {
    expect(resolveDeckHome('macos', { CLAUDEDECK_HOME: '   ' }, home)).toBe(
      join(home, 'Library', 'Application Support', 'ClaudeDeck'),
    );
  });
});

describe('detectClaudeCode', () => {
  it('reports not installed when nothing exists', async () => {
    const paths = sandboxPaths(tempDir());
    const result = await detectClaudeCode(paths);

    expect(result).toMatchObject({ installed: false, loggedIn: false });
    expect(result.reason).toContain(paths.configHome);
  });

  it('reports installed but logged out for a bare config dir', async () => {
    const root = tempDir();
    mkdirSync(join(root, '.claude'), { recursive: true });

    const result = await detectClaudeCode(sandboxPaths(root));
    expect(result).toEqual({
      installed: true,
      loggedIn: false,
      reason: 'Claude Code is installed but not logged in',
    });
  });

  it('reports installed when only the global config exists', async () => {
    const root = tempDir();
    write(join(root, '.claude.json'), JSON.stringify({ projects: {} }));

    expect(await detectClaudeCode(sandboxPaths(root))).toMatchObject({
      installed: true,
      loggedIn: false,
    });
  });

  it('reports logged in from a credentials file with an access token', async () => {
    const root = tempDir();
    const paths = sandboxPaths(root);
    write(paths.credentials, JSON.stringify(makeCredentialFile()));

    expect(await detectClaudeCode(paths)).toEqual({ installed: true, loggedIn: true });
  });

  it('does not treat an empty claudeAiOauth block as logged in', async () => {
    const root = tempDir();
    const paths = sandboxPaths(root);
    write(paths.credentials, JSON.stringify({ claudeAiOauth: { accessToken: '' } }));

    expect(await detectClaudeCode(paths)).toMatchObject({ installed: true, loggedIn: false });
  });

  it('falls back to oauthAccount when the credentials file is absent (the macOS case)', async () => {
    const root = tempDir();
    const paths = sandboxPaths(root);
    mkdirSync(paths.configHome, { recursive: true });
    write(paths.globalConfig, JSON.stringify({ oauthAccount: { emailAddress: 'a@example.test' } }));

    expect(await detectClaudeCode(paths)).toEqual({ installed: true, loggedIn: true });
  });

  it('accepts an oauthAccount identified only by uuid', async () => {
    const root = tempDir();
    const paths = sandboxPaths(root);
    write(paths.globalConfig, JSON.stringify({ oauthAccount: { accountUuid: 'u-1' } }));

    expect(await detectClaudeCode(paths)).toMatchObject({ loggedIn: true });
  });

  it('accepts a managed API key in the global config', async () => {
    const root = tempDir();
    const paths = sandboxPaths(root);
    write(paths.globalConfig, JSON.stringify({ primaryApiKey: 'sk-ant-api03-x' }));

    expect(await detectClaudeCode(paths)).toMatchObject({ loggedIn: true });
  });

  it('rejects an oauthAccount with no identifying fields', async () => {
    const root = tempDir();
    const paths = sandboxPaths(root);
    write(paths.globalConfig, JSON.stringify({ oauthAccount: { organizationName: 'Acme' } }));

    expect(await detectClaudeCode(paths)).toMatchObject({ installed: true, loggedIn: false });
  });

  it.each([
    ['invalid JSON', '{ not json', 'is not valid JSON'],
    ['a JSON array', '[]', 'is not a JSON object'],
    ['a JSON scalar', '42', 'is not a JSON object'],
  ])('explains a credentials file that is %s', async (_label, body, expected) => {
    const root = tempDir();
    const paths = sandboxPaths(root);
    mkdirSync(paths.configHome, { recursive: true });
    write(paths.credentials, body);

    const result = await detectClaudeCode(paths);
    expect(result.installed).toBe(true);
    expect(result.loggedIn).toBe(false);
    expect(result.reason).toContain(expected);
  });

  it('prefers the credentials failure over the global-config failure in the reason', async () => {
    const root = tempDir();
    const paths = sandboxPaths(root);
    write(paths.credentials, '{{{');
    write(paths.globalConfig, '}}}');

    const result = await detectClaudeCode(paths);
    expect(result.reason).toContain(paths.credentials);
    expect(result.reason).not.toContain(paths.globalConfig);
  });

  it('never echoes the credential body into the reason', async () => {
    const root = tempDir();
    const paths = sandboxPaths(root);
    // Valid JSON overall but with no usable oauth block, plus a token sitting
    // in an unexpected key: the reason must describe the file, never quote it.
    write(paths.credentials, `{ "stray": "${SAMPLE_ACCESS_TOKEN}" `);

    const result = await detectClaudeCode(paths);
    expect(result.loggedIn).toBe(false);
    expectNoSecrets(result);
  });

  it('treats a directory where the credentials file should be as missing', async () => {
    const root = tempDir();
    const paths = sandboxPaths(root);
    mkdirSync(paths.credentials, { recursive: true });
    write(paths.globalConfig, JSON.stringify({ oauthAccount: { emailAddress: 'a@b.test' } }));

    // EISDIR is mapped to "missing", so the oauthAccount fallback still wins.
    expect(await detectClaudeCode(paths)).toMatchObject({ installed: true, loggedIn: true });
  });
});
