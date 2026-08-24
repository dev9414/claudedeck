/**
 * The application shell: title bar, primary nav, and the routed view area.
 *
 * Routing is a hash string rather than a router dependency — the app has a
 * handful of flat destinations and zero runtime deps is a project rule. Views
 * are lazy so the dashboard paints before the chart code is parsed, and each
 * one reads state through `useDeckState` instead of taking props, so the shell
 * never has to know what a view needs.
 */

import { Component, Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import type { ComponentType, ErrorInfo, ReactNode } from 'react';
import type { Account, SwitchStrategy, ThemeMode } from '@shared/types';
import { useDeckState } from './hooks/useDeckState';
import { useTheme, nextThemeMode } from './theme/useTheme';
import { Icon } from './components/Icon';
import { Button } from './components/Button';
import { EmptyState } from './components/EmptyState';
import { Sidebar, NAV_ITEMS, isViewId, type ViewId } from './components/Sidebar';
import { TitleBar } from './components/TitleBar';
import { CommandPalette, useCommandPaletteHotkey, type Command } from './components/CommandPalette';

const VIEWS: Record<ViewId, ComponentType> = {
  dashboard: lazy(() => import('./views/Dashboard')),
  accounts: lazy(() => import('./views/Accounts')),
  timeline: lazy(() => import('./views/Timeline')),
  planner: lazy(() => import('./views/Planner')),
  automation: lazy(() => import('./views/Automation')),
  settings: lazy(() => import('./views/Settings')),
};

const Onboarding = lazy(() => import('./views/Onboarding'));

const SIDEBAR_KEY = 'claudedeck:sidebar-collapsed';

function readHashView(): ViewId {
  if (typeof window === 'undefined') return 'dashboard';
  const raw = window.location.hash.replace(/^#\/?/, '').trim().toLowerCase();
  return isViewId(raw) ? raw : 'dashboard';
}

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_KEY) === 'true';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Failure containment
// ---------------------------------------------------------------------------

interface BoundaryProps {
  children: ReactNode;
  onRetry: () => void;
}

interface BoundaryState {
  message: string | null;
}

/** Keeps one bad view from taking the whole shell down with it. */
class ViewBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { message: null };

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { message: error instanceof Error ? error.message : 'This view failed to render.' };
  }

  // Intentionally not logged: renderer errors can carry arbitrary state.
  override componentDidCatch(_error: Error, _info: ErrorInfo): void {}

  private readonly retry = () => {
    this.setState({ message: null });
    this.props.onRetry();
  };

  override render(): ReactNode {
    if (this.state.message === null) return this.props.children;
    return (
      <EmptyState
        icon="alert-octagon"
        tone="warning"
        title="This view stopped responding"
        description={this.state.message}
        action={
          <Button variant="primary" icon="refresh" onClick={this.retry}>
            Try again
          </Button>
        }
      />
    );
  }
}

/**
 * The routed-view placeholder. A view's shape is known — a head over a card —
 * so the honest placeholder is that shape, shimmering, rather than a spinner
 * that says only "wait". The words still go to the accessibility tree; the
 * blocks are decoration and are hidden from it.
 */
function ViewLoading() {
  return (
    <div className="cd-view-skeleton" role="status" aria-live="polite">
      <span className="cd-sr-only">Loading view…</span>
      <span className="cd-skeleton cd-skeleton--head" aria-hidden="true" />
      <span className="cd-skeleton cd-skeleton--block" aria-hidden="true" />
      <span className="cd-skeleton cd-skeleton--line" aria-hidden="true" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

export function App() {
  const { state, loading, error, api, stubbed, reload } = useDeckState();

  const persistTheme = useCallback(
    (mode: ThemeMode) => {
      void api.updateSettings({ theme: mode });
    },
    [api],
  );
  const theme = useTheme(state?.settings.theme, persistTheme);
  const themeMode = theme.mode;
  const cycleTheme = theme.cycle;

  const [view, setView] = useState<ViewId>(readHashView);
  const [collapsed, setCollapsed] = useState<boolean>(readCollapsed);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteSeed, setPaletteSeed] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [boundaryKey, setBoundaryKey] = useState(0);

  // --- routing -------------------------------------------------------------

  const navigate = useCallback((next: ViewId) => {
    setView(next);
    if (typeof window !== 'undefined') window.location.hash = `#/${next}`;
  }, []);

  useEffect(() => {
    const onHashChange = () => setView(readHashView());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(SIDEBAR_KEY, String(next));
      } catch {
        /* a lost preference is not worth an error */
      }
      return next;
    });
  }, []);

  // --- actions -------------------------------------------------------------

  const say = useCallback((message: string) => setAnnouncement(message), []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const result = await api.refreshUsage();
      say(result.ok ? 'Usage refreshed.' : `Refresh failed: ${result.error}`);
    } finally {
      setRefreshing(false);
    }
  }, [api, say]);

  const switchTo = useCallback(
    async (target: number | undefined, strategy: SwitchStrategy | undefined, label: string) => {
      const result = await api.switchAccount({ target, strategy, reason: 'manual' });
      if (result.switched && result.to) say(`Switched to ${result.to.email}.`);
      else say(`${label} did not switch: ${result.error ?? result.reason}`);
    },
    [api, say],
  );

  const toggleAutoSwitch = useCallback(async () => {
    const running = state?.autoSwitchRunning === true;
    const result = running ? await api.stopAutoSwitch() : await api.startAutoSwitch();
    if (result.ok) say(running ? 'Auto-switch stopped.' : 'Auto-switch started.');
    else say(`Auto-switch change failed: ${result.error}`);
  }, [api, state?.autoSwitchRunning, say]);

  const openPalette = useCallback((seed?: string) => {
    setPaletteSeed(seed ?? '');
    setPaletteOpen(true);
  }, []);

  const togglePalette = useCallback(() => {
    setPaletteSeed('');
    setPaletteOpen((open) => !open);
  }, []);

  useCommandPaletteHotkey(togglePalette);

  // --- commands ------------------------------------------------------------

  const accounts: Account[] = useMemo(() => state?.accounts ?? [], [state]);
  const activeAccount = useMemo(
    () => accounts.find((a) => a.active) ?? accounts.find((a) => a.slot === state?.activeSlot) ?? null,
    [accounts, state?.activeSlot],
  );

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = NAV_ITEMS.map((item) => ({
      id: `view:${item.id}`,
      title: `Go to ${item.label}`,
      group: 'Navigate',
      icon: item.icon,
      hint: item.hint,
      keywords: `open ${item.id}`,
      run: () => navigate(item.id),
    }));

    for (const account of accounts) {
      list.push({
        id: `switch:${account.slot}`,
        title: `Switch to ${account.email}`,
        group: 'Switch account',
        icon: 'user',
        hint: account.active ? 'active' : `slot ${account.slot}`,
        keywords: `account ${account.alias ?? ''} ${account.slot}`,
        disabled: account.active,
        run: () => void switchTo(account.slot, undefined, `Switch to slot ${account.slot}`),
      });
    }

    list.push(
      {
        id: 'switch:next',
        title: 'Rotate to the next account',
        group: 'Switch account',
        icon: 'chevron',
        keywords: 'rotate cycle',
        run: () => void switchTo(undefined, 'next', 'Rotate'),
      },
      {
        id: 'switch:best',
        title: 'Switch to the account with the most headroom',
        group: 'Switch account',
        icon: 'bolt',
        keywords: 'best headroom quota',
        run: () => void switchTo(undefined, 'best', 'Best'),
      },
      {
        id: 'switch:next-available',
        title: 'Switch to the next available account',
        group: 'Switch account',
        icon: 'check',
        keywords: 'available not exhausted',
        run: () => void switchTo(undefined, 'next-available', 'Next available'),
      },
      {
        id: 'auto:toggle',
        title: state?.autoSwitchRunning === true ? 'Stop auto-switch' : 'Start auto-switch',
        group: 'Automation',
        icon: state?.autoSwitchRunning === true ? 'pause' : 'play',
        hint: state?.autoSwitchRunning === true ? 'running' : 'stopped',
        keywords: 'rotation engine watcher',
        run: () => void toggleAutoSwitch(),
      },
      {
        id: 'usage:refresh',
        title: 'Refresh usage',
        group: 'App',
        icon: 'refresh',
        keywords: 'poll quota reload',
        run: () => void refresh(),
      },
      {
        id: 'theme:cycle',
        title: `Theme: switch to ${nextThemeMode(themeMode)}`,
        group: 'App',
        icon: themeMode === 'dark' ? 'moon' : themeMode === 'light' ? 'sun' : 'monitor',
        hint: `now ${themeMode}`,
        keywords: 'dark light appearance',
        run: () => {
          cycleTheme();
          say(`Theme set to ${nextThemeMode(themeMode)}.`);
        },
      },
    );

    return list;
  }, [accounts, cycleTheme, navigate, refresh, say, state?.autoSwitchRunning, switchTo, themeMode, toggleAutoSwitch]);

  // --- render --------------------------------------------------------------

  if (loading && !state) {
    return (
      <div className="cd-splash" role="status" aria-live="polite">
        <Icon name="refresh" size={22} className="cd-spin" />
        <p>Reading your Claude Code install…</p>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="cd-splash">
        <EmptyState
          icon="alert-octagon"
          tone="warning"
          title="ClaudeDeck could not read its state"
          description={error ?? 'The main process did not answer.'}
          action={
            <Button variant="primary" icon="refresh" onClick={() => void reload()}>
              Retry
            </Button>
          }
        />
      </div>
    );
  }

  if (!state.onboarded) {
    return (
      <Suspense fallback={<ViewLoading />}>
        <Onboarding />
      </Suspense>
    );
  }

  const Current = VIEWS[view];

  return (
    <div className="cd-app" data-sidebar={collapsed ? 'collapsed' : 'expanded'}>
      <a className="cd-skip" href="#cd-main">
        Skip to content
      </a>

      <TitleBar
        account={activeAccount}
        onOpenPalette={openPalette}
        onRefresh={() => void refresh()}
        refreshing={refreshing}
        autoSwitchRunning={state.autoSwitchRunning}
        onToggleAutoSwitch={() => void toggleAutoSwitch()}
        themeMode={themeMode}
        nextThemeMode={nextThemeMode(themeMode)}
        onCycleTheme={cycleTheme}
        safeMode={state.settings.safeMode}
        demoMode={state.demoMode && !stubbed}
        stubbed={stubbed}
      />

      <Sidebar
        current={view}
        onNavigate={navigate}
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
        counts={{ accounts: state.accounts.length }}
        note={`v${state.version}`}
      />

      <main className="cd-main" id="cd-main" tabIndex={-1}>
        <ViewBoundary key={`${view}:${boundaryKey}`} onRetry={() => setBoundaryKey((n) => n + 1)}>
          <Suspense fallback={<ViewLoading />}>
            {/* Keyed on the view so the cross-fade replays on every swap, and
                inside Suspense so it starts when the view lands, not when the
                chunk starts loading. */}
            <div className="cd-view-enter" key={view}>
              <Current />
            </div>
          </Suspense>
        </ViewBoundary>
      </main>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
        initialQuery={paletteSeed}
      />

      <div className="cd-live" role="status" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}

export default App;
