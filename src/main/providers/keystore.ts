import type { KeySource } from '../../shared/ipc'

/** The subset of Electron's safeStorage the key store needs. Injected so tests can use a fake. */
export interface Encryptor {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

/** The subset of SettingsStore the key store needs. */
export interface KeyValueStore {
  get(key: string): string | null
  set(key: string, value: string): void
  delete(key: string): void
}

export interface ActiveKey {
  key: string | null
  source: KeySource
}

/**
 * Stores one provider's API key encrypted with the OS secure storage.
 * Only ciphertext is written to the database. A development key (from .env.local) is used
 * only when no key has been saved.
 */
export class KeyStore {
  constructor(
    private readonly settingsKey: string,
    private readonly store: KeyValueStore,
    private readonly encryptor: Encryptor,
    private readonly devKey: string | null
  ) {}

  canStore(): boolean {
    return this.encryptor.isEncryptionAvailable()
  }

  save(apiKey: string): void {
    if (!this.canStore()) {
      throw new Error(
        'This system has no secure storage available, so the key was not saved. ' +
          'On Linux, install and unlock a keyring such as GNOME Keyring or KWallet.'
      )
    }
    const cipher = this.encryptor.encryptString(apiKey).toString('base64')
    this.store.set(this.settingsKey, cipher)
  }

  clear(): void {
    this.store.delete(this.settingsKey)
  }

  active(): ActiveKey {
    const cipher = this.store.get(this.settingsKey)
    if (cipher !== null) {
      if (!this.canStore()) {
        throw new Error('A saved key exists but secure storage is unavailable, so it cannot be read.')
      }
      return { key: this.encryptor.decryptString(Buffer.from(cipher, 'base64')), source: 'stored' }
    }
    if (this.devKey) return { key: this.devKey, source: 'env' }
    return { key: null, source: 'none' }
  }
}
