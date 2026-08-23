/**
 * Theme mode plumbing.
 *
 * tokens.css already resolves dark under both `prefers-color-scheme` and an
 * explicit `[data-theme]` stamp, so all this module does is decide which stamp
 * (if any) belongs on <html>, and keep the in-app toggle ahead of the async
 * settings round-trip.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ThemeMode } from '@shared/types';

export type ResolvedTheme = 'light' | 'dark';

/** Survives a reload before the main process has answered with settings. */
const STORAGE_KEY = 'claudedeck:theme';

const MODES: ThemeMode[] = ['light', 'dark', 'system'];

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && (MODES as string[]).includes(value);
}

/** Next mode in the toggle cycle: light -> dark -> system -> light. */
export function nextThemeMode(mode: ThemeMode): ThemeMode {
  const at = MODES.indexOf(mode);
  return MODES[(at + 1) % MODES.length] ?? 'system';
}

export function systemTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  return mode === 'system' ? systemTheme() : mode;
}

/**
 * Stamps <html>. `system` removes the attribute entirely rather than writing a
 * resolved value, so the OS can flip the app live without React re-rendering.
 */
export function applyTheme(mode: ThemeMode): ResolvedTheme {
  const resolved = resolveTheme(mode);
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    if (mode === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', mode);
  }
  return resolved;
}

function readStored(): ThemeMode | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isThemeMode(raw) ? raw : null;
  } catch {
    // Storage can be denied; the theme is not important enough to fail on.
    return null;
  }
}

function writeStored(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* ignore */
  }
}

export interface ThemeController {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
  /** Advance one step through light -> dark -> system. */
  cycle: () => void;
}

/**
 * @param preferred the mode from persisted settings; adopted whenever it
 *   changes, so another window (or the tray) can drive the theme.
 * @param persist called with every user-initiated change.
 */
export function useTheme(preferred?: ThemeMode, persist?: (mode: ThemeMode) => void): ThemeController {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    if (isThemeMode(preferred)) return preferred;
    if (typeof window === 'undefined') return 'system';
    return readStored() ?? 'system';
  });
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(mode));
  const lastPreferred = useRef<ThemeMode | undefined>(preferred);

  // Settings arrive after the first paint; adopt them only when they actually
  // change, otherwise a stale prop would fight the local toggle.
  useEffect(() => {
    if (!isThemeMode(preferred)) return;
    if (preferred === lastPreferred.current) return;
    lastPreferred.current = preferred;
    setModeState(preferred);
  }, [preferred]);

  useEffect(() => {
    setResolved(applyTheme(mode));
  }, [mode]);

  useEffect(() => {
    if (mode !== 'system') return;
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setResolved(query.matches ? 'dark' : 'light');
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [mode]);

  const setMode = useCallback(
    (next: ThemeMode) => {
      lastPreferred.current = next;
      setModeState(next);
      writeStored(next);
      persist?.(next);
    },
    [persist],
  );

  const cycle = useCallback(() => setMode(nextThemeMode(mode)), [mode, setMode]);

  return { mode, resolved, setMode, cycle };
}
