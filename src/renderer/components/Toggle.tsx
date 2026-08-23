/**
 * A labelled on/off switch.
 *
 * Implemented as `role="switch"` on a real button: the knob position plus a
 * check glyph carry the state, so the accent fill is reinforcement rather than
 * the only signal.
 */

import { useId } from 'react';
import type { ReactNode } from 'react';
import { Icon, cx } from './Icon';

export interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Always required; pass `labelHidden` when the surrounding row already says it. */
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  labelHidden?: boolean;
  id?: string;
  className?: string;
  /** Extra text appended to the accessible name, e.g. a reason it is blocked. */
  hint?: string;
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled = false,
  labelHidden = false,
  id,
  className,
  hint,
}: ToggleProps) {
  const auto = useId();
  const rootId = id ?? auto;
  const labelId = `${rootId}-label`;
  const descId = `${rootId}-desc`;

  return (
    <button
      type="button"
      id={rootId}
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelHidden ? undefined : labelId}
      aria-label={labelHidden && typeof label === 'string' ? label : undefined}
      aria-describedby={description ? descId : undefined}
      title={hint}
      disabled={disabled}
      className={cx('cd-toggle', className)}
      onClick={() => onChange(!checked)}
    >
      <span className="cd-toggle-track" aria-hidden="true">
        <span className="cd-toggle-knob">{checked ? <Icon name="check" size={10} /> : null}</span>
      </span>
      <span className={cx('cd-toggle-text', labelHidden && 'cd-sr-only')}>
        <span className="cd-toggle-label" id={labelId}>
          {label}
        </span>
        {description ? (
          <span className="cd-toggle-desc" id={descId}>
            {description}
          </span>
        ) : null}
      </span>
    </button>
  );
}

export default Toggle;
