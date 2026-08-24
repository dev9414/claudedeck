/**
 * Toasts: the visible half of a confirmation.
 *
 * The app's two core actions — capturing an account and switching one — used to
 * confirm themselves only into the 1px `.cd-live` region, so a sighted user got
 * no answer at all. This is that same announcement, said out loud: the host is
 * one polite live region that is *also* on screen, so the spoken confirmation
 * and the visible one are the same words and cannot drift apart.
 *
 * Three rules the callers depend on:
 *   - a success dismisses itself; a failure waits to be dismissed, because the
 *     message that mattered must not expire while you were reading it;
 *   - the entrance is one guarded keyframe from motion.css, so under
 *     `prefers-reduced-motion: reduce` a toast simply appears;
 *   - never pass a credential in. Toasts name accounts and slots. A token is
 *     not a status message.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from './Icon';
import { IconButton } from './Button';
import './toast.css';

/** Long enough to read two lines, short enough not to become furniture. */
const SUCCESS_DISMISS_MS = 6_000;

export type ToastTone = 'good' | 'critical';

interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  body?: string;
}

export interface ToastApi {
  /** A completed action. Announced, shown, and dismissed on its own. */
  success: (title: string, body?: string) => void;
  /** A failed action. Announced, shown, and kept until the user closes it. */
  failure: (title: string, body?: string) => void;
}

/** A component rendered outside the provider still runs; it just stays quiet. */
const SILENT: ToastApi = { success: () => {}, failure: () => {} };

const ToastContext = createContext<ToastApi>(SILENT);

export function useToast(): ToastApi {
  return useContext(ToastContext);
}

function ToastRow({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  const expires = item.tone === 'good';

  useEffect(() => {
    if (!expires) return undefined;
    const timer = window.setTimeout(() => onDismiss(item.id), SUCCESS_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [expires, item.id, onDismiss]);

  return (
    <div className="cd-toast" data-tone={item.tone}>
      {/* Decorative on purpose: the title below already says which this is. */}
      <Icon name={item.tone === 'good' ? 'check' : 'alert-octagon'} />
      <span className="cd-toast-body">
        <span className="cd-toast-title">{item.title}</span>
        {item.body === undefined ? null : <span>{item.body}</span>}
      </span>
      <IconButton icon="x" label="Dismiss" variant="ghost" size="sm" onClick={() => onDismiss(item.id)} />
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const api = useMemo<ToastApi>(() => {
    const push = (tone: ToastTone, title: string, body?: string) => {
      const id = nextId.current;
      nextId.current += 1;
      setItems((current) => [...current, { id, tone, title, body }]);
    };
    return {
      success: (title, body) => push('good', title, body),
      failure: (title, body) => push('critical', title, body),
    };
  }, []);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/*
        Mounted always and empty most of the time: a live region inserted at the
        same moment as its text is announced unreliably. `aria-atomic="false"`
        keeps a second toast from re-reading the first, and `additions` keeps a
        dismissal from being read as news.
      */}
      <div className="cd-toasts" aria-live="polite" aria-atomic="false" aria-relevant="additions">
        {items.map((item) => (
          <ToastRow key={item.id} item={item} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export default ToastProvider;
