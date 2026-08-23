/**
 * Accounts: the roster, one row per slot.
 *
 * Every mutation here writes to the user's real Claude Code install, so each
 * one states what it will do before it does it: switching goes through the same
 * planned-write preview the dashboard uses, and removal names the account it is
 * about to drop. Reordering is available by drag *and* by button — a drag-only
 * affordance would put slot order out of reach of the keyboard.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DragEvent } from 'react';
import type { Account, SwitchResult, UsageWindow } from '@shared/types';
import { useDeckState } from '../hooks/useDeckState';
import { Badge, UsageStatusBadge } from '../components/Badge';
import { Button, IconButton } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { UsageMeter } from '../charts/UsageMeter';
import './views.css';

const KIND_LABEL: Record<Account['kind'], string> = {
  oauth: 'OAuth',
  'setup-token': 'Setup token',
  'api-key': 'API key',
};

type Confirmation =
  | { kind: 'switch'; account: Account; preview: SwitchResult }
  | { kind: 'remove'; account: Account };

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function duration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${rest}m`;
  return `${rest}m`;
}

function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return typeof cause === 'string' ? cause : 'The main process did not answer.';
}

/** Token expiry as words plus the glyph that carries the same meaning. */
function expiryNote(account: Account, now: number): { icon: 'clock' | 'alert-triangle' | 'minus'; text: string } {
  if (account.kind === 'api-key') return { icon: 'minus', text: 'API keys do not expire on a clock' };
  if (account.tokenExpiresAt === undefined) return { icon: 'minus', text: 'No token expiry recorded' };
  const delta = account.tokenExpiresAt - now;
  if (delta <= 0) return { icon: 'alert-triangle', text: `Token expired ${duration(-delta)} ago` };
  return { icon: 'clock', text: `Token valid for ${duration(delta)}` };
}

function meterWindows(account: Account): UsageWindow[] {
  const usage = account.usage ?? account.lastGoodUsage;
  if (!usage) return [];
  const windows: UsageWindow[] = [];
  if (usage.fiveHour) windows.push(usage.fiveHour);
  if (usage.sevenDay) windows.push(usage.sevenDay);
  windows.push(...usage.scoped);
  return windows;
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export function Accounts() {
  const { state, loading, error, api, reload } = useDeckState();
  const accounts = useMemo<Account[]>(
    () => [...(state?.accounts ?? [])].sort((a, b) => a.slot - b.slot),
    [state],
  );

  const [now, setNow] = useState(() => Date.now());
  const [actionError, setActionError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [editingSlot, setEditingSlot] = useState<number | null>(null);
  const [aliasDraft, setAliasDraft] = useState('');
  const [dragSlot, setDragSlot] = useState<number | null>(null);
  const [dropSlot, setDropSlot] = useState<number | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const run = useCallback(
    async (key: string, task: () => Promise<string | null>) => {
      setPending(key);
      setActionError(null);
      try {
        const failure = await task();
        if (failure !== null) setActionError(failure);
      } catch (cause: unknown) {
        setActionError(messageOf(cause));
      } finally {
        setPending(null);
      }
    },
    [],
  );

  const startSwitch = useCallback(
    (account: Account) =>
      run(`switch:${account.slot}`, async () => {
        const preview = await api.previewSwitch({ target: account.slot, reason: 'manual' });
        setConfirmation({ kind: 'switch', account, preview });
        return null;
      }),
    [api, run],
  );

  const commitSwitch = useCallback(
    (account: Account) =>
      run(`commit:${account.slot}`, async () => {
        const result = await api.switchAccount({ target: account.slot, reason: 'manual' });
        if (!result.switched) return result.error ?? result.reason;
        setConfirmation(null);
        setAnnouncement(`Switched to ${account.email}.`);
        return null;
      }),
    [api, run],
  );

  const commitRemove = useCallback(
    (account: Account) =>
      run(`remove:${account.slot}`, async () => {
        const result = await api.removeAccount(account.slot);
        if (!result.ok) return result.error;
        setConfirmation(null);
        setAnnouncement(`Removed ${account.email}.`);
        return null;
      }),
    [api, run],
  );

  const toggleDisabled = useCallback(
    (account: Account) =>
      run(`disable:${account.slot}`, async () => {
        const result = await api.setDisabled(account.slot, !account.disabled);
        if (!result.ok) return result.error;
        setAnnouncement(`${account.email} ${account.disabled ? 'returned to rotation' : 'held out of rotation'}.`);
        return null;
      }),
    [api, run],
  );

  const saveAlias = useCallback(
    (account: Account) =>
      run(`alias:${account.slot}`, async () => {
        const trimmed = aliasDraft.trim();
        const result = await api.setAlias(account.slot, trimmed === '' ? null : trimmed);
        if (!result.ok) return result.error;
        setEditingSlot(null);
        setAnnouncement(trimmed === '' ? `Alias cleared for ${account.email}.` : `Alias set to ${trimmed}.`);
        return null;
      }),
    [api, aliasDraft, run],
  );

  /**
   * `to` is a 1-based position in the list, not a slot number: slots are
   * renumbered after every move, so positions are the only stable target.
   */
  const move = useCallback(
    (fromSlot: number, to: number) =>
      run(`move:${fromSlot}`, async () => {
        if (to < 1 || to > accounts.length) return null;
        const result = await api.moveAccount(fromSlot, to);
        if (!result.ok) return result.error;
        setAnnouncement(`Moved slot ${fromSlot} to position ${to}.`);
        return null;
      }),
    [accounts.length, api, run],
  );

  // --- drag ---------------------------------------------------------------

  const onDragStart = (event: DragEvent<HTMLLIElement>, slot: number) => {
    setDragSlot(slot);
    event.dataTransfer.effectAllowed = 'move';
    // Some platforms refuse to start a drag without payload; the slot travels
    // in component state, this is only to satisfy the API.
    event.dataTransfer.setData('text/plain', String(slot));
  };

  const onDragOver = (event: DragEvent<HTMLLIElement>, slot: number) => {
    if (dragSlot === null || dragSlot === slot) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDropSlot(slot);
  };

  const onDrop = (event: DragEvent<HTMLLIElement>, slot: number, index: number) => {
    event.preventDefault();
    const from = dragSlot;
    setDragSlot(null);
    setDropSlot(null);
    if (from !== null && from !== slot) void move(from, index + 1);
  };

  const endDrag = () => {
    setDragSlot(null);
    setDropSlot(null);
  };

  // --- gates ---------------------------------------------------------------

  if (loading && !state) {
    return (
      <p className="cd-view-loading" role="status" aria-live="polite">
        <Icon name="refresh" className="cd-spin" />
        Reading the account roster…
      </p>
    );
  }

  if (!state) {
    return (
      <div className="cd-view">
        <EmptyState
          icon="alert-octagon"
          tone="warning"
          title="The account roster could not be read"
          description={error ?? 'The main process did not answer the state request.'}
          action={
            <Button variant="primary" icon="refresh" onClick={() => void reload()}>
              Try again
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="cd-view">
      <header className="cd-view-head">
        <h1 className="cd-h1">Accounts</h1>
        <p className="cd-view-sub">
          {accounts.length === 0
            ? 'Nothing is being managed yet.'
            : `${accounts.length} managed · slot order is rotation order.`}
        </p>
        <span className="cd-spacer" />
        {state.settings.safeMode ? (
          <Badge tone="warning" icon="ban">
            Safe mode — writes blocked
          </Badge>
        ) : null}
      </header>

      {error ? (
        <div className="cd-note cd-note--error" role="alert">
          <Icon name="alert-octagon" />
          <span className="cd-note-body">
            <span className="cd-note-title">State update failed</span>
            <span>{error} This list may be out of date.</span>
          </span>
        </div>
      ) : null}

      {actionError ? (
        <div className="cd-note cd-note--error" role="alert">
          <Icon name="alert-octagon" />
          <span className="cd-note-body">
            <span className="cd-note-title">That action did not complete</span>
            <span>{actionError}</span>
          </span>
        </div>
      ) : null}

      {accounts.length === 0 ? (
        <EmptyState
          icon="users"
          title="No accounts are managed yet"
          description="ClaudeDeck reopens setup whenever it has nothing to manage. You can also capture the account Claude Code is signed in as right now, which is the first step of that setup."
          action={
            <Button
              variant="primary"
              icon="plus"
              busy={pending === 'add'}
              onClick={() =>
                void run('add', async () => {
                  const result = await api.addCurrentAccount();
                  if (!result.ok) return result.error;
                  setAnnouncement(`Captured ${result.value.email} into slot ${result.value.slot}.`);
                  return null;
                })
              }
            >
              Capture the signed-in account
            </Button>
          }
        />
      ) : (
        <ul className="cd-acct-list">
          {accounts.map((account, index) => {
            const expiry = expiryNote(account, now);
            const windows = meterWindows(account);
            const editing = editingSlot === account.slot;
            return (
              <li
                key={account.slot}
                className="cd-acct-row"
                data-active={account.active}
                data-dimmed={account.disabled || account.quarantinedAt !== undefined}
                data-dragging={dragSlot === account.slot}
                data-droptarget={dropSlot === account.slot}
                draggable
                onDragStart={(event) => onDragStart(event, account.slot)}
                onDragOver={(event) => onDragOver(event, account.slot)}
                onDrop={(event) => onDrop(event, account.slot, index)}
                onDragEnd={endDrag}
              >
                <div className="cd-acct-grip">
                  <span
                    className="cd-acct-gripmark"
                    aria-hidden="true"
                    title={`Drag to reorder slot ${account.slot}`}
                  >
                    <Icon name="minus" size={14} />
                    <Icon name="minus" size={14} />
                  </span>
                  <span className="cd-acct-slot">{account.slot}</span>
                  <IconButton
                    icon="chevron-down"
                    label={`Move ${account.email} up to position ${index}`}
                    variant="ghost"
                    size="sm"
                    disabled={index === 0 || pending !== null}
                    style={{ transform: 'rotate(180deg)' }}
                    onClick={() => void move(account.slot, index)}
                  />
                  <IconButton
                    icon="chevron-down"
                    label={`Move ${account.email} down to position ${index + 2}`}
                    variant="ghost"
                    size="sm"
                    disabled={index === accounts.length - 1 || pending !== null}
                    onClick={() => void move(account.slot, index + 2)}
                  />
                </div>

                <div className="cd-acct-body">
                  <div className="cd-acct-head">
                    <span className="cd-acct-identity">
                      <span className="cd-acct-email" title={account.email}>
                        {account.email}
                      </span>
                      <span className="cd-acct-alias">
                        {account.alias ? (
                          <>
                            <Icon name="pin" size={12} />
                            {account.alias}
                          </>
                        ) : (
                          'No alias'
                        )}
                        {account.identity?.organizationName ? ` · ${account.identity.organizationName}` : ''}
                      </span>
                    </span>

                    <span className="cd-acct-badges">
                      {account.active ? (
                        <Badge tone="accent" icon="check">
                          Active
                        </Badge>
                      ) : null}
                      <Badge tone="neutral" icon="user">
                        {KIND_LABEL[account.kind]}
                      </Badge>
                      <UsageStatusBadge status={account.usageStatus} />
                      {account.disabled ? (
                        <Badge tone="warning" icon="ban" title="Held out of auto-rotation; still a manual target.">
                          Disabled
                        </Badge>
                      ) : null}
                      {account.quarantinedAt !== undefined ? (
                        <Badge tone="serious" icon="alert-triangle" title={account.quarantineReason}>
                          Quarantined
                        </Badge>
                      ) : null}
                    </span>
                  </div>

                  <p className="cd-meta">
                    <span>
                      <Icon name={expiry.icon} size={12} /> {expiry.text}
                    </span>
                    {account.quarantineReason ? (
                      <span>
                        <Icon name="alert-triangle" size={12} /> {account.quarantineReason}
                      </span>
                    ) : null}
                  </p>

                  {windows.length > 0 ? (
                    <UsageMeter windows={windows} compact />
                  ) : (
                    <p className="cd-meta">
                      <span>
                        <Icon name="info" size={12} />{' '}
                        {account.kind === 'api-key'
                          ? 'No subscription window — API-key usage is billed per token.'
                          : 'No usage read yet. Refresh from the title bar to poll this account.'}
                      </span>
                    </p>
                  )}

                  {editing ? (
                    <form
                      className="cd-alias-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void saveAlias(account);
                      }}
                    >
                      <label className="cd-field">
                        <span>Alias for {account.email}</span>
                        <input
                          className="cd-input"
                          value={aliasDraft}
                          autoFocus
                          maxLength={32}
                          placeholder="short handle"
                          onChange={(event) => setAliasDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Escape') setEditingSlot(null);
                          }}
                        />
                      </label>
                      <Button type="submit" variant="primary" icon="check" busy={pending === `alias:${account.slot}`}>
                        Save
                      </Button>
                      <Button variant="ghost" onClick={() => setEditingSlot(null)}>
                        Cancel
                      </Button>
                      <span className="cd-muted">An empty alias clears it.</span>
                    </form>
                  ) : (
                    <div className="cd-acct-actions">
                      <Button
                        variant="primary"
                        icon="bolt"
                        size="sm"
                        disabled={account.active || pending !== null}
                        busy={pending === `switch:${account.slot}`}
                        onClick={() => void startSwitch(account)}
                      >
                        {account.active ? 'Signed in' : 'Switch to this account'}
                      </Button>
                      <Button
                        icon="pin"
                        size="sm"
                        disabled={pending !== null}
                        onClick={() => {
                          setAliasDraft(account.alias ?? '');
                          setEditingSlot(account.slot);
                        }}
                      >
                        {account.alias ? 'Change alias' : 'Add alias'}
                      </Button>
                      <Button
                        icon={account.disabled ? 'play' : 'pause'}
                        size="sm"
                        disabled={pending !== null}
                        busy={pending === `disable:${account.slot}`}
                        onClick={() => void toggleDisabled(account)}
                      >
                        {account.disabled ? 'Return to rotation' : 'Hold out of rotation'}
                      </Button>
                      <span className="cd-spacer" />
                      <Button
                        variant="danger"
                        icon="trash"
                        size="sm"
                        disabled={pending !== null}
                        onClick={() => setConfirmation({ kind: 'remove', account })}
                      >
                        Remove
                      </Button>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {accounts.length > 0 ? (
        <p className="cd-muted">
          Drag a row, or use the two chevrons, to change slot order. Slot 1 is where the rotation rules start.
        </p>
      ) : null}

      {/* --- switch confirmation ------------------------------------------ */}

      <Modal
        open={confirmation?.kind === 'switch'}
        onClose={() => setConfirmation(null)}
        title="Confirm account switch"
        description="These are the writes ClaudeDeck will make to your Claude Code install."
        dismissOnOverlay={false}
        footer={
          <>
            <Button onClick={() => setConfirmation(null)}>Cancel</Button>
            <Button
              variant="primary"
              icon="check"
              busy={confirmation?.kind === 'switch' && pending === `commit:${confirmation.account.slot}`}
              disabled={
                state.settings.safeMode ||
                (confirmation?.kind === 'switch' && confirmation.preview.error !== undefined)
              }
              onClick={() => {
                if (confirmation?.kind === 'switch') void commitSwitch(confirmation.account);
              }}
            >
              Write these changes
            </Button>
          </>
        }
      >
        {confirmation?.kind === 'switch' ? (
          <div className="cd-stack">
            <dl className="cd-kv">
              <dt>From</dt>
              <dd>
                {confirmation.preview.from
                  ? `Slot ${confirmation.preview.from.slot} — ${confirmation.preview.from.email}`
                  : 'No active account'}
              </dd>
              <dt>To</dt>
              <dd>
                Slot {confirmation.account.slot} — {confirmation.account.email}
              </dd>
              <dt>Reason</dt>
              <dd>{confirmation.preview.reason}</dd>
            </dl>

            <div>
              <h3 className="cd-h3">Planned writes</h3>
              {confirmation.preview.plannedWrites && confirmation.preview.plannedWrites.length > 0 ? (
                <ul className="cd-writes">
                  {confirmation.preview.plannedWrites.map((write) => (
                    <li key={write}>{write}</li>
                  ))}
                </ul>
              ) : (
                <p className="cd-secondary">
                  The preview reported no file writes — the credentials on disk already match this account.
                </p>
              )}
            </div>

            {confirmation.preview.error ? (
              <div className="cd-note cd-note--error" role="alert">
                <Icon name="alert-octagon" />
                <span className="cd-note-body">
                  <span className="cd-note-title">This switch cannot run</span>
                  <span>{confirmation.preview.error}</span>
                </span>
              </div>
            ) : null}

            {state.settings.safeMode ? (
              <div className="cd-note cd-note--warning" role="note">
                <Icon name="ban" />
                <span className="cd-note-body">
                  <span className="cd-note-title">Safe mode is on</span>
                  <span>Disk writes are refused until you turn safe mode off in Settings.</span>
                </span>
              </div>
            ) : null}
          </div>
        ) : null}
      </Modal>

      {/* --- remove confirmation ------------------------------------------ */}

      <Modal
        open={confirmation?.kind === 'remove'}
        onClose={() => setConfirmation(null)}
        title="Remove this account from ClaudeDeck"
        dismissOnOverlay={false}
        size="sm"
        footer={
          <>
            <Button onClick={() => setConfirmation(null)}>Keep it</Button>
            <Button
              variant="danger"
              icon="trash"
              busy={confirmation?.kind === 'remove' && pending === `remove:${confirmation.account.slot}`}
              disabled={state.settings.safeMode}
              onClick={() => {
                if (confirmation?.kind === 'remove') void commitRemove(confirmation.account);
              }}
            >
              Remove account
            </Button>
          </>
        }
      >
        {confirmation?.kind === 'remove' ? (
          <div className="cd-stack">
            <p>
              Slot {confirmation.account.slot} — <strong>{confirmation.account.email}</strong> will be dropped from
              ClaudeDeck, along with its stored credentials and its recorded history.
            </p>
            <p className="cd-secondary">
              {confirmation.account.active
                ? 'This is the account Claude Code is signed in as. Removing it leaves Claude Code signed in until you switch to another slot.'
                : 'Your Claude Code session is unaffected — this account is not the one on disk.'}
            </p>
            {state.settings.safeMode ? (
              <div className="cd-note cd-note--warning" role="note">
                <Icon name="ban" />
                <span className="cd-note-body">
                  <span className="cd-note-title">Safe mode is on</span>
                  <span>Removal writes to the ClaudeDeck store, so it is blocked until safe mode is off.</span>
                </span>
              </div>
            ) : null}
          </div>
        ) : null}
      </Modal>

      <div className="cd-live" role="status" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}

export default Accounts;
