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

  it('a wrong IV or sequence garbles the output without an error', async () => {
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

describe('NIST SP 800-38A F.2.2 (CBC-AES128)', () => {
  it('matches the published ciphertext and decrypts to the published plaintext', async () => {
    const key = Buffer.from('2b7e151628aed2a6abf7158809cf4f3c', 'hex');
    const iv = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
    const pt = Buffer.from(
      '6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e51' +
        '30c81c46a35ce411e5fbc1191a0a52eff69f2445df4f9b17ad2b417be66c3710',
      'hex',
    );
    const c = createCipheriv('aes-128-cbc', key, iv);
    const ct = Buffer.concat([c.update(pt), c.final()]);
    // First 64 bytes are the NIST ciphertext; the rest is PKCS#7 padding WebCrypto expects.
    expect(ct.subarray(0, 64).toString('hex')).toBe(
      '7649abac8119b246cee98e9b12e9197d5086cb9b507219ee95db113a917678b2' +
        '73bed6b8e3c1743b7116e69e222295163ff1caa1681fac09120eca307586e1a7',
    );
    const keys = new KeyCache(async () => key.buffer.slice(key.byteOffset, key.byteOffset + 16));
    const out = await decryptSegment(
      ct.buffer.slice(ct.byteOffset, ct.byteOffset + ct.byteLength),
      { uri: URI, iv: iv.toString('hex') },
      0,
      keys,
    );
    expect(Buffer.from(out).toString('hex')).toBe(pt.toString('hex'));
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
