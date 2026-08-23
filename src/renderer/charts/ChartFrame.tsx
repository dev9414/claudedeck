/**
 * Shared chrome for every ClaudeDeck chart, plus the palette contract the
 * charts are held to.
 *
 * The frame owns the affordances that are mandatory rather than optional: the
 * title block, the legend slot, and the Table toggle that swaps the plot for a
 * real `<table>`. Three light-mode series slots sit below 3:1 against the light
 * surface, so the table view is the documented relief and every chart must be
 * able to produce one — a chart nested in a frame hands its own table up
 * through `ChartTableFallback` when the view did not supply one.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode, RefObject } from 'react';
import { Icon, cx, type IconName } from '../components/Icon';
import { NO_VALUE } from './scales';
import './charts.css';

// ---------------------------------------------------------------------------
// Palette contract
// ---------------------------------------------------------------------------

/**
 * Categorical slots in fixed order. They are assigned by the order a series
 * arrives and are never re-assigned by rank, so a given account keeps its
 * colour as the numbers move.
 */
export const SERIES_COLORS = [
  'var(--series-1)',
  'var(--series-2)',
  'var(--series-3)',
  'var(--series-4)',
  'var(--series-5)',
  'var(--series-6)',
  'var(--series-7)',
  'var(--series-8)',
] as const;

export const MAX_SERIES = SERIES_COLORS.length;

/** Everything past the eighth slot folds into one neutral "Other" series. */
export const OTHER_COLOR = 'var(--text-muted)';
export const OTHER_LABEL = 'Other';

export function seriesColor(index: number): string {
  if (!Number.isFinite(index) || index < 0 || index >= MAX_SERIES) return OTHER_COLOR;
  return SERIES_COLORS[index] ?? OTHER_COLOR;
}

/** A tint of a series colour, for confidence bands and hover washes. */
export function seriesWash(color: string, percent: number): string {
  return `color-mix(in srgb, ${color} ${percent}%, transparent)`;
}

export type ChartStatus = 'good' | 'warning' | 'serious' | 'critical' | 'neutral';

export interface StatusMeta {
  icon: IconName;
  /** Always rendered next to the glyph: colour never carries meaning alone. */
  label: string;
  color: string;
}

export const STATUS_META: Record<ChartStatus, StatusMeta> = {
  good: { icon: 'check', label: 'ok', color: 'var(--status-good)' },
  warning: { icon: 'alert-triangle', label: 'warning', color: 'var(--status-warning)' },
  serious: { icon: 'alert-triangle', label: 'serious', color: 'var(--status-serious)' },
  critical: { icon: 'alert-octagon', label: 'critical', color: 'var(--status-critical)' },
  neutral: { icon: 'minus', label: 'no data', color: 'var(--status-neutral)' },
};

/** Utilization boundaries the meters and tiles share. */
export const STATUS_THRESHOLDS = { warning: 50, serious: 75, critical: 90 } as const;

export function statusForPct(pct: number | null | undefined): ChartStatus {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return 'neutral';
  if (pct >= STATUS_THRESHOLDS.critical) return 'critical';
  if (pct >= STATUS_THRESHOLDS.serious) return 'serious';
  if (pct >= STATUS_THRESHOLDS.warning) return 'warning';
  return 'good';
}

// ---------------------------------------------------------------------------
// Table model
// ---------------------------------------------------------------------------

export type ChartCell = string | number | boolean | null | undefined;

export interface ChartTableSpec {
  columns?: string[];
  rows: Array<ChartCell[] | Record<string, ChartCell>>;
  caption?: string;
  /** Column indexes holding figures: right aligned and tabular. Inferred when omitted. */
  numericColumns?: number[];
}

/**
 * Three shapes are accepted so a view can hand over whatever it already has:
 * a full spec, a bare array of rows (the first row is the header), or an array
 * of records (keys are the header).
 */
export type ChartTableInput = ChartTableSpec | ChartCell[][] | Array<Record<string, ChartCell>>;

export interface NormalizedTable {
  columns: string[];
  rows: ChartCell[][];
  caption?: string;
  numeric: boolean[];
}

function isCellArray(value: unknown): value is ChartCell[] {
  return Array.isArray(value);
}

export function normalizeTable(input: ChartTableInput | null | undefined): NormalizedTable | null {
  if (!input) return null;
  const spec: ChartTableSpec = Array.isArray(input)
    ? { rows: input as ChartTableSpec['rows'] }
    : input;
  const rawRows = spec.rows ?? [];
  if (rawRows.length === 0) return null;

  let columns: string[] = spec.columns ? [...spec.columns] : [];
  const body: ChartCell[][] = [];
  const first = rawRows[0];

  if (first && !Array.isArray(first)) {
    const keys = columns.length > 0 ? columns : Object.keys(first);
    columns = keys;
    for (const row of rawRows) {
      if (!row || Array.isArray(row)) continue;
      body.push(keys.map((key) => row[key]));
    }
  } else {
    const arrays = rawRows.filter(isCellArray);
    if (columns.length === 0) {
      const head = arrays[0];
      columns = head ? head.map((cell) => (cell == null ? '' : String(cell))) : [];
      body.push(...arrays.slice(1));
    } else {
      body.push(...arrays);
    }
  }

  if (body.length === 0 || columns.length === 0) return null;

  let width = columns.length;
  for (const row of body) width = Math.max(width, row.length);
  while (columns.length < width) columns.push('');

  const padded = body.map((row) => {
    const cells = [...row];
    while (cells.length < width) cells.push(undefined);
    return cells;
  });

  const explicit = spec.numericColumns ? new Set(spec.numericColumns) : null;
  const numeric = columns.map((_column, index) => {
    if (explicit) return explicit.has(index);
    let sawNumber = false;
    for (const row of padded) {
      const cell = row[index];
      // A gap marker in an otherwise numeric column must not cost the column
      // its alignment — views write those as an em dash.
      if (cell == null || cell === '' || cell === NO_VALUE || cell === '-') continue;
      if (typeof cell !== 'number') return false;
      sawNumber = true;
    }
    return sawNumber;
  });

  const table: NormalizedTable = { columns, rows: padded, numeric };
  if (spec.caption) table.caption = spec.caption;
  return table;
}

function formatCell(cell: ChartCell): string {
  if (cell == null || cell === '') return NO_VALUE;
  if (typeof cell === 'number') {
    if (!Number.isFinite(cell)) return NO_VALUE;
    return Number.isInteger(cell) ? String(cell) : String(Number(cell.toFixed(3)));
  }
  if (typeof cell === 'boolean') return cell ? 'yes' : 'no';
  return cell;
}

/** The plain, always-accessible rendering of a chart's numbers. */
export function ChartDataTable({
  table,
  className,
}: {
  table: ChartTableInput | NormalizedTable;
  className?: string;
}) {
  const normalized = 'numeric' in table && Array.isArray(table.numeric)
    ? (table as NormalizedTable)
    : normalizeTable(table as ChartTableInput);
  if (!normalized) return null;
  return (
    <div className={cx('cd-chart-table-wrap', className)}>
      <table className="cd-table">
        {normalized.caption ? <caption>{normalized.caption}</caption> : null}
        <thead>
          <tr>
            {normalized.columns.map((column, index) => (
              <th
                key={`${column}-${index}`}
                scope="col"
                className={normalized.numeric[index] ? 'cd-num' : undefined}
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {normalized.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) =>
                cellIndex === 0 ? (
                  <th key={cellIndex} scope="row">
                    {formatCell(cell)}
                  </th>
                ) : (
                  <td key={cellIndex} className={normalized.numeric[cellIndex] ? 'cd-num' : undefined}>
                    {formatCell(cell)}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Frame context
// ---------------------------------------------------------------------------

export interface ChartFrameContextValue {
  /** Minimum plot height the frame reserved, so a child can adopt it. */
  plotHeight: number;
  /** True when the frame is already rendering a legend the view supplied. */
  hasLegend: boolean;
  tableOpen: boolean;
  /**
   * A child chart offers its own table here. The frame prefers the view's
   * `tableRows` and falls back to this, which is how a chart still ships a
   * table view when the view forgot to write one. The argument must be
   * referentially stable (memoize it) or the frame will re-render forever.
   */
  registerTable(table: ChartTableInput | null): void;
}

const ChartFrameContext = createContext<ChartFrameContextValue | null>(null);

export function useChartFrame(): ChartFrameContextValue | null {
  return useContext(ChartFrameContext);
}

/**
 * Registers a fallback table with the enclosing frame. Outside a frame it
 * renders its own small disclosure so a standalone chart is never left without
 * the numbers.
 */
export function ChartTableFallback({
  table,
  label = 'Table',
}: {
  table: ChartTableInput | null;
  label?: string;
}) {
  const frame = useChartFrame();
  const register = frame?.registerTable;
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!register) return;
    register(table);
    return () => register(null);
  }, [register, table]);

  const normalized = useMemo(() => normalizeTable(table), [table]);
  if (frame || !normalized) return null;

  return (
    <div className="cd-chart-fallback">
      <button
        type="button"
        className="cd-chart-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name={open ? 'activity' : 'layout'} size={13} />
        {open ? 'Hide table' : label}
      </button>
      {open ? <ChartDataTable table={normalized} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared hooks
// ---------------------------------------------------------------------------

/**
 * Width of an element, kept current by a ResizeObserver. Falls back to a
 * sensible width before the first measurement and in environments without the
 * observer (jsdom), so charts never render at zero width.
 */
export function useMeasuredWidth<T extends HTMLElement>(
  fallback = 640,
): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const read = () => {
      const next = Math.round(element.getBoundingClientRect().width);
      setWidth((current) => (current === next ? current : next));
    };
    read();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', read);
      return () => window.removeEventListener('resize', read);
    }
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [ref, width > 0 ? width : fallback];
}

/** A clock that re-renders on an interval, for reset countdowns. */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

// ---------------------------------------------------------------------------
// Legend + empty state
// ---------------------------------------------------------------------------

export interface LegendItem {
  label: string;
  /** A token reference such as `var(--series-1)`; defaults to the neutral. */
  color?: string;
  /** Dashed swatch. Used for anything projected. */
  dashed?: boolean;
  /** Filled band swatch. Used for the confidence cone. */
  band?: boolean;
  /** Secondary text, e.g. `slot 2` or `estimate`. */
  sub?: string;
}

export function ChartLegend({ items, className }: { items: readonly LegendItem[]; className?: string }) {
  if (items.length === 0) return null;
  return (
    <ul className={cx('cd-chart-legend', className)}>
      {items.map((item, index) => (
        <li className="cd-chart-legend-item" key={`${item.label}-${index}`}>
          <span
            className={cx(
              'cd-chart-swatch',
              item.dashed && 'cd-chart-swatch--dashed',
              item.band && 'cd-chart-swatch--band',
            )}
            style={{ color: item.color ?? OTHER_COLOR }}
            aria-hidden="true"
          />
          <span className="cd-chart-legend-label">{item.label}</span>
          {item.sub ? <span className="cd-chart-legend-sub">{item.sub}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/** The quiet state a chart shows instead of an axis with nothing on it. */
export function ChartEmpty({
  icon = 'activity',
  title,
  hint,
  height,
}: {
  icon?: IconName;
  title: string;
  hint?: string;
  height?: number;
}) {
  return (
    <div className="cd-chart-empty" style={height ? { minHeight: height } : undefined}>
      <Icon name={icon} size={18} />
      <p className="cd-chart-empty-title">{title}</p>
      {hint ? <p className="cd-chart-empty-hint">{hint}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------

export interface ChartFrameProps {
  title: ReactNode;
  subtitle?: ReactNode;
  legend?: LegendItem[];
  /** The chart's numbers. Any of the three accepted table shapes. */
  tableRows?: ChartTableInput;
  children?: ReactNode;
  /** Minimum plot height in px. Children may adopt it as their own height. */
  height?: number;
  /** Controls rendered next to the Table toggle. */
  actions?: ReactNode;
  className?: string;
  id?: string;
}

export function ChartFrame({
  title,
  subtitle,
  legend,
  tableRows,
  children,
  height = 220,
  actions,
  className,
  id,
}: ChartFrameProps) {
  const [showTable, setShowTable] = useState(false);
  const [childTable, setChildTable] = useState<ChartTableInput | null>(null);
  const reactId = useId();
  const tableId = `${id ?? 'cd-chart'}-${reactId}-table`;

  const registerTable = useCallback((table: ChartTableInput | null) => {
    setChildTable((current) => (current === table ? current : table));
  }, []);

  const hasLegend = Boolean(legend && legend.length > 0);
  const context = useMemo<ChartFrameContextValue>(
    () => ({ plotHeight: height, hasLegend, tableOpen: showTable, registerTable }),
    [height, hasLegend, showTable, registerTable],
  );

  const table = useMemo(() => normalizeTable(tableRows ?? childTable), [tableRows, childTable]);

  return (
    <figure className={cx('cd-chart', className)} id={id}>
      <figcaption className="cd-chart-head">
        <div className="cd-chart-heading">
          <h3 className="cd-chart-title">{title}</h3>
          {subtitle ? <p className="cd-chart-sub">{subtitle}</p> : null}
        </div>
        <div className="cd-chart-actions">
          {actions}
          {table ? (
            <button
              type="button"
              className="cd-chart-toggle"
              aria-pressed={showTable}
              aria-controls={tableId}
              onClick={() => setShowTable((value) => !value)}
            >
              <Icon name={showTable ? 'activity' : 'layout'} size={13} />
              {showTable ? 'Chart' : 'Table'}
            </button>
          ) : null}
        </div>
      </figcaption>

      {hasLegend && legend ? <ChartLegend items={legend} /> : null}

      <ChartFrameContext.Provider value={context}>
        {/* The plot stays mounted while the table shows: unmounting it would
            retract the child's registered table and take the toggle with it. */}
        <div className="cd-chart-plot" style={{ minHeight: height }} hidden={showTable}>
          {children}
        </div>
      </ChartFrameContext.Provider>

      {showTable && table ? (
        <div id={tableId}>
          <ChartDataTable table={table} />
        </div>
      ) : null}
    </figure>
  );
}

export default ChartFrame;
