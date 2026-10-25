/**
 * Deterministic, seekable pseudo-random bytes so a multi-gigabyte "file" can be served
 * without ever being stored. Byte `i` depends only on `i`, so any Range request yields
 * exactly the bytes a full download would contain at that offset.
 */
const BLOCK = 65536;

function makePattern(): Uint8Array {
  const out = new Uint8Array(BLOCK);
  let state = 0x2545f491; // fixed seed
  for (let i = 0; i < BLOCK; i++) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    out[i] = state & 0xff;
  }
  return out;
}

const PATTERN = makePattern();

export function syntheticByte(offset: number): number {
  const block = Math.floor(offset / BLOCK);
  return (PATTERN[offset % BLOCK] ?? 0) ^ (block & 0xff);
}

/** Fills `buffer` with the synthetic bytes starting at absolute `offset`. */
export function fillSynthetic(buffer: Uint8Array, offset: number): void {
  for (let i = 0; i < buffer.length; i++) buffer[i] = syntheticByte(offset + i);
}

/** Streams the bytes `[start, end]` (inclusive) in 1 MiB chunks. */
export function* syntheticChunks(start: number, end: number): Generator<Buffer> {
  const chunk = 1 << 20;
  for (let pos = start; pos <= end; pos += chunk) {
    const buf = Buffer.allocUnsafe(Math.min(chunk, end - pos + 1));
    fillSynthetic(buf, pos);
    yield buf;
  }
}

const UNITS: Record<string, number> = { '': 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };

/** Parses `2147483648`, `512mb`, `2gb` ... into a byte count; `null` if malformed. */
export function parseSize(text: string): number | null {
  const match = /^(\d+)(kb|mb|gb)?$/i.exec(text);
  if (!match) return null;
  const value = Number(match[1]) * (UNITS[(match[2] ?? '').toLowerCase()] ?? 1);
  return Number.isSafeInteger(value) ? value : null;
}
