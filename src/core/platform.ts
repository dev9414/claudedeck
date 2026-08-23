/**
 * Which OS we are actually running on.
 *
 * `process.platform` alone is not enough: under WSL it reports `linux`, but the
 * install we manage lives in a Linux-shaped config home while the desktop shell
 * around it is Windows. Several behaviours key off that distinction (credential
 * storage, XDG paths, how we reveal a file), so WSL is its own `PlatformKind`.
 */

import { readFileSync } from 'node:fs';
import type { PlatformKind } from '@shared/types';

/** Both WSL1 and WSL2 stamp the Microsoft kernel build into `/proc/version`. */
const WSL_KERNEL_MARKER = /microsoft/i;

/**
 * Resolve the running platform.
 *
 * Arguments exist only so tests can drive every branch without spoofing
 * globals; production callers use `detectPlatform()`.
 *
 * Anything neither Darwin nor Win32 is reported as Linux (or WSL). `ClaudePaths`
 * has no "unknown" bucket, and the BSD/SunOS layout is XDG-shaped anyway, so
 * that is the useful default rather than a lie.
 */
export function detectPlatform(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): PlatformKind {
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  return isWsl(env) ? 'wsl' : 'linux';
}

function isWsl(env: NodeJS.ProcessEnv): boolean {
  // Set by the WSL init for every shell it starts, and free to read — worth
  // checking before touching the filesystem.
  if (env['WSL_DISTRO_NAME'] || env['WSL_INTEROP']) return true;
  try {
    return WSL_KERNEL_MARKER.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    // No procfs: a real Windows/macOS host, a trimmed container image, or a
    // sandbox that denies the read. None of those are WSL.
    return false;
  }
}
