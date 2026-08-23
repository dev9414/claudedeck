/**
 * Modal dialog, plus the focus-trap primitive the command palette reuses.
 *
 * A dialog is the only place in ClaudeDeck allowed to trap the keyboard, so the
 * trap lives here and nowhere else: it moves focus in on open, keeps Tab inside
 * while open, and returns focus to the element that opened it on close.
 */

import { useCallback, useEffect, useId, useRef } from 'react';
import type { MouseEvent as ReactMouseEvent, ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { cx } from './Icon';
import { IconButton } from './Button';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

type MaybeCheckable = HTMLElement & { checkVisibility?: (options?: object) => boolean };

function isVisible(node: HTMLElement): boolean {
  if (node.hasAttribute('hidden')) return false;
  if (node.getAttribute('aria-hidden') === 'true') return false;
  // checkVisibility is the only reliable answer, and it does not exist in jsdom;
  // without layout there is nothing to hide, so assume visible there.
  const check = (node as MaybeCheckable).checkVisibility;
  return typeof check === 'function' ? check.call(node) : true;
}

/** Tabbable descendants of `root`, in document order, skipping hidden ones. */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(isVisible);
}

/**
 * Confines Tab to `ref` while `active`, and restores the previously focused
 * element when it deactivates or unmounts.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const root = ref.current;
    if (!root) return;

    const restoreTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const initial = focusableWithin(root)[0] ?? root;
    initial.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const items = focusableWithin(root);
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        event.preventDefault();
        root.focus();
        return;
      }
      const current = document.activeElement;
      if (event.shiftKey && (current === first || current === root)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    };

    // A click elsewhere (or a programmatic focus) can still escape Tab handling.
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof Node && !root.contains(target)) {
        (focusableWithin(root)[0] ?? root).focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn);
      if (restoreTo && restoreTo.isConnected) restoreTo.focus();
    };
  }, [ref, active]);
}

/** Calls `onClose` on Escape while `active`. */
export function useEscapeKey(active: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [active, onClose]);
}

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** Set false for destructive confirmations that need an explicit choice. */
  dismissOnOverlay?: boolean;
  closeLabel?: string;
  className?: string;
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  dismissOnOverlay = true,
  closeLabel = 'Close dialog',
  className,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const id = useId();

  useFocusTrap(panelRef, open);
  useEscapeKey(open, onClose);

  // Compare against the mousedown target so a drag that ends on the overlay
  // (text selection inside the panel) does not dismiss the dialog.
  const onOverlayMouseDown = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (!dismissOnOverlay) return;
      if (event.target === overlayRef.current) onClose();
    },
    [dismissOnOverlay, onClose],
  );

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div className="cd-overlay" ref={overlayRef} onMouseDown={onOverlayMouseDown}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={description ? `${id}-desc` : undefined}
        tabIndex={-1}
        className={cx('cd-modal', size !== 'md' && `cd-modal--${size}`, className)}
      >
        <header className="cd-modal-head">
          <h2 className="cd-modal-title" id={`${id}-title`}>
            {title}
          </h2>
          <IconButton icon="x" label={closeLabel} variant="ghost" size="sm" onClick={onClose} />
        </header>
        {description ? (
          <p className="cd-modal-desc" id={`${id}-desc`}>
            {description}
          </p>
        ) : null}
        <div className="cd-modal-body">{children}</div>
        {footer ? <footer className="cd-modal-foot">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}

export default Modal;
