/**
 * The zero/blocked-state block: a glyph, a heading, a sentence of explanation,
 * and at most one call to action. Views use it for "nothing here yet" and for
 * recoverable failures alike, so the tone never gets invented per-view.
 */

import type { ReactNode } from 'react';
import { Icon, cx, type IconName } from './Icon';

export interface EmptyStateProps {
  title: string;
  description?: ReactNode;
  icon?: IconName;
  /** `warning` and `info` only tint the glyph well; the words still carry it. */
  tone?: 'neutral' | 'info' | 'warning';
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  title,
  description,
  icon = 'info',
  tone = 'neutral',
  action,
  className,
}: EmptyStateProps) {
  return (
    <div className={cx('cd-empty', tone !== 'neutral' && `cd-empty--${tone}`, className)}>
      <span className="cd-empty-icon">
        <Icon name={icon} size={20} />
      </span>
      <h2 className="cd-h2">{title}</h2>
      {description ? <p className="cd-empty-body">{description}</p> : null}
      {action ? <div className="cd-row">{action}</div> : null}
    </div>
  );
}

export default EmptyState;
