/** HLS `AES-128` segment decryption (RFC 8216 §5.2, design §4.3). */

/** Raised for any failure to fetch a key or decrypt a segment; maps to `DownloadError` `{ kind: 'decrypt' }`. */
export class DecryptError extends Error {
  readonly kind = 'decrypt' as const;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DecryptError';
  }
}

const KEY_BYTES = 16;

/** Parses the 32 hex digits of an `EXT-X-KEY` `IV` (no `0x`) into 16 bytes. */
export function parseIv(hex: string): Uint8Array<ArrayBuffer> {
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new DecryptError('Invalid IV');
  const iv = new Uint8Array(16);
  for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return iv;
}

/** Implicit IV: the media sequence number as a 128-bit big-endian integer (RFC 8216 §5.2). */
export function ivFromSequence(sequence: number): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new DecryptError('Invalid media sequence number');
  }
  const iv = new Uint8Array(16);
  new DataView(iv.buffer).setBigUint64(8, BigInt(sequence));
  return iv;
}

/** Fetches the raw key bytes for a URI, replaying the player's headers (design §4.1.1). */
export type KeyFetcher = (uri: string) => Promise<ArrayBuffer>;

/** Imports and caches keys by URI for the lifetime of a job (design §4.3). */
export class KeyCache {
  readonly #fetchKey: KeyFetcher;
  readonly #keys = new Map<string, Promise<CryptoKey>>();

  constructor(fetchKey: KeyFetcher) {
    this.#fetchKey = fetchKey;
  }

  get(uri: string): Promise<CryptoKey> {
    let key = this.#keys.get(uri);
    if (!key) {
      key = this.#load(uri);
      this.#keys.set(uri, key);
      // A failed fetch must not poison the cache: the next segment retries.
      key.catch(() => this.#keys.delete(uri));
    }
    return key;
  }

  async #load(uri: string): Promise<CryptoKey> {
    let raw: ArrayBuffer;
    try {
      raw = await this.#fetchKey(uri);
    } catch (e) {
      throw new DecryptError('Could not fetch the decryption key', { cause: e });
    }
    if (raw.byteLength !== KEY_BYTES) {
      throw new DecryptError(`AES-128 key must be 16 bytes, got ${String(raw.byteLength)}`);
    }
    return crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt']);
  }
}

export interface SegmentKey {
  uri?: string | undefined;
  /** 32 hex digits; absent: derive from `sequence`. */
  iv?: string | undefined;
}

/** Decrypts one whole segment (AES-CBC, PKCS#7 padding). */
export async function decryptSegment(
  data: ArrayBuffer,
  key: SegmentKey,
  sequence: number,
  keys: KeyCache,
): Promise<ArrayBuffer> {
  if (key.uri === undefined) throw new DecryptError('Encrypted segment has no key URI');
  if (data.byteLength === 0 || data.byteLength % 16 !== 0) {
    throw new DecryptError('Encrypted segment length is not a multiple of 16');
  }
  const iv = key.iv !== undefined ? parseIv(key.iv) : ivFromSequence(sequence);
  const cryptoKey = await keys.get(key.uri);
  try {
    return await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, data);
  } catch (e) {
    // WebCrypto reports bad padding (wrong key or corrupt data) as OperationError.
    throw new DecryptError('Segment decryption failed', { cause: e });
  }
}
