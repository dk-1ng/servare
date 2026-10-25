export type ByteRange = { start: number; end: number }; // inclusive on both ends

/**
 * Parses a single-range `Range: bytes=...` header (RFC 9110 section 14.1.2).
 * Returns `null` when the header is absent or not a bytes range (serve the full body),
 * `'unsatisfiable'` when it cannot be served (416), otherwise the clamped range.
 */
export function parseRange(
  header: string | undefined,
  size: number,
): ByteRange | 'unsatisfiable' | null {
  if (header === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null; // unknown unit or multi-range: ignoring the header is allowed
  const [, first = '', last = ''] = match;
  if (first === '' && last === '') return null;
  if (first === '') {
    const suffix = Number(last);
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  if (start >= size) return 'unsatisfiable';
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1);
  if (end < start) return null; // syntactically invalid: ignore the header
  return { start, end };
}
