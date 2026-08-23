#!/usr/bin/env node
/**
 * Palette gate.
 *
 * Parses the real `--series-*`, `--surface-1` and `--status-*` values out of
 * src/renderer/theme/tokens.css and re-runs the color checks the palette was
 * chosen against, for both light and dark. It reads the stylesheet rather than
 * a hardcoded list on purpose: the point is to fail when someone edits a token,
 * which is exactly when a hardcoded copy would still pass.
 *
 *   node scripts/validate-palette.mjs
 *
 * Exits non-zero on any FAIL. WARNs are printed but do not fail the build —
 * they carry an obligation (visible labels or a table view), not a defect.
 *
 * Math: OKLab (Ottosson), Machado/Oliveira/Fernandes 2009 CVD transforms at
 * severity 1.0, WCAG 2.1 relative luminance. ΔE is Euclidean in OKLab ×100.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKENS = resolve(HERE, '..', 'src', 'renderer', 'theme', 'tokens.css');

// Thresholds the palette was selected against.
const L_BAND = { light: [0.43, 0.77], dark: [0.48, 0.67] };
const CHROMA_FLOOR = 0.1;
const CVD_TARGET = 8.0; // min(protan, deutan) on adjacent pairs
const NORMAL_FLOOR = 15.0; // unsimulated, adjacent pairs
const CONTRAST_TARGET = 3.0;

const MACHADO = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritan: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};

const hex2srgb = (h) => {
  const s = h.trim().replace(/^#/, '');
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16) / 255);
};
const s2lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lin = (h) => hex2srgb(h).map(s2lin);
const relLum = (h) => {
  const [r, g, b] = lin(h);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

function oklabFromLin([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
const oklch = (h) => {
  const [L, a, b] = oklabFromLin(lin(h));
  return [L, Math.hypot(a, b)];
};
const simulate = (h, kind) => {
  const v = lin(h);
  return MACHADO[kind].map((row) => row.reduce((acc, k, i) => acc + k * v[i], 0));
};
const deltaE = (h1, h2, kind) => {
  const a = oklabFromLin(kind ? simulate(h1, kind) : lin(h1));
  const b = oklabFromLin(kind ? simulate(h2, kind) : lin(h2));
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * 100;
};

/**
 * Pull one custom property out of a specific block of the stylesheet. The light
 * values live in the first `:root {` block; the dark ones in `:root[data-theme='dark']`.
 */
function extract(css, blockRe, names) {
  const block = css.match(blockRe);
  if (!block) throw new Error(`could not find block ${blockRe} in tokens.css`);
  const body = block[0];
  const out = {};
  for (const name of names) {
    const m = body.match(new RegExp(`--${name}\\s*:\\s*(#[0-9a-fA-F]{6})`));
    if (!m) throw new Error(`token --${name} missing or not a 6-digit hex in ${blockRe}`);
    out[name] = m[1].toLowerCase();
  }
  return out;
}

const SERIES = Array.from({ length: 8 }, (_, i) => `series-${i + 1}`);
const STATUS = ['status-good', 'status-warning', 'status-serious', 'status-critical'];

function run(mode, palette, surface) {
  const rows = [];
  let failed = false;
  const [lo, hi] = L_BAND[mode];

  const outOfBand = palette.filter((h) => {
    const L = oklch(h)[0];
    return L < lo || L > hi;
  });
  rows.push([outOfBand.length === 0, 'Lightness band', outOfBand.length === 0 ? `all ${palette.length} inside L ${lo}–${hi}` : `outside: ${outOfBand.join(', ')}`]);

  const lowChroma = palette.filter((h) => oklch(h)[1] < CHROMA_FLOOR);
  rows.push([lowChroma.length === 0, 'Chroma floor', lowChroma.length === 0 ? `all >= ${CHROMA_FLOOR}` : `below: ${lowChroma.join(', ')}`]);

  // Adjacent pairs — the default pairlist for stacks, bars and lines.
  const pairs = palette.slice(0, -1).map((_, i) => [i, i + 1]);

  let worstCvd = Infinity;
  let worstCvdPair = '';
  for (const [i, j] of pairs) {
    const d = Math.min(deltaE(palette[i], palette[j], 'protan'), deltaE(palette[i], palette[j], 'deutan'));
    if (d < worstCvd) {
      worstCvd = d;
      worstCvdPair = `${palette[i]}↔${palette[j]}`;
    }
  }
  const cvdOk = worstCvd >= CVD_TARGET;
  rows.push([cvdOk, 'CVD separation', `worst adjacent ${worstCvdPair} ΔE ${worstCvd.toFixed(1)} (target >= ${CVD_TARGET})`]);

  let worstNorm = Infinity;
  let worstNormPair = '';
  for (const [i, j] of pairs) {
    const d = deltaE(palette[i], palette[j]);
    if (d < worstNorm) {
      worstNorm = d;
      worstNormPair = `${palette[i]}↔${palette[j]}`;
    }
  }
  const normOk = worstNorm >= NORMAL_FLOOR;
  rows.push([normOk, 'Normal-vision floor', `worst adjacent ${worstNormPair} ΔE ${worstNorm.toFixed(1)} (floor >= ${NORMAL_FLOOR})`]);

  const lowContrast = palette
    .map((h) => [h, contrast(h, surface)])
    .filter(([, c]) => c < CONTRAST_TARGET);

  console.log(`\nPalette (${mode}, surface ${surface}): ${palette.length} slots`);
  for (const [pass, label, detail] of rows) {
    if (!pass) failed = true;
    console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${label.padEnd(22)} ${detail}`);
  }
  if (lowContrast.length) {
    console.log(
      `  [WARN] ${'Contrast vs surface'.padEnd(22)} below ${CONTRAST_TARGET}:1 — relief required ` +
        `(direct labels or table view): ${lowContrast.map(([h, c]) => `${h} ${c.toFixed(2)}`).join(', ')}`,
    );
  } else {
    console.log(`  [PASS] ${'Contrast vs surface'.padEnd(22)} all >= ${CONTRAST_TARGET}:1`);
  }
  return failed;
}

function main() {
  const css = readFileSync(TOKENS, 'utf8');

  const lightBlock = /:root\s*\{[\s\S]*?\n\}/;
  const darkBlock = /:root\[data-theme='dark'\]\s*\{[\s\S]*?\n\}/;

  const light = extract(css, lightBlock, [...SERIES, 'surface-1', ...STATUS]);
  const dark = extract(css, darkBlock, [...SERIES, 'surface-1']);

  let failed = false;
  failed = run('light', SERIES.map((k) => light[k]), light['surface-1']) || failed;
  failed = run('dark', SERIES.map((k) => dark[k]), dark['surface-1']) || failed;

  // Status colors are checked for contrast only — they are a reserved role, not
  // a categorical set, so CVD separation between them is not the relevant gate.
  console.log('\nStatus roles (contrast only; sub-3:1 is by design and mitigated by icon + label)');
  for (const key of STATUS) {
    const hex = light[key];
    console.log(
      `  ${key.replace('status-', '').padEnd(9)} ${hex}  light ${contrast(hex, light['surface-1']).toFixed(2)}:1` +
        `  dark ${contrast(hex, dark['surface-1']).toFixed(2)}:1`,
    );
  }

  console.log(failed ? '\n✗ palette gate FAILED\n' : '\n✓ palette gate passed\n');
  process.exit(failed ? 1 : 0);
}

main();
