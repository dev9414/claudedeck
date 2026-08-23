/**
 * The contextBridge surface.
 *
 * Owns exactly one job: publish `DeckApi` on `window.claudedeck` and nothing
 * else. No `ipcRenderer`, no `process`, no node builtins cross into the page —
 * the renderer can only reach main through a method that exists in the
 * contract. Compiled to CJS because a sandboxed preload cannot be an ES module.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { EVENT_CHANNELS, INVOKE_CHANNELS, type DeckApi, type InvokeChannel } from '../shared/ipc';
import type { AutoSwitchEvent, DeckState } from '../shared/types';

/** Everything in `DeckApi` that is a request/response call rather than a push. */
type InvokeApi = Pick<DeckApi, InvokeChannel>;

/**
 * Generated from the contract instead of hand-written, so the bridge cannot
 * drift: a name in `INVOKE_CHANNELS` that is not a `DeckApi` method fails to
 * compile against `Pick<...>`, and a `DeckApi` method missing from the array
 * fails the `const api: DeckApi` assignment below.
 */
const invokers = Object.fromEntries(
  INVOKE_CHANNELS.map((channel) => [
    channel,
    (...args: unknown[]): Promise<unknown> => ipcRenderer.invoke(channel, ...args),
  ]),
) as unknown as InvokeApi;

/**
 * Wraps one push channel. The listener identity is captured in the closure so
 * the returned disposer removes *this* subscription and never a later one
 * registered for the same channel.
 */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => {
    cb(payload);
  };
  ipcRenderer.on(channel, listener);

  let disposed = false;
  return () => {
    // Idempotent: React effects and StrictMode double-invocation both call
    // this more than once, and a second removal must stay a no-op.
    if (disposed) return;
    disposed = true;
    ipcRenderer.removeListener(channel, listener);
  };
}

const api: DeckApi = {
  ...invokers,
  onStateChanged: (cb: (state: DeckState) => void) =>
    subscribe<DeckState>(EVENT_CHANNELS.stateChanged, cb),
  onAutoSwitchEvent: (cb: (event: AutoSwitchEvent) => void) =>
    subscribe<AutoSwitchEvent>(EVENT_CHANNELS.autoSwitchEvent, cb),
};

if (!process.contextIsolated) {
  // Failing loudly beats silently assigning to `window`: without isolation the
  // page shares a realm with this script, and "nothing beyond DeckApi is
  // reachable" stops being true.
  throw new Error('ClaudeDeck requires contextIsolation:true on the renderer BrowserWindow.');
}

contextBridge.exposeInMainWorld('claudedeck', api);
