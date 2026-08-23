/**
 * ClaudeDeck's own at-rest store, encrypted with the OS secret service.
 *
 * Everything ClaudeDeck manages — the credential blobs of the accounts it
 * switches between — lives here, not in a plaintext sidecar file. Encryption
 * comes from Electron's `safeStorage` (DPAPI on Windows, Keychain on macOS,
 * libsecret/kwallet on Linux) but arrives through the injected `Encryptor`, so
 * core never imports `electron` and tests run against a fake cipher.
 *
 * When the platform has no secret service the payload is written in the clear
 * with `plaintext: true` recorded in the envelope. That flag is the whole point
 * of the fallback: the UI reads it and says so. Nothing here ever writes
 * cleartext under a header that claims encryption.
 */

import { join } from 'node:path';

import type { Result } from '@shared/types';
import { err, ok } from '@shared/types';

import { type CoreDeps, atomicWriteText, isRecord, readJsonObject } from './credentials';

/** Whatever the platform offers. `available()` is re-checked on every call
 * because a Linux desktop can gain or lose a running secret service. */
export interface Encryptor {
  available(): boolean;
  encrypt(s: string): Buffer;
  decrypt(b: Buffer): string;
}

/**
 * The vault's payload. Shape is owned by the caller (`store.ts`); the vault
 * only cares that it round-trips through JSON.
 */
export type VaultData = Record<string, unknown>;

export const VAULT_FILENAME = 'vault.json';

/** Envelope version. Bumped only when the *envelope* changes, never for
 * payload migrations — those are `store.ts`'s `schemaVersion`. */
export const VAULT_FORMAT = 1;

export type VaultEncryption = 'safeStorage' | 'none';

/** What the UI needs to tell the user how their tokens are actually stored. */
export interface VaultStatus {
  path: string;
  exists: boolean;
  /** True when the payload on disk is readable by anything that can read the
   * file. For a vault that does not exist yet, this is what a save would do. */
  plaintext: boolean;
  encryption: VaultEncryption;
  /** Epoch ms of the last save, when the file exists. */
  updatedAt?: number;
}

export interface Vault<T extends VaultData = VaultData> {
  readonly path: string;
  /** `err` with code `not-found` on a fresh install — that is not a failure. */
  load(): Promise<Result<T>>;
  save(data: T): Promise<Result<void>>;
  status(): Promise<VaultStatus>;
}

/** On-disk envelope. Exactly one of `payload` / `data` is present. */
interface VaultEnvelope {
  format: number;
  plaintext: boolean;
  encryption: VaultEncryption;
  updatedAt: number;
  /** base64 ciphertext; present when `plaintext` is false. */
  payload?: string;
  /** The payload verbatim; present when `plaintext` is true. */
  data?: VaultData;
}

/**
 * An `Encryptor` for hosts with no secret service. Explicitly unavailable
 * rather than a no-op cipher, so the plaintext marker is always accurate.
 */
export const NO_ENCRYPTION: Encryptor = {
  available: () => false,
  encrypt() {
    throw new Error('no secure storage on this platform');
  },
  decrypt() {
    throw new Error('no secure storage on this platform');
  },
};

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createVault<T extends VaultData = VaultData>(
  dir: string,
  enc: Encryptor,
  deps: CoreDeps,
): Vault<T> {
  const path = join(dir, VAULT_FILENAME);

  async function readEnvelope(): Promise<Result<VaultEnvelope>> {
    const raw = await readJsonObject(path, deps);
    if (!raw.ok) return raw;

    const format = raw.value['format'];
    if (typeof format !== 'number') {
      return err(`${path} is not a ClaudeDeck vault (no format field)`, 'parse-error');
    }
    if (format > VAULT_FORMAT) {
      // Refuse rather than guess: an older build must not rewrite a newer
      // envelope and destroy fields it does not know how to carry.
      return err(
        `${path} is vault format v${format}; this build understands v${VAULT_FORMAT}`,
        'format-too-new',
      );
    }

    const plaintext = raw.value['plaintext'] === true;
    const updatedAt = typeof raw.value['updatedAt'] === 'number' ? raw.value['updatedAt'] : 0;
    const payload = typeof raw.value['payload'] === 'string' ? raw.value['payload'] : undefined;
    const data = isRecord(raw.value['data']) ? (raw.value['data'] as VaultData) : undefined;

    return ok({
      format,
      plaintext,
      // The marker is authoritative; a stale `encryption` label never
      // upgrades a cleartext payload's description.
      encryption: plaintext ? 'none' : 'safeStorage',
      updatedAt,
      payload,
      data,
    });
  }

  return {
    path,

    async load(): Promise<Result<T>> {
      const envelope = await readEnvelope();
      if (!envelope.ok) return envelope;

      if (envelope.value.plaintext) {
        if (!envelope.value.data) {
          return err(`${path} is marked plaintext but carries no data`, 'parse-error');
        }
        return ok(envelope.value.data as T);
      }

      const payload = envelope.value.payload;
      if (payload === undefined) {
        return err(`${path} is marked encrypted but carries no payload`, 'parse-error');
      }
      if (!enc.available()) {
        return err(
          `${path} is encrypted with OS secure storage, which is unavailable on this host`,
          'no-decryptor',
        );
      }

      let text: string;
      try {
        text = enc.decrypt(Buffer.from(payload, 'base64'));
      } catch (e) {
        // Most often a vault copied from another machine or user account:
        // DPAPI/Keychain keys do not travel. Report it; never clear the file.
        return err(`could not decrypt ${path}: ${messageOf(e)}`, 'decrypt-failed');
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        return err(`${path} decrypted to invalid JSON: ${messageOf(e)}`, 'parse-error');
      }
      if (!isRecord(parsed)) return err(`${path} decrypted to a non-object`, 'parse-error');
      return ok(parsed as T);
    },

    async save(data: T): Promise<Result<void>> {
      const guard = deps.writeGuard?.(path);
      if (guard && !guard.ok) return guard;

      const json = JSON.stringify(data);
      let envelope: VaultEnvelope;

      if (enc.available()) {
        let cipher: Buffer;
        try {
          cipher = enc.encrypt(json);
        } catch (e) {
          // Secure storage claimed to work and then did not. Falling back to
          // cleartext here would silently downgrade the user's security on a
          // machine that is supposed to support encryption, so this is an
          // error the caller has to see.
          return err(`failed to encrypt the vault: ${messageOf(e)}`, 'encrypt-failed');
        }
        envelope = {
          format: VAULT_FORMAT,
          plaintext: false,
          encryption: 'safeStorage',
          updatedAt: deps.now(),
          payload: cipher.toString('base64'),
        };
      } else {
        envelope = {
          format: VAULT_FORMAT,
          plaintext: true,
          encryption: 'none',
          updatedAt: deps.now(),
          data,
        };
      }

      return atomicWriteText(path, JSON.stringify(envelope, null, 2), deps, { mode: 0o600 });
    },

    async status(): Promise<VaultStatus> {
      const envelope = await readEnvelope();
      if (!envelope.ok) {
        // No vault yet (or an unreadable one): report what the next save would
        // produce, which is what onboarding needs to warn about up front.
        return {
          path,
          exists: envelope.code !== 'not-found',
          plaintext: !enc.available(),
          encryption: enc.available() ? 'safeStorage' : 'none',
        };
      }
      return {
        path,
        exists: true,
        plaintext: envelope.value.plaintext,
        encryption: envelope.value.encryption,
        updatedAt: envelope.value.updatedAt,
      };
    },
  };
}
