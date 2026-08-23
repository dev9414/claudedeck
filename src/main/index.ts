/**
 * Application entry point: lifecycle, wiring, and nothing else.
 *
 * Everything with behaviour lives in a sibling module; this file exists to
 * decide the order things are created in, to hold the references Electron would
 * otherwise garbage-collect (the tray, most notoriously), and to make the
 * quit path unambiguous.
 */

import { app, dialog } from 'electron';
import type { Account, AutoSwitchEvent, DeckState } from '@shared/types';
import { createDemoServices, isDemoMode } from './demo';
import { registerIpc } from './ipc';
import { createNotifier, type DeckNotifier } from './notifications';
import { createServices, type AppServices } from './services';
import { createTray, type TrayController } from './tray';
import { createWindowController, type WindowController } from './window';

// Held at module scope on purpose: a Tray that only a local variable references
// is collected out from under the OS and silently disappears.
let services: AppServices | null = null;
let windows: WindowController | null = null;
let tray: TrayController | null = null;
let notifier: DeckNotifier | null = null;
let teardownIpc: (() => void) | null = null;

/** Set once quitting is irreversible, so `close` handlers stop vetoing. */
let quitting = false;

// Windows reads this to attribute toast notifications and taskbar grouping; it
// must match `appId` in electron-builder.yml or notifications appear as
// "electron.app.ClaudeDeck".
app.setAppUserModelId('io.claudedeck.app');

// A second launch should raise the running window, not start a rival process
// that fights over the same credential file.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    windows?.show();
  });

  app.whenReady().then(bootstrap).catch(fail);

  app.on('activate', () => {
    // macOS: clicking the dock icon reopens the window without restarting.
    windows?.show();
  });

  app.on('window-all-closed', () => {
    // macOS apps outlive their windows, and so does anything living in a tray.
    if (process.platform === 'darwin') return;
    if (services?.currentSettings().minimizeToTray) return;
    app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
  });

  app.on('will-quit', (event) => {
    if (!services) return;
    const pending = services;
    services = null;
    event.preventDefault();
    void shutdown(pending).finally(() => app.quit());
  });
}

async function bootstrap(): Promise<void> {
  // Stamped by the bundler from package.json; app.getVersion() reports the
  // Electron version when running unpackaged.
  const version = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : app.getVersion();
  const demo = isDemoMode();

  services = demo ? createDemoServices({ version }) : await createServices({ version });

  windows = createWindowController(services, { isQuitting: () => quitting });
  notifier = createNotifier(services.currentSettings().notifications);

  tray = createTray({
    services,
    showWindow: () => windows?.show(),
    quit: () => app.quit(),
  });

  teardownIpc = registerIpc({
    services,
    getWindow: () => windows?.current() ?? null,
  });

  services.onStateChanged(onStateChanged);
  services.onAutoSwitchEvent(onAutoSwitchEvent);

  windows.ensure();

  // A first refresh gives the tray real numbers instead of a placeholder ring.
  if (!demo) void services.refreshUsage();

  const settings = services.currentSettings();
  applyLoginItem(settings.launchAtLogin);
  if (settings.autoswitch.enabled) {
    const started = await services.startAutoSwitch();
    if (!started.ok) {
      // Not fatal: the engine simply stays off and the UI says why.
      console.warn(`[claudedeck] auto-switch did not start: ${started.error}`);
    }
  }
}

function onStateChanged(state: DeckState): void {
  tray?.refresh(state);
  notifier?.configure(state.settings.notifications);
  applyLoginItem(state.settings.launchAtLogin);

  const active = state.accounts.find((account) => account.slot === state.activeSlot);
  if (!active || !services || !notifier) return;
  if (active.quarantinedAt || active.usageStatus === 'no-quota') return;
  if (!active.usage && !active.lastGoodUsage) return;

  const headroom = services.headroomFor(active);
  // A null reading is "we have never polled", not "0% used"; warning on that
  // would fire a notification for every account on every cold start.
  if (!headroom) return;
  notifier.thresholdCrossed(active, 100 - headroom.remaining, headroom.bindingWindow);
}

function onAutoSwitchEvent(event: AutoSwitchEvent): void {
  const current = services;
  if (!current || !notifier) return;
  const accounts = current.currentState().accounts;
  const bySlot = (slot: number | undefined): Account | undefined =>
    slot === undefined ? undefined : accounts.find((account) => account.slot === slot);

  switch (event.kind) {
    case 'switch': {
      const to = bySlot(event.slot);
      if (!to) return;
      const fromSlot = event.detail?.['from'];
      notifier.switched(
        typeof fromSlot === 'number' ? bySlot(fromSlot) : undefined,
        to,
        event.message,
      );
      // A fresh account starts from a clean slate as far as warnings go.
      notifier.rearm(to.slot);
      return;
    }
    case 'account-quarantined': {
      const account = bySlot(event.slot);
      if (account) notifier.quarantined(account, account.quarantineReason ?? event.message);
      return;
    }
    case 'all-exhausted': {
      notifier.allExhausted(accounts.filter((account) => !account.disabled));
      return;
    }
    default:
      return;
  }
}

/**
 * `openAtLogin` is a per-user OS registration, so it is applied every time we
 * see the setting rather than only when it changes — the OS is the source of
 * truth and users do clear it from outside the app.
 */
function applyLoginItem(enabled: boolean): void {
  try {
    if (app.getLoginItemSettings().openAtLogin === enabled) return;
    app.setLoginItemSettings({ openAtLogin: enabled });
  } catch {
    // Unsupported on some Linux desktops; never worth failing startup over.
  }
}

async function shutdown(current: AppServices): Promise<void> {
  teardownIpc?.();
  teardownIpc = null;
  tray?.destroy();
  tray = null;
  notifier?.dispose();
  notifier = null;
  windows?.destroy();
  windows = null;
  await current.dispose();
}

function fail(cause: unknown): void {
  const message = cause instanceof Error ? cause.message : String(cause);
  dialog.showErrorBox('ClaudeDeck could not start', message);
  app.exit(1);
}
