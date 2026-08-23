/**
 * `prefers-reduced-motion`, as a live subscription.
 *
 * motion.css already neutralises every CSS animation and transition under the
 * reduce preference. This hook is the other half: the motion the app drives
 * from JavaScript — the counted figures, the palette's per-row stagger — has to
 * read the same setting, and has to keep reading it, because a user can change
 * it while the window is open and would reasonably expect the app to comply
 * without a restart.
 *
 * There is no local override and no setting for this. The OS preference is the
 * answer.
 */

import { useSyncExternalStore } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

/**
 * The media query list, or null where there is no `matchMedia` to ask — the
 * main process, a test runner, an older embedder. A missing query is not the
 * same as "reduce": it means unknown, and unknown resolves to the default.
 */
function motionQuery(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  return window.matchMedia(QUERY);
}

/** One-shot read, for code outside a component. */
export function prefersReducedMotion(): boolean {
  return motionQuery()?.matches === true;
}

function subscribe(onChange: () => void): () => void {
  const query = motionQuery();
  if (!query) return () => {};

  // `addEventListener` is the modern pair; the deprecated one is kept for
  // embedders and test doubles that only ever implemented `addListener`.
  if (typeof query.addEventListener === 'function') {
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }
  if (typeof query.addListener === 'function') {
    query.addListener(onChange);
    return () => query.removeListener(onChange);
  }
  return () => {};
}

/**
 * True when the user has asked the system for reduced motion.
 *
 * Backed by `useSyncExternalStore`, so the value is read during render rather
 * than committed by an effect — a count-up never gets one frame of animation
 * before finding out it was not wanted.
 */
export function useReducedMotion(): boolean {
  // The server snapshot is the conservative one: render as if motion were
  // already finished, never as if it were about to start.
  return useSyncExternalStore(subscribe, prefersReducedMotion, () => true);
}

export default useReducedMotion;
