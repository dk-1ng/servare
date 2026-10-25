/**
 * Media types Servare recognizes, written from the IANA media types registry
 * (https://www.iana.org/assignments/media-types). docs/design.md §3.2.
 */

/** Types that are always a complete, playable file when served with enough bytes. */
const DIRECT_TYPES = new Set([
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
  'video/x-matroska',
  'video/matroska',
  'video/mpeg',
  'video/x-msvideo',
  'video/x-flv',
  'video/x-m4v',
  'video/3gpp',
  'video/3gpp2',
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/aac',
  'audio/ogg',
  'audio/opus',
  'audio/webm',
  'audio/flac',
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/x-m4a',
  'audio/x-matroska',
  'audio/3gpp',
]);

/** MPEG transport stream: in practice an HLS segment, never offered as a direct file. */
const FRAGMENT_TYPES = new Set(['video/mp2t', 'video/iso.segment', 'audio/aac-segment']);

const HLS_TYPES = new Set(['application/vnd.apple.mpegurl', 'application/x-mpegurl']);
const DASH_TYPES = new Set(['application/dash+xml']);

/** `Content-Type` value without parameters, lower-cased; `undefined` when empty. */
export function essence(contentType: string | undefined): string | undefined {
  const value = contentType?.split(';')[0]?.trim().toLowerCase();
  return value ? value : undefined;
}

export function isDirectMediaType(contentType: string | undefined): boolean {
  const type = essence(contentType);
  return type !== undefined && DIRECT_TYPES.has(type);
}

export function isFragmentType(contentType: string | undefined): boolean {
  const type = essence(contentType);
  return type !== undefined && FRAGMENT_TYPES.has(type);
}

/**
 * `audio/mpegurl` and `audio/x-mpegurl` are also used for plain `.m3u` music playlists;
 * the manifest fetch (design §3.3) confirms which one it is.
 */
export function isHlsType(contentType: string | undefined): boolean {
  const type = essence(contentType);
  return (
    type !== undefined &&
    (HLS_TYPES.has(type) || type === 'audio/mpegurl' || type === 'audio/x-mpegurl')
  );
}

export function isDashType(contentType: string | undefined): boolean {
  const type = essence(contentType);
  return type !== undefined && DASH_TYPES.has(type);
}
