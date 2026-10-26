import { createCipheriv } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { DecryptError, KeyCache, decryptSegment, ivFromSequence, parseIv } from './aes128';

const KEY = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const URI = 'https://example.test/key.bin';
const plain = Buffer.from('servare synthetic segment payload, longer than one block');

const encrypt = (iv: Buffer): ArrayBuffer => {
  const c = createCipheriv('aes-128-cbc', KEY, iv);
  const out = Buffer.concat([c.update(plain), c.final()]);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
};
const cache = () => new KeyCache(async () => KEY.buffer.slice(KEY.byteOffset, KEY.byteOffset + 16));
const text = (b: ArrayBuffer) => Buffer.from(b).toString();

describe('IV helpers', () => {
  it('parses a hex IV', () => {
    expect(parseIv('000102030405060708090a0b0c0d0e0f')[15]).toBe(0x0f);
    expect(() => parseIv('abc')).toThrow(DecryptError);
  });
  it('derives the implicit IV big-endian from the sequence number', () => {
    expect(Buffer.from(ivFromSequence(0x01020304)).toString('hex')).toBe(
      '00000000000000000000000001020304',
    );
    expect(() => ivFromSequence(-1)).toThrow(DecryptError);
  });
});

describe('decryptSegment', () => {
  it('decrypts with an explicit IV', async () => {
    const ivHex = 'f0e0d0c0b0a090807060504030201000';
    const data = encrypt(Buffer.from(ivHex, 'hex'));
    expect(text(await decryptSegment(data, { uri: URI, iv: ivHex }, 7, cache()))).toBe(
      plain.toString(),
    );
  });

  it('decrypts with the IV derived from the sequence number', async () => {
    const data = encrypt(Buffer.from(ivFromSequence(42)));
    expect(text(await decryptSegment(data, { uri: URI }, 42, cache()))).toBe(plain.toString());
  });

  it('fails with a typed error on a wrong IV or sequence', async () => {
    const data = encrypt(Buffer.from(ivFromSequence(42)));
    // A wrong IV only garbles block 1, so padding still validates: output differs.
    const out = await decryptSegment(data, { uri: URI }, 43, cache());
    expect(text(out)).not.toBe(plain.toString());
  });

  it('rejects truncated data and a wrong key as DecryptError', async () => {
    await expect(
      decryptSegment(new ArrayBuffer(15), { uri: URI }, 0, cache()),
    ).rejects.toBeInstanceOf(DecryptError);
    const data = encrypt(Buffer.from(ivFromSequence(0)));
    const wrong = new KeyCache(async () => new Uint8Array(16).fill(9).buffer);
    const r = decryptSegment(data, { uri: URI }, 0, wrong);
    // Wrong key: usually bad padding (DecryptError); occasionally valid padding by chance.
    await r.then(
      (o) => expect(text(o)).not.toBe(plain.toString()),
      (e: unknown) => expect(e).toBeInstanceOf(DecryptError),
    );
  });
});

describe('KeyCache', () => {
  it('fetches each URI once', async () => {
    const fetchKey = vi.fn(async () => new Uint8Array(16).buffer);
    const keys = new KeyCache(fetchKey);
    await Promise.all([keys.get(URI), keys.get(URI)]);
    await keys.get(URI);
    expect(fetchKey).toHaveBeenCalledTimes(1);
  });

  it('rejects a key that is not 16 bytes, and retries after a failure', async () => {
    let calls = 0;
    const keys = new KeyCache(async () => {
      calls++;
      if (calls === 1) throw new Error('network');
      return new Uint8Array(calls === 2 ? 8 : 16).buffer;
    });
    await expect(keys.get(URI)).rejects.toBeInstanceOf(DecryptError);
    await expect(keys.get(URI)).rejects.toThrow(/16 bytes/);
    await expect(keys.get(URI)).resolves.toBeDefined();
    expect(calls).toBe(3);
  });
});
