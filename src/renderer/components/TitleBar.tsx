/**
 * The window title bar: brand, the active-account chip, and the global
 * controls (palette, refresh, auto-switch, theme).
 *
 * The bar is the app's drag region, so every interactive child opts back out
 * via `-webkit-app-region: no-drag` in base.css.
 */

import type { Account, ThemeMode } from '@shared/types';
import { Icon, type IconName } from './Icon';
import { Badge, UsageStatusBadge } from './Badge';
import { IconButton } from './Button';
import { Logo } from './Logo';

const THEME_ICON: Record<ThemeMode, IconName> = { light: 'sun', dark: 'moon', system: 'monitor' };
const THEME_WORD: Record<ThemeMode, string> = { light: 'Light', dark: 'Dark', system: 'System' };

export interface TitleBarProps {
  /** The account Claude Code is currently authenticated as, if any. */
  account: Account | null;
  onOpenPalette: (seed?: string) => void;
  onRefresh: () => void;
  refreshing?: boolean;
  autoSwitchRunning: boolean;
  onToggleAutoSwitch: () => void;
  themeMode: ThemeMode;
  nextThemeMode: ThemeMode;
  onCycleTheme: () => void;
  safeMode?: boolean;
  /** Fixtures instead of a real install — always surfaced, never silent. */
  demoMode?: boolean;
  /** No preload bridge at all (browser-only development). */
  stubbed?: boolean;
}

export function TitleBar({
  account,
  onOpenPalette,
  onRefresh,
  refreshing = false,
  autoSwitchRunning,
  onToggleAutoSwitch,
  themeMode,
  nextThemeMode,
  onCycleTheme,
  safeMode = false,
  demoMode = false,
  stubbed = false,
}: TitleBarProps) {
  return (
    <header className="cd-titlebar">
      <span className="cd-brand">
        {/* The mark, not a generic glyph: this is the one place the product
            names itself, and it draws itself on once at launch. */}
        <Logo size={18} animate />
        ClaudeDeck
      </span>

      {account ? (
        <button
          type="button"
          className="cd-chip"
          onClick={() => onOpenPalette('switch')}
          aria-label={`Active account ${account.email}, slot ${account.slot}. Open the account switcher`}
        >
          <Icon name="user" size={14} />
          <span className="cd-chip-email">{account.alias ?? account.email}</span>
          <span className="cd-chip-slot">#{account.slot}</span>
          <Icon name="chevron-down" size={14} />
        </button>
      ) : (
        <button
          type="button"
          className="cd-chip cd-chip--empty"
          onClick={() => onOpenPalette('switch')}
          aria-label="No active account. Open the account switcher"
        >
          <Icon name="alert-triangle" size={14} />
          <span className="cd-chip-email">No active account</span>
        </button>
      )}

      {account ? <UsageStatusBadge status={account.usageStatus} /> : null}

      {safeMode ? (
        <Badge tone="warning" icon="alert-triangle" title="Every disk write is refused while safe mode is on.">
          Safe mode
        </Badge>
      ) : null}
      {demoMode ? (
        <Badge tone="info" icon="info" title="Synthetic fixtures — not a real Claude Code install.">
          Demo data
        </Badge>
      ) : null}
      {stubbed ? (
        <Badge tone="warning" icon="alert-triangle" title="window.claudedeck is missing; the UI is running on a stub.">
          No bridge
        </Badge>
      ) : null}

      <span className="cd-spacer" />

      <button type="button" className="cd-search-btn" onClick={() => onOpenPalette()}>
        <Icon name="search" size={14} />
        <span>Commands</span>
        <span className="cd-kbd" aria-hidden="true">
          Ctrl K
        </span>
      </button>

      <IconButton
        icon={autoSwitchRunning ? 'pause' : 'play'}
        label={autoSwitchRunning ? 'Stop auto-switch' : 'Start auto-switch'}
        variant="ghost"
        onClick={onToggleAutoSwitch}
        aria-pressed={autoSwitchRunning}
      />
      <IconButton
        icon="refresh"
        label="Refresh usage for all accounts"
        variant="ghost"
        busy={refreshing}
        onClick={onRefresh}
      />
      <IconButton
        icon={THEME_ICON[themeMode]}
        label={`Theme: ${THEME_WORD[themeMode]}. Switch to ${THEME_WORD[nextThemeMode]}`}
        variant="ghost"
        onClick={onCycleTheme}
      />
    </header>
  );
}

export default TitleBar;
