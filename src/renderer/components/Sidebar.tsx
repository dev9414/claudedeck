/**
 * Primary navigation, and the single source of truth for the view list.
 *
 * `ViewId` and `NAV_ITEMS` live here rather than in App so the command palette
 * and the router can share them without importing the shell.
 */

import { Icon, type IconName } from './Icon';
import { IconButton } from './Button';

export type ViewId = 'dashboard' | 'accounts' | 'timeline' | 'automation' | 'settings';

export interface NavItem {
  id: ViewId;
  label: string;
  icon: IconName;
  /** Spoken/tooltip description; also the palette hint. */
  hint: string;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: 'layout', hint: 'Live quota for the active account' },
  { id: 'accounts', label: 'Accounts', icon: 'users', hint: 'Add, alias, reorder, and switch accounts' },
  { id: 'timeline', label: 'Timeline', icon: 'activity', hint: 'Usage history and burn rate' },
  { id: 'automation', label: 'Automation', icon: 'bolt', hint: 'Auto-switch rules and recent decisions' },
  { id: 'settings', label: 'Settings', icon: 'settings', hint: 'Paths, safety, notifications' },
];

export function isViewId(value: string): value is ViewId {
  return NAV_ITEMS.some((item) => item.id === value);
}

export interface SidebarProps {
  current: ViewId;
  onNavigate: (id: ViewId) => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  /** Small trailing counts, e.g. accounts managed or pending events. */
  counts?: Partial<Record<ViewId, number>>;
  /** Rendered under the nav when expanded — used for the version string. */
  note?: string;
}

export function Sidebar({
  current,
  onNavigate,
  collapsed = false,
  onToggleCollapsed,
  counts,
  note,
}: SidebarProps) {
  return (
    <div className="cd-sidebar">
      <nav className="cd-nav" aria-label="Primary">
        <ul>
          {NAV_ITEMS.map((item) => {
            const active = item.id === current;
            const count = counts?.[item.id];
            return (
              <li key={item.id}>
                <button
                  type="button"
                  className="cd-nav-item"
                  aria-current={active ? 'page' : undefined}
                  aria-label={collapsed ? item.label : undefined}
                  title={collapsed ? item.label : item.hint}
                  onClick={() => onNavigate(item.id)}
                >
                  <Icon name={item.icon} />
                  <span className="cd-nav-label">{item.label}</span>
                  {typeof count === 'number' ? (
                    <span className="cd-nav-count cd-num" aria-hidden="true">
                      {count}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="cd-spacer" />

      {note ? <p className="cd-sidebar-note">{note}</p> : null}

      {onToggleCollapsed ? (
        <div className="cd-sidebar-foot">
          <IconButton
            icon="chevron"
            label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            variant="ghost"
            size="sm"
            aria-expanded={!collapsed}
            onClick={onToggleCollapsed}
            style={collapsed ? undefined : { transform: 'rotate(180deg)' }}
          />
        </div>
      ) : null}
    </div>
  );
}

export default Sidebar;
