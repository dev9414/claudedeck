# Iconography

Every glyph ClaudeDeck ships lives in one file, `src/renderer/components/Icon.tsx`,
and every one of them was drawn for this product on the grid described here.
Nothing in the set is imported, vendored, traced or recalled from Lucide,
Feather, Heroicons, Material, Phosphor or any other library.

This page is the contract. If you add an icon, it has to hold to it.

---

## Why the set is hand-authored

Three reasons, in order of how much they actually matter.

**1. Zero runtime dependencies is a project rule.** ClaudeDeck ships no runtime
deps at all — see `docs/ARCHITECTURE.md`. An icon library is the softest place
to break that rule and the easiest one to talk yourself into, because it looks
like an asset rather than code. It is code: a package, a version, a transitive
tree, a licence, and a supply-chain surface inside an app that reads OAuth
credentials off disk. The set below is 35 glyphs of inline SVG. It costs less
than the dependency would.

**2. The set has to look like this product.** The ClaudeDeck mark (`assets/logo.svg`)
is a vertical stem plus a bowl cut into arc segments — the stem is the deck, the
segments are the quota windows, and the leading one carries the accent because
it is the one that binds first. That vocabulary, the split arc especially,
reappears in `gauge`, `power`, `refresh` and `pin`. A general-purpose library
cannot do that, because a general-purpose library is drawn for everybody.

**3. Colour cannot carry meaning here, so shape has to.** `src/renderer/theme/tokens.css`
says it plainly: three light-mode series slots and the warning/serious status
steps sit below 3:1 on the light surface, so every status cue ships an icon and
a text label. When the glyph is load-bearing for accessibility, "close enough,
grabbed from a set" is not a standard. Owning the geometry means we can hold
`alert-triangle`, `alert-octagon` and `info` to one deliberate exclamation
system rather than three libraries' worth of accidents.

Colour itself never appears in this file. Glyphs are stroked with
`currentColor` and inherit from the surrounding text, so the only colour source
in the renderer stays `tokens.css`. Never put a hex in an icon.

---

## The grid

### Canvas

24 x 24 viewBox. `stroke-width` 2, `stroke-linecap="round"`,
`stroke-linejoin="round"`, `fill="none"`. These are set once on the `<svg>` in
`Icon`, not per glyph — a glyph is only path data.

### Keyline

No ink outside **2..22** on either axis.

A 2px stroke puts 1 unit of ink on each side of its centre line, so this is a
statement about centre lines: **every coordinate you write lives inside 3..21**,
and the outermost strokes land their outer edge exactly on the keyline. The
consequence worth memorising: a ring centred on the canvas caps at **r = 9**.

Two exceptions that fall out of the geometry rather than out of taste:

- A round join at a sharp vertex (the apex of `alert-triangle`, the corner of an
  arrow head) pushes ink up to 1 unit past the vertex. Vertices on the keyline
  are fine; vertices outside 3..21 are not.
- A 45deg cap projects `1/sqrt(2)` in each axis, not 1, so diagonal terminals
  have 0.29 units in hand. Do not spend it.

### Snapping

**Every endpoint is an integer coordinate.** The single exception is a point
taken off a circle, which must sit on an exact 45deg diagonal from that circle's
centre.

Segments that are neither horizontal nor vertical run between integer points,
and wherever the shape allows, they run at an exact 45deg. `check`, `x`,
`chevron`, `chevron-down`, `chevron-left`, `activity`, `ban` and `search` are
pure 45deg — `activity` is three consecutive 45deg runs and nothing else.

`chevron-left` is `chevron` mirrored about `x = 12`, and it exists because a
Back control must not wear the glyph its Next control wears. A direction is
meaning here, so it gets its own path rather than a `rotate(180deg)` at the call
site: a transform is invisible to anyone reading the JSX, and the two `chevron`
buttons that used to sit on one row pointing the same way are what that costs.

### Circles

A glyph's primary ring is centred on **(12,12)** with an integral radius, `r = 8`
unless the glyph says otherwise (`search` is 6, `gauge` is 9, `sun`'s core is 3).
Secondary round forms — a head, a corner fillet, a pair of shoulders — also use
integer centres and integer radii, so the whole set shares one compass.

The canonical r = 8 compass, which you will paste a lot:

| point | coords          | point | coords          |
| ----- | --------------- | ----- | --------------- |
| N     | `12 4`          | S     | `12 20`         |
| NE    | `17.657 6.343`  | SW    | `6.343 17.657`  |
| E     | `20 12`         | W     | `4 12`          |
| SE    | `17.657 17.657` | NW    | `6.343 6.343`   |

`5.657` is `8 / sqrt(2)`. For other radii: `r = 9` gives `6.364` (so `5.636` and
`18.364`), `r = 7` gives `4.950` (so `7.05` and `16.95`), `r = 6` gives `4.243`.

### Octants

**Arc segments begin and end on the 45deg compass points of their own circle,
and a gap in a ring is always a whole number of 45deg octants.**

This is the rule that makes the set look like ClaudeDeck rather than like
generic line icons. It is also a legibility rule: at r = 8 one octant is 6.28
units of arc, which still reads as a deliberate gap when the glyph renders at
16px. A 2-unit gap does not — it closes up and looks like a rendering fault.

Worked examples:

- `gauge` — dial of six octants: `W -> N` (two, the long segment), a one-octant
  gap, `NE -> E` (one, the short segment). The split arc, straight off the mark.
- `power` — 3/4 ring, `NE -> ... -> NW` clockwise, with a two-octant gap across
  the top and the stem standing in it.
- `refresh` — 3/4 ring, `E -> ... -> N` clockwise, gap across the NE quadrant.

### Legibility

Icons render as small as **10px** (the `Toggle` knob) and most commonly at 12–16.
So:

- No detail finer than **2 units**.
- No gap between two separate features tighter than **2 units**.
- At most **two interior features** inside a container shape.

That budget is tighter than it sounds and it is the reason several glyphs look
the way they do:

- **`sun`** is an r = 3 core with eight rays running radius 7 to radius 9. The
  keyline caps a centred ring at r = 9; the core plus its 2-unit clearance
  spends the first 6; two units of ray is what is left. A bigger core buys a
  1-unit gap and the rays fuse into the disc at 16px.
- **`users`** is two figures staggered in depth, not a symmetric pair over one
  shoulder line. The symmetric version is legible and also unmistakably a face.
- **`pin`** puts a flange wider than the dome. When the dome is the widest part,
  the glyph is an umbrella.
- **`refresh`** stands its arrow head free in the gap instead of barbing it onto
  the arc. On a curve of this radius a swept-back barb re-crosses its own shaft
  before it is 2 units long, and the junction turns into a blob.
- **`trash`** gets exactly two slots, 4 units apart, which is the tightest a
  2-unit ink gap allows.

### The exclamation system

`alert-triangle`, `alert-octagon` and `info` share one interior, so the three
read as one family:

- stem `M 12 8 V 12`, dot `M 12 16 h 0.01` — for both alerts.
- `info` is that system flipped: dot at 8, stem 12 to 16.

The dot is a zero-length subpath. With `stroke-linecap="round"` that renders as
a disc of exactly one stroke width, which is the minimum legible mark and needs
no fill.

### The one filled glyph

`dot` is a solid `r = 3` disc with `fill="currentColor" stroke="none"`. It is the
only place `fill: none` is overridden, because a stroked r = 3 ring reads as a
ring and this has to read as a bullet. Do not add a second exception without a
reason that good.

---

## The component

```tsx
<Icon name="alert-triangle" />                       // decorative, aria-hidden
<Icon name="refresh" size={18} className="cd-spin" /> // sized, animated
<Icon name="trash" title="Delete account" />          // role="img" + <title>
```

- `name: IconName` — the union in `Icon.tsx`. It is exhaustive; a typo is a
  compile error, and `Record<IconName, ReactNode>` means a name added to the
  union without a glyph is also a compile error.
- `size?: number` — square edge in px, default 16.
- `title?: string` — **only** when the icon is the sole carrier of meaning. With
  a title the SVG gets `role="img"` and a `<title>` child; without one it gets
  `aria-hidden="true"` so a screen reader does not read the glyph next to a text
  label twice.
- Everything else spreads onto the `<svg>`.

Also exported: `cx()` (the class-name joiner used across the renderer, it lives
here for historical reasons) and `ICON_NAMES` (every name, for galleries and
tests).

Anything that spins must be centred on (12,12), because `.cd-spin` rotates the
whole element. `refresh` is built around that.

---

## Adding an icon

1. **Check the union first.** Thirty-five names is already a lot for an app this
   size. Reusing `activity` for a chart toggle beats drawing a 35th glyph.
2. **Add the name to `IconName`**, alphabetically. TypeScript will now fail
   until `GLYPHS` has an entry, which is the point.
3. **Draw it on the grid.** Start from the compass table. Reach for the brand
   vocabulary — stem, split arc, whole-octant gap — before reaching for a
   generic form, and reach for an exact 45deg before an arbitrary slope.
4. **Write down the construction.** Every glyph in the file carries a comment
   saying what it is made of and, where it matters, what was tried and rejected.
   That comment is the reason the next person can extend the set instead of
   guessing at it.
5. **Verify the keyline.** Walk every coordinate you wrote: all of them inside
   3..21. Then check the arc bulges, which are not endpoints — an arc through a
   compass point reaches that point's radius.
6. **Look at it at 10, 12, 16 and 48px, side by side with its neighbours.** Not
   at 48 alone. Most of the rework in this set came from small sizes: a glyph
   that is elegant at 48 and mush at 12 is a broken glyph. A contact sheet of
   `ICON_NAMES` at four sizes is the fastest way to see it, and it is also the
   fastest way to catch the other failure mode — a glyph that is fine on its own
   and collides semantically with one three cells over.
7. **`npm run typecheck`.**

### Things that are not allowed

- A raw hex, anywhere. `currentColor` only; the colour source is `tokens.css`.
- A new dependency, including a dev-time one that generates glyphs.
- Copying path data out of another icon set, or writing from memory something
  you recognise as another set's glyph. If you can name the library it came
  from, it does not go in.
- More than two interior features, or any detail under 2 units.
- Per-glyph `stroke-width`. The weight is set once on the `<svg>`; a glyph that
  needs a different weight is a glyph drawn at the wrong scale.
