/**
 * Badges.
 *
 * A status tone always renders an icon next to its text, so the meaning
 * survives grayscale, forced-colors, and every CVD type. Only the two chrome
 * tones (`neutral`, `accent`) may opt out with `icon={null}`.
 */

import type { ReactNode } from 'react';
import type { UsageStatus } from '@shared/types';
import { Icon, cx, type IconName } from './Icon';

export type BadgeTone = 'neutral' | 'accent' | 'info' | 'good' | 'warning' | 'serious' | 'critical';

const TONE_ICON: Record<BadgeTone, IconName> = {
  neutral: 'dot',
  accent: 'dot',
  info: 'info',
  good: 'check',
  warning: 'alert-triangle',
  serious: 'alert-triangle',
  critical: 'alert-octagon',
};

const CHROME_TONES: BadgeTone[] = ['neutral', 'accent'];

export interface BadgeProps {
  tone?: BadgeTone;
  /** Override the tone's default glyph. `null` drops it — chrome tones only. */
  icon?: IconName | null;
  children: ReactNode;
  title?: string;
  className?: string;
  id?: string;
}

export function Badge({ tone = 'neutral', icon, children, title, className, id }: BadgeProps) {
  const suppressed = icon === null && CHROME_TONES.includes(tone);
  const glyph = suppressed ? null : (icon ?? TONE_ICON[tone]);
  return (
    <span id={id} title={title} className={cx('cd-badge', `cd-badge--${tone}`, className)}>
      {glyph ? <Icon name={glyph} size={12} /> : null}
      <span>{children}</span>
    </span>
  );
}

/** How each `UsageStatus` presents: tone, glyph, and the words a user reads. */
export const USAGE_STATUS_META: Record<
  UsageStatus,
  { tone: BadgeTone; icon: IconName; label: string; description: string }
> = {
  ok: { tone: 'good', icon: 'check', label: 'Healthy', description: 'Usage reported and within quota.' },
  unavailable: {
    tone: 'neutral',
    icon: 'info',
    label: 'No data',
    description: 'Usage could not be read on the last poll.',
  },
  'token-expired': {
    tone: 'warning',
    icon: 'clock',
    label: 'Token expired',
    description: 'The stored access token needs a refresh.',
  },
  'rate-limited': {
    tone: 'critical',
    icon: 'alert-octagon',
    label: 'Rate limited',
    description: 'A quota window is exhausted.',
  },
  quarantined: {
    tone: 'serious',
    icon: 'ban',
    label: 'Quarantined',
    description: 'The refresh token is dead; sign in again to restore it.',
  },
  'no-quota': {
    tone: 'neutral',
    icon: 'minus',
    label: 'No quota',
    description: 'API-key account — it has no subscription window to track.',
  },
};

export function UsageStatusBadge({ status, className }: { status: UsageStatus; className?: string }) {
  const meta = USAGE_STATUS_META[status];
  return (
    <Badge tone={meta.tone} icon={meta.icon} title={meta.description} className={className}>
      {meta.label}
    </Badge>
  );
}

export default Badge;
