/**
 * Ctrl/Cmd+K command palette.
 *
 * The component is generic — the shell supplies the action list — so the only
 * behaviour here is matching, keyboard navigation, and the dialog contract:
 * focus moves into the input on open, Tab cannot leave, Escape closes, and the
 * element that opened the palette gets focus back.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useReducedMotion } from '../hooks/useReducedMotion';
import { Icon, type IconName } from './Icon';
import { useEscapeKey, useFocusTrap } from './Modal';

export interface Command {
  id: string;
  title: string;
  /** Section heading; also matched, so "acc" finds the Accounts group. */
  group: string;
  icon?: IconName;
  /** Right-aligned detail: a shortcut, a slot number, a current value. */
  hint?: string;
  /** Extra words to match on that are not worth showing. */
  keywords?: string;
  disabled?: boolean;
  run: () => void | Promise<void>;
}

/**
 * Subsequence match with a bias toward word starts and unbroken runs. Returns
 * null when `query` is not a subsequence of `target`.
 */
export function fuzzyScore(query: string, target: string): number | null {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return 0;
  const hay = target.toLowerCase();
  let cursor = 0;
  let score = 0;
  let streak = 0;

  for (const ch of needle) {
    if (ch === ' ') {
      streak = 0;
      continue;
    }
    const at = hay.indexOf(ch, cursor);
    if (at < 0) return null;
    const before = at > 0 ? hay.charAt(at - 1) : '';
    const boundary = at === 0 || before === ' ' || before === '-' || before === ':' || before === '/';
    streak = at === cursor ? streak + 1 : 0;
    score += (boundary ? 6 : 1) + streak * 2;
    cursor = at + 1;
  }

  // Nudge shorter targets ahead when the match is otherwise equal.
  return score - Math.max(0, hay.length - needle.length) * 0.05;
}

function haystack(command: Command): string {
  return [command.title, command.group, command.hint ?? '', command.keywords ?? ''].join(' ');
}

export function filterCommands(commands: Command[], query: string): Command[] {
  if (query.trim().length === 0) return commands;
  return commands
    .map((command, index) => ({ command, index, score: fuzzyScore(query, haystack(command)) }))
    .filter((row): row is { command: Command; index: number; score: number } => row.score !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((row) => row.command);
}

/** Installs the Ctrl/Cmd+K accelerator. */
export function useCommandPaletteHotkey(onToggle: () => void): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'k') return;
      if (!event.metaKey && !event.ctrlKey) return;
      if (event.altKey) return;
      event.preventDefault();
      onToggle();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onToggle]);
}

/**
 * The result list reveals row by row, which is what makes the list read as one
 * thing arriving rather than a block appearing. The cascade is capped: past a
 * handful of rows the delay stops carrying information and starts being a
 * queue the user waits in.
 */
const STAGGER_CAP = 7;

/** `--cd-row` is consumed by `.cd-palette-item` in motion.css. */
type RowStyle = CSSProperties & { '--cd-row': number };

function rowStyle(index: number, reduced: boolean): RowStyle {
  return { '--cd-row': reduced ? 0 : Math.min(index, STAGGER_CAP) };
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  commands: Command[];
  /** Seed text, e.g. the account chip opens the palette on "switch". */
  initialQuery?: string;
  placeholder?: string;
}

export function CommandPalette({
  open,
  onClose,
  commands,
  initialQuery = '',
  placeholder = 'Search commands…',
}: CommandPaletteProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState(initialQuery);
  const [active, setActive] = useState(0);
  const reducedMotion = useReducedMotion();

  useFocusTrap(panelRef, open);
  useEscapeKey(open, onClose);

  // Each opening starts fresh, from whatever seed the caller passed.
  useEffect(() => {
    if (!open) return;
    setQuery(initialQuery);
    setActive(0);
  }, [open, initialQuery]);

  const results = useMemo(() => filterCommands(commands, query), [commands, query]);

  useEffect(() => {
    setActive((current) => (current < results.length ? current : 0));
  }, [results.length]);

  // Keep the highlighted row in view during arrow-key navigation.
  useEffect(() => {
    const list = listRef.current;
    if (!open || !list) return;
    const node = list.querySelector<HTMLElement>('[data-active="true"]');
    // jsdom has no scrollIntoView, and this is pure polish — never throw for it.
    if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' });
  }, [active, open, results.length]);

  const runAt = useCallback(
    (index: number) => {
      const command = results[index];
      if (!command || command.disabled) return;
      onClose();
      void command.run();
    },
    [results, onClose],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (results.length === 0) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActive((i) => (i + 1) % results.length);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActive((i) => (i - 1 + results.length) % results.length);
      } else if (event.key === 'Home') {
        event.preventDefault();
        setActive(0);
      } else if (event.key === 'End') {
        event.preventDefault();
        setActive(results.length - 1);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        runAt(active);
      }
    },
    [results.length, active, runAt],
  );

  if (!open || typeof document === 'undefined') return null;

  const listId = 'cd-palette-list';
  // Group headings only make sense in the unfiltered list; once results are
  // ranked by score a group can be split, and a repeated heading reads as noise.
  const grouped = query.trim().length === 0;
  const activeCommand = results[active];
  const activeId = activeCommand ? `cd-palette-opt-${activeCommand.id}` : undefined;
  let lastGroup: string | null = null;

  return createPortal(
    <div
      className="cd-overlay cd-palette-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className="cd-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="cd-palette-search">
          <Icon name="search" />
          <input
            className="cd-palette-input"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={activeId}
            aria-label="Search commands"
            autoComplete="off"
            spellCheck={false}
            placeholder={placeholder}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
          />
          <span className="cd-kbd" aria-hidden="true">
            Esc
          </span>
        </div>

        <div className="cd-palette-list" id={listId} role="listbox" aria-label="Commands" ref={listRef}>
          {results.length === 0 ? (
            <p className="cd-palette-empty">No command matches “{query}”.</p>
          ) : (
            results.map((command, index) => {
              const heading = grouped && command.group !== lastGroup ? command.group : null;
              lastGroup = command.group;
              const selected = index === active;
              return (
                <div key={command.id} role="presentation">
                  {heading ? (
                    <div className="cd-palette-group" role="presentation">
                      {heading}
                    </div>
                  ) : null}
                  <div
                    id={`cd-palette-opt-${command.id}`}
                    role="option"
                    aria-selected={selected}
                    aria-disabled={command.disabled || undefined}
                    data-active={selected ? 'true' : undefined}
                    className="cd-palette-item"
                    style={rowStyle(index, reducedMotion)}
                    onMouseMove={() => setActive(index)}
                    onClick={() => runAt(index)}
                  >
                    <Icon name={command.icon ?? 'chevron'} />
                    <span className="cd-palette-title">{command.title}</span>
                    {command.hint ? <span className="cd-palette-hint">{command.hint}</span> : null}
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div className="cd-palette-foot">
          <span>
            <span className="cd-kbd">↑</span> <span className="cd-kbd">↓</span> to move
          </span>
          <span>
            <span className="cd-kbd">↵</span> to run
          </span>
          <span className="cd-spacer" />
          <span>
            {results.length} of {commands.length}
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default CommandPalette;
