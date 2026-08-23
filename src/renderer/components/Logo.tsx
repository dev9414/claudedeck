/**
 * The ClaudeDeck mark.
 *
 * Geometry is identical to `assets/logo.svg` — a "D" whose bowl is cut into
 * three arc segments, one per quota window, with the leading segment carrying
 * the accent. Keep the two in step if either is edited.
 *
 * Every path declares `pathLength="100"`, which normalises its length so the
 * draw-in can be expressed as a dash offset from 100 to 0 without anyone having
 * to measure an elliptical arc. The stroke colours come from the theme tokens,
 * so the mark re-themes with the rest of the app rather than being a fixed
 * bitmap.
 */

import { useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';
import './logo.css';

export interface LogoProps {
  /** Rendered edge length in px. The mark is square. */
  size?: number;
  /** Draw the strokes on in sequence on mount. Ignored under reduced motion. */
  animate?: boolean;
  /** Render in a single inherited colour instead of the three segment hues. */
  mono?: boolean;
  /**
   * Decorative marks are hidden from assistive tech; pass a label when the mark
   * is the only thing identifying the app (a splash screen, an icon-only link).
   */
  label?: string;
  className?: string;
}

/** The four strokes, in draw order. `hue` is the token each segment wears. */
const STROKES: ReadonlyArray<{ d: string; hue: string }> = [
  { d: 'M 19 13.5 L 19 50.5', hue: 'var(--accent)' },
  { d: 'M 19 13.5 A 26 18.5 0 0 1 40.55 21.66', hue: 'var(--accent)' },
  { d: 'M 42.37 23.89 A 26 18.5 0 0 1 41.52 41.25', hue: 'var(--series-1)' },
  { d: 'M 39.49 43.39 A 26 18.5 0 0 1 19 50.5', hue: 'var(--series-3)' },
];

/**
 * Local rather than shared: the mark is used on the splash path before the app
 * shell (and its hooks) has mounted, so it cannot depend on app-level state.
 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return reduced;
}

export function Logo({ size = 28, animate = false, mono = false, label, className }: LogoProps): ReactElement {
  const reduced = usePrefersReducedMotion();
  const titleId = useId();
  // Once drawn, stay drawn: a re-render must not replay the animation.
  const drawn = useRef(false);
  const playing = animate && !reduced && !drawn.current;
  useEffect(() => {
    if (playing) drawn.current = true;
  }, [playing]);

  const classes = ['cd-logo', playing ? 'cd-logo--draw' : '', className].filter(Boolean).join(' ');

  return (
    <svg
      className={classes}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      role={label ? 'img' : undefined}
      aria-hidden={label ? undefined : true}
      aria-labelledby={label ? titleId : undefined}
      focusable="false"
    >
      {label ? <title id={titleId}>{label}</title> : null}
      <g strokeWidth={7} strokeLinecap="round" pathLength={100}>
        {STROKES.map((stroke, i) => (
          <path
            key={stroke.d}
            d={stroke.d}
            pathLength={100}
            stroke={mono ? 'currentColor' : stroke.hue}
            style={playing ? ({ '--cd-logo-i': i } as CSSProperties) : undefined}
          />
        ))}
      </g>
    </svg>
  );
}

export default Logo;
