/**
 * Counted figures.
 *
 * When a quota reading changes, the figure above the bar changes with it. A
 * number that swaps instantly gives no clue whether it moved by one point or
 * forty; a number that runs to its new value does, and the direction of the run
 * is the whole message. That is the only reason this exists — it is not a
 * flourish, and it is off entirely under reduced motion.
 *
 * The ramp uses the same curve as `--ease-entrance` in motion.css, evaluated
 * here rather than approximated, so a counted figure and the bar underneath it
 * are on exactly the same trajectory.
 */

import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from './useReducedMotion';

// ---------------------------------------------------------------------------
// Easing
// ---------------------------------------------------------------------------

/** The four control-point coordinates of a CSS `cubic-bezier()`. */
export type Curve = readonly [x1: number, y1: number, x2: number, y2: number];

/** `--ease-entrance`. Keep in step with motion.css. */
export const EASE_ENTRANCE: Curve = [0.16, 0.84, 0.44, 1];

/**
 * One axis of a cubic Bézier with endpoints pinned at 0 and 1, which is the
 * shape CSS guarantees. Expanded rather than factored: it is evaluated a few
 * dozen times per frame at most, and the expanded form is the one that reads
 * like the formula it is.
 */
function axis(c1: number, c2: number, t: number): number {
  const inv = 1 - t;
  return 3 * inv * inv * t * c1 + 3 * inv * t * t * c2 + t * t * t;
}

/**
 * Builds the progress -> eased-progress function for a `cubic-bezier()`.
 *
 * A CSS curve is parametric, so the x axis has to be inverted before the y axis
 * can be read. Bisection does that in a fixed 20 halvings — resolving x to
 * about one part in a million, far finer than any figure this drives, and with
 * none of the divergence a Newton step can hit on a curve with a flat region.
 *
 * The y axis is deliberately left unclamped so an overshoot curve keeps its
 * overshoot.
 */
export function cubicBezier(curve: Curve): (progress: number) => number {
  const [x1, y1, x2, y2] = curve;
  if (x1 === y1 && x2 === y2) return (progress) => progress;

  return (progress) => {
    if (!(progress > 0)) return 0;
    if (progress >= 1) return 1;
    let low = 0;
    let high = 1;
    let t = progress;
    for (let step = 0; step < 20; step += 1) {
      if (axis(x1, x2, t) < progress) low = t;
      else high = t;
      t = (low + high) / 2;
    }
    return axis(y1, y2, t);
  };
}

const easeEntrance = cubicBezier(EASE_ENTRANCE);

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/** Long enough to read the direction of travel, short enough not to wait on. */
export const COUNT_UP_MS = 400;

export interface CountUpOptions {
  /** Ramp length in milliseconds. */
  duration?: number;
  /**
   * Run the first value up from zero as well. Off by default: on a cold mount
   * there is no previous reading, so a count from zero would be inventing a
   * change that never happened.
   */
  animateOnMount?: boolean;
  /** Force the straight-to-the-value path, whatever the media query says. */
  disabled?: boolean;
}

/**
 * Follows `target`, arriving over `duration` on the entrance curve.
 *
 * Interruptions resume from wherever the figure currently reads rather than
 * restarting, so a burst of polls produces one continuous run instead of a
 * stutter. Non-finite targets are passed straight through — there is nothing
 * to animate toward.
 *
 * @returns the value to render this frame; equal to `target` once settled.
 */
export function useCountUp(target: number, options: CountUpOptions = {}): number {
  const { duration = COUNT_UP_MS, animateOnMount = false, disabled = false } = options;
  const reduced = useReducedMotion();

  const [display, setDisplay] = useState<number>(() => (animateOnMount ? 0 : target));
  // The last value actually painted. Read, never subscribed to: the animation
  // needs its own starting point, not a re-render when it changes.
  const shown = useRef<number>(display);

  useEffect(() => {
    const from = shown.current;

    const settle = () => {
      shown.current = target;
      setDisplay(target);
    };

    if (
      reduced ||
      disabled ||
      !Number.isFinite(target) ||
      !Number.isFinite(from) ||
      !(duration > 0) ||
      from === target ||
      typeof requestAnimationFrame !== 'function'
    ) {
      settle();
      return;
    }

    // The clock is the frame timestamp itself, so the first frame is progress
    // zero no matter how long the browser took to schedule it.
    let started: number | null = null;
    let frame = requestAnimationFrame(function step(now: number) {
      if (started === null) started = now;
      const progress = Math.min(1, (now - started) / duration);
      if (progress >= 1) {
        settle();
        return;
      }
      const value = from + (target - from) * easeEntrance(progress);
      shown.current = value;
      setDisplay(value);
      frame = requestAnimationFrame(step);
    });

    return () => cancelAnimationFrame(frame);
  }, [target, duration, reduced, disabled]);

  return display;
}

export default useCountUp;
