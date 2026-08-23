/**
 * Buttons.
 *
 * `Button` is the labelled control; `IconButton` is the icon-only variant and
 * makes its accessible name a required prop, because an unlabelled glyph is the
 * single easiest a11y regression to ship.
 */

import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Icon, cx, type IconName } from './Icon';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  trailingIcon?: IconName;
  /** Swaps the leading icon for a spinner and blocks activation. */
  busy?: boolean;
  /** Stretch to the container width. */
  block?: boolean;
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    icon,
    trailingIcon,
    busy = false,
    block = false,
    className,
    children,
    disabled,
    type = 'button',
    ...rest
  },
  ref,
) {
  const leading = busy ? <Icon name="refresh" className="cd-spin" /> : icon ? <Icon name={icon} /> : null;
  return (
    <button
      ref={ref}
      // eslint-disable-next-line react/button-has-type -- narrowed by the prop type
      type={type}
      disabled={disabled === true || busy}
      aria-busy={busy || undefined}
      className={cx('cd-btn', `cd-btn--${variant}`, `cd-btn--${size}`, block && 'cd-btn--block', className)}
      {...rest}
    >
      {leading}
      {children === undefined || children === null ? null : <span className="cd-btn-label">{children}</span>}
      {trailingIcon ? <Icon name={trailingIcon} /> : null}
    </button>
  );
});

export interface IconButtonProps
  extends Omit<ButtonProps, 'icon' | 'trailingIcon' | 'children' | 'aria-label'> {
  icon: IconName;
  /** Accessible name and tooltip. Required — the glyph carries no text. */
  label: string;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, className, ...rest },
  ref,
) {
  return (
    <Button
      ref={ref}
      icon={icon}
      aria-label={label}
      title={label}
      className={cx('cd-btn--icon', className)}
      {...rest}
    />
  );
});

export default Button;
