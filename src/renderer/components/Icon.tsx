/**
 * The ClaudeDeck icon set.
 *
 * Every glyph in this file was drawn for this product on the grid described
 * below. Nothing here is copied, traced or recalled from Lucide, Feather,
 * Heroicons, Material or any other library — see `docs/ICONOGRAPHY.md` for why
 * that matters and how to add one.
 *
 * ---------------------------------------------------------------------------
 * THE GRID
 * ---------------------------------------------------------------------------
 *
 *   canvas      24 x 24 viewBox. Stroke 2, round caps, round joins, fill none.
 *               `dot` is the single documented exception and is filled.
 *
 *   keyline     No ink outside 2..22 on either axis. A 2px stroke puts 1 unit of
 *               ink on each side of the centre line, so every *centre line*
 *               lives inside 3..21 and the outermost strokes land their outer
 *               edge exactly on the keyline. A ring centred on the canvas
 *               therefore caps at r = 9.
 *
 *   snapping    Every endpoint is an integer coordinate. The one exception is a
 *               point taken off a circle, which must sit on an exact 45deg
 *               diagonal from that circle's centre. For the canonical r = 8 ring
 *               that offset is 8 / sqrt(2) = 5.657, so the diagonal compass
 *               points are 6.343 and 17.657. Any segment that is neither
 *               horizontal nor vertical runs between integer points, and
 *               wherever the shape allows it runs at an exact 45deg — check, x,
 *               the three chevrons, activity, ban and search are pure 45deg.
 *
 *   circles     A glyph's primary ring is centred on (12,12) with an integral
 *               radius (r = 8 unless noted). Secondary round forms — a head, a
 *               corner fillet, a pair of shoulders — also use integer centres
 *               and integer radii, so the whole set shares one compass.
 *
 *   octants     Arc segments begin and end on the 45deg compass points of their
 *               own circle, and a gap in a ring is always a whole number of
 *               45deg octants. At r = 8 one octant is 6.28 units of arc, which
 *               still reads as a deliberate gap at 16px. This is the rule that
 *               makes the set look like this product.
 *
 *   brand       The ClaudeDeck mark is a vertical stem plus a bowl cut into arc
 *               segments. Where an icon naturally allows it, those same two
 *               moves are reused instead of a generic form:
 *                 gauge   dial split into a long and a short segment
 *                 power   3/4 ring with the stem standing in the gap
 *                 refresh 3/4 ring with the arrow head standing in the gap
 *                 pin     domed barrel + flange + stem
 *                 monitor / layout  stem-and-frame, squared off
 *
 *   legibility  Icons render as small as 10px (the toggle knob). So: no detail
 *               finer than 2px, no gap between separate features tighter than
 *               2px, and at most two interior features inside a container.
 *               `info` and the two alert glyphs share one exclamation system — a
 *               2-unit dot and a 4-unit stem held 2 units apart — with `info`
 *               being that system flipped.
 *
 * Everything is stroked with `currentColor`, so a glyph inherits the surrounding
 * text colour. Colour is never the message: in ClaudeDeck a status always ships
 * a shape and a text label alongside the hue.
 */

import type { ReactNode, SVGProps } from 'react';

export type IconName =
  | 'activity'
  | 'alert-octagon'
  | 'alert-triangle'
  | 'ban'
  | 'bolt'
  | 'check'
  | 'chevron'
  | 'chevron-down'
  | 'chevron-left'
  | 'clock'
  | 'copy'
  | 'dot'
  | 'download'
  | 'external-link'
  | 'folder'
  | 'gauge'
  | 'info'
  | 'layout'
  | 'minus'
  | 'monitor'
  | 'moon'
  | 'pause'
  | 'pin'
  | 'play'
  | 'plus'
  | 'power'
  | 'refresh'
  | 'search'
  | 'settings'
  | 'sun'
  | 'trash'
  | 'upload'
  | 'user'
  | 'users'
  | 'x';

/** Joins class names, dropping anything falsy. Shared by every component here. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter((part): part is string => Boolean(part)).join(' ');
}

const GLYPHS: Record<IconName, ReactNode> = {
  /* Three exact 45deg runs: 3,16 -> 8,11 -> 12,15 -> 21,6. A rising trend, and
     the chart half of the chart/table toggle in ChartFrame. */
  activity: <path d="M 3 16 L 8 11 L 12 15 L 21 6" />,

  /* Octagon on the 3/9/15/21 lattice: every edge axis-aligned, every bevel an
     exact 45deg run of 6. Interior is the shared exclamation. */
  'alert-octagon': (
    <>
      <path d="M 9 3 H 15 L 21 9 V 15 L 15 21 H 9 L 3 15 V 9 Z" />
      <path d="M 12 8 V 12" />
      <path d="M 12 16 h 0.01" />
    </>
  ),

  /* Apex (12,3), base 3..21 at y=20. Same exclamation as the octagon, so the two
     alert weights are one family read at two silhouettes. */
  'alert-triangle': (
    <>
      <path d="M 12 3 L 21 20 H 3 Z" />
      <path d="M 12 8 V 12" />
      <path d="M 12 16 h 0.01" />
    </>
  ),

  /* r=8 ring cut by the NW->SE diagonal, corner to corner on the 45deg points. */
  ban: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M 6.343 6.343 L 17.657 17.657" />
    </>
  ),

  /* Six vertices, and the outline is symmetric under a 180deg rotation about
     (12,12): 14,3 <-> 10,21 and 6,13 <-> 18,11 and 11,13 <-> 13,11. */
  bolt: <path d="M 14 3 L 6 13 H 11 L 10 21 L 18 11 H 13 Z" />,

  /* Two exact 45deg runs, 5 down then 11 up. */
  check: <path d="M 4 13 L 9 18 L 20 7" />,

  chevron: <path d="M 9 5 L 16 12 L 9 19" />,
  'chevron-down': <path d="M 5 9 L 12 16 L 19 9" />,

  /* `chevron` mirrored about x=12: 9 -> 15 and 16 -> 8. Same two 7-unit 45deg
     runs, same integer endpoints, so a Back control and a Next control are one
     shape read in two directions rather than one shape used for both. */
  'chevron-left': <path d="M 15 5 L 8 12 L 15 19" />,

  /* r=8 ring; the hands are one polyline, 4 up then 4 right, keeping 2 units
     clear of the ring's inner edge at r=7. */
  clock: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M 12 8 V 12 H 16" />
    </>
  ),

  /* The front sheet is a full 12x12 rect; the sheet behind is only the L that
     would actually be visible, held 4 units clear so the pair never muddies. */
  copy: (
    <>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M 15 3 H 5 A 2 2 0 0 0 3 5 V 15" />
    </>
  ),

  /* The one filled mark in the set: a solid r=3 disc, because a stroked r=3 ring
     would read as a ring and this has to read as a bullet. */
  dot: <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />,

  /* Mirror pair with `upload` about y=12: 20<->4, 15<->9, 10<->14, 3<->21. */
  download: (
    <>
      <path d="M 12 3 V 15" />
      <path d="M 7 10 L 12 15 L 17 10" />
      <path d="M 4 20 H 20" />
    </>
  ),

  /* A frame with its top-right corner removed and an arrow leaving through the
     opening on an exact 45deg. The head is an axis-true right angle rather than
     a splayed barb, so both legs stay on the grid. */
  'external-link': (
    <>
      <path d="M 12 4 H 6 A 2 2 0 0 0 4 6 V 18 A 2 2 0 0 0 6 20 H 18 A 2 2 0 0 0 20 18 V 12" />
      <path d="M 14 10 L 21 3" />
      <path d="M 15 3 H 21 V 9" />
    </>
  ),

  /* One closed outline: left wall up, r=2 fillet, tab, the 3:4 shoulder, then
     the body's three remaining fillets. */
  folder: (
    <path d="M 3 18 V 6 A 2 2 0 0 1 5 4 H 9 L 12 8 H 19 A 2 2 0 0 1 21 10 V 18 A 2 2 0 0 1 19 20 H 5 A 2 2 0 0 1 3 18 Z" />
  ),

  /* A quota window, in the mark's own vocabulary: a dial split into a long
     segment (W->N, two octants) and a short one (NE->E, one octant) with a
     one-octant gap between them. The ring is r=9, the widest the keyline
     allows, which is what buys the needle its 2 units of clearance. The needle
     is deliberately off-axis — a vertical one turns the glyph into a mushroom. */
  gauge: (
    <>
      <path d="M 3 12 A 9 9 0 0 1 12 3" />
      <path d="M 18.364 5.636 A 9 9 0 0 1 21 12" />
      <path d="M 12 12 L 9 9" />
    </>
  ),

  /* The alert exclamation, inverted: dot above, stem below. */
  info: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M 12 8 h 0.01" />
      <path d="M 12 12 V 16" />
    </>
  ),

  /* Frame + header rule + one column rule: two interior features, no more. The
     table half of the chart/table toggle. */
  layout: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M 3 10 H 21" />
      <path d="M 12 10 V 19" />
    </>
  ),

  minus: <path d="M 5 12 H 19" />,

  monitor: (
    <>
      <rect x="3" y="3" width="18" height="13" rx="2" />
      <path d="M 12 16 V 19" />
      <path d="M 7 19 H 17" />
    </>
  ),

  /* Two identical r=8 circles offset by exactly (4,-4), a 45deg displacement.
     They cross at (8.709,4.709) and (19.292,15.292); the crescent is the 221deg
     limb of the first closed by the 139deg limb of the second, which leaves it
     5.66 units thick at the waist. */
  moon: <path d="M 8.709 4.709 A 8 8 0 1 0 19.292 15.292 A 8 8 0 0 1 8.709 4.709 Z" />,

  pause: (
    <>
      <path d="M 9 4 V 20" />
      <path d="M 15 4 V 20" />
    </>
  ),

  /* A thumbtack: an r=3 domed barrel, a flange wider than the barrel, and the
     needle on the axis. The flange has to out-measure the dome — when the dome
     is the widest part the glyph reads as an umbrella instead. */
  pin: (
    <>
      <path d="M 9 12 V 7 A 3 3 0 0 1 15 7 V 12" />
      <path d="M 5 12 H 19" />
      <path d="M 12 12 V 21" />
    </>
  ),

  play: <path d="M 8 4 L 20 12 L 8 20 Z" />,

  plus: (
    <>
      <path d="M 12 5 V 19" />
      <path d="M 5 12 H 19" />
    </>
  ),

  /* r=8 ring with a two-octant gap across the top and the stem standing in it. */
  power: (
    <>
      <path d="M 17.657 6.343 A 8 8 0 1 1 6.343 6.343" />
      <path d="M 12 3 V 10" />
    </>
  ),

  /* 270deg of r=8 ring ending at N, with the arrow head standing free in the
     quadrant-wide gap rather than barbed onto the arc: on a curve of this radius
     a swept-back barb re-crosses its own shaft before it is 2px long. The head
     is an axis-true right angle whose vertex sits on the ring at (19,8), so the
     glyph stays centred on (12,12) and reads correctly while `cd-spin` turns
     it. */
  refresh: (
    <>
      <path d="M 20 12 A 8 8 0 1 1 12 4" />
      <path d="M 19 5 V 8 H 16" />
    </>
  ),

  /* Lens centred on the canvas at r=6; the handle leaves on the exact 45deg
     diagonal and is rooted at (16,16), inside the ring's stroke, so the joint
     never opens a hairline. */
  search: (
    <>
      <circle cx="12" cy="12" r="6" />
      <path d="M 16 16 L 20 20" />
    </>
  ),

  /* Two rails, two travelling handles. Bars rather than knobs: a 2px ring fills
     in at this size, a crossing bar does not. */
  settings: (
    <>
      <path d="M 3 8 H 21" />
      <path d="M 3 16 H 21" />
      <path d="M 8 5 V 11" />
      <path d="M 16 13 V 19" />
    </>
  ),

  /* An r=3 core with eight rays running from radius 7 to radius 9 — the whole
     radial budget, since the keyline caps a centred ring at r=9 and the core
     plus its 2-unit clearance spends the first 6. The four diagonal rays sit on
     the exact 45deg points of those two radii: 7/sqrt(2) gives 7.05 and 16.95,
     9/sqrt(2) gives 5.636 and 18.364. */
  sun: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M 12 5 V 3" />
      <path d="M 19 12 H 21" />
      <path d="M 12 19 V 21" />
      <path d="M 5 12 H 3" />
      <path d="M 16.95 7.05 L 18.364 5.636" />
      <path d="M 16.95 16.95 L 18.364 18.364" />
      <path d="M 7.05 16.95 L 5.636 18.364" />
      <path d="M 7.05 7.05 L 5.636 5.636" />
    </>
  ),

  /* Lid, handle, body, and exactly two slots 4 units apart — the tightest the
     2px rule allows. The body walls start on the lid line so the joint merges
     instead of leaving a hairline. */
  trash: (
    <>
      <path d="M 3 6 H 21" />
      <path d="M 9 6 V 4 H 15 V 6" />
      <path d="M 5 6 V 19 A 2 2 0 0 0 7 21 H 17 A 2 2 0 0 0 19 19 V 6" />
      <path d="M 10 11 V 17" />
      <path d="M 14 11 V 17" />
    </>
  ),

  upload: (
    <>
      <path d="M 4 4 H 20" />
      <path d="M 7 14 L 12 9 L 17 14" />
      <path d="M 12 9 V 21" />
    </>
  ),

  /* Head on an integer centre with an integer radius; the shoulders are an r=9
     arc between two integer points, which lands its apex 2 units clear of the
     head. */
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M 4 21 A 9 9 0 0 1 20 21" />
    </>
  ),

  /* Two figures staggered in depth, the right one set 3 units higher and its
     shoulders 4 units higher. Not two overlapping bodies (an overlap becomes a
     smudge at 16px) and deliberately not a symmetric pair over one shoulder
     line, which the eye resolves into a face. */
  users: (
    <>
      <circle cx="7" cy="10" r="3" />
      <circle cx="17" cy="7" r="3" />
      <path d="M 3 21 A 6 6 0 0 1 11 21" />
      <path d="M 13 17 A 6 6 0 0 1 21 17" />
    </>
  ),

  x: (
    <>
      <path d="M 6 6 L 18 18" />
      <path d="M 18 6 L 6 18" />
    </>
  ),
};

export const ICON_NAMES = Object.keys(GLYPHS) as IconName[];

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name' | 'children'> {
  name: IconName;
  /** Square edge in px. */
  size?: number;
  /**
   * Accessible name. Supply it only when the icon is the *sole* carrier of
   * meaning; next to a text label leave it off so the glyph stays decorative.
   */
  title?: string;
}

export function Icon({ name, size = 16, title, className, ...rest }: IconProps) {
  const labelled = typeof title === 'string' && title.length > 0;
  return (
    <svg
      className={cx('cd-icon', className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={labelled ? 'img' : undefined}
      aria-hidden={labelled ? undefined : true}
      focusable="false"
      {...rest}
    >
      {labelled ? <title>{title}</title> : null}
      {GLYPHS[name]}
    </svg>
  );
}

export default Icon;
