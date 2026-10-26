/**
 * HLS playlist parser (RFC 8216), docs/design.md §3.3 and §3.4. Pure functions over text:
 * fetching, header replay and the protection verdict on the whole item live elsewhere.
 * Unknown tags are ignored, as RFC 8216 §6.3.1 requires of clients.
 */

export class PlaylistError extends Error {
  override name = 'PlaylistError';
}

export type Attributes = Record<string, string>;

/** Parses an attribute list (RFC 8216 §4.2). Quoted values lose their quotes. */
export function parseAttributes(list: string): Attributes {
  const out: Attributes = {};
  // Sticky: each match must start where the previous one ended, so the scan is linear. An
  // entry that does not parse is skipped up to the next comma rather than matched mid-text.
  const re = /[ \t]*([A-Z0-9-]+)=("[^"]*"|[^,]*)(?:,|$)/y;
  let at = 0;
  while (at < list.length) {
    re.lastIndex = at;
    const m = re.exec(list);
    if (m) {
      const [, name = '', raw = ''] = m;
      out[name] = raw.startsWith('"') ? raw.slice(1, -1) : raw;
      at = re.lastIndex;
    } else {
      const comma = list.indexOf(',', at);
      if (comma < 0) break;
      at = comma + 1;
    }
  }
  return out;
}

export interface KeyInfo {
  method: string;
  /** Absolute key URI; absent for `NONE`. */
  uri?: string | undefined;
  /** 32 hex digits, no `0x`. Absent: the IV is the segment's media sequence number (§5.2). */
  iv?: string | undefined;
  keyFormat: string;
  /** True when this key cannot be handled without circumventing protection (design §3.4). */
  protected: boolean;
}

export interface ByteRange {
  length: number;
  offset: number;
}

export interface MapInfo {
  uri: string;
  byteRange?: ByteRange | undefined;
}

export interface Segment {
  uri: string;
  duration: number;
  /** Media sequence number, used to derive the implicit IV. */
  sequence: number;
  byteRange?: ByteRange | undefined;
  /** Encryption in effect; undefined for clear segments. */
  key?: KeyInfo | undefined;
  map?: MapInfo | undefined;
  discontinuity: boolean;
}

export interface MediaPlaylist {
  kind: 'media';
  version: number;
  targetDuration: number;
  mediaSequence: number;
  playlistType?: 'VOD' | 'EVENT' | undefined;
  /** No `EXT-X-ENDLIST`. */
  live: boolean;
  /** Sum of `EXTINF`. */
  duration: number;
  segments: Segment[];
  protected: boolean;
}

export interface Variant {
  uri: string;
  bandwidth: number;
  averageBandwidth?: number | undefined;
  width?: number | undefined;
  height?: number | undefined;
  codecs?: string | undefined;
  frameRate?: number | undefined;
  audioGroup?: string | undefined;
  subtitlesGroup?: string | undefined;
}

export interface Rendition {
  type: 'AUDIO' | 'VIDEO' | 'SUBTITLES' | 'CLOSED-CAPTIONS';
  groupId: string;
  name: string;
  language?: string | undefined;
  /** Absent when the rendition is muxed into the variant streams. */
  uri?: string | undefined;
  default: boolean;
  autoselect: boolean;
  forced: boolean;
  channels?: string | undefined;
}

export interface MasterPlaylist {
  kind: 'master';
  variants: Variant[];
  renditions: Rendition[];
  sessionKeys: KeyInfo[];
  protected: boolean;
}

export type Playlist = MasterPlaylist | MediaPlaylist;

function resolve(uri: string, base: string): string {
  let url: URL;
  try {
    url = new URL(uri, base);
  } catch {
    throw new PlaylistError(`Invalid URI in playlist: ${uri.slice(0, 100)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PlaylistError(`Unsupported URI scheme: ${url.protocol}`);
  }
  return url.href;
}

function parseKey(list: string, base: string): KeyInfo {
  const attrs = parseAttributes(list);
  const method = attrs['METHOD'] ?? '';
  const keyFormat = attrs['KEYFORMAT'] ?? 'identity';
  // Fail closed: a KEYFORMAT that did not parse cleanly must not read as `identity`.
  const lostKeyFormat = attrs['KEYFORMAT'] === undefined && /KEYFORMAT/i.test(list);
  const protectedKey =
    method !== 'NONE' && (method !== 'AES-128' || keyFormat !== 'identity' || lostKeyFormat);
  const key: KeyInfo = { method, keyFormat, protected: protectedKey };
  if (method !== 'NONE' && attrs['URI'] !== undefined && !protectedKey) {
    key.uri = resolve(attrs['URI'], base);
  }
  if (attrs['IV'] !== undefined) {
    // A wrong IV would silently corrupt the first block of every segment: fail instead.
    const iv = /^0x([0-9a-f]{1,32})$/i.exec(attrs['IV'])?.[1];
    if (!iv) throw new PlaylistError('Invalid IV in EXT-X-KEY');
    key.iv = iv.toLowerCase().padStart(32, '0');
  }
  if (method === 'AES-128' && !protectedKey && key.uri === undefined) {
    throw new PlaylistError('EXT-X-KEY with METHOD=AES-128 has no URI');
  }
  return key;
}

function parseByteRange(value: string): { length: number; offset?: number | undefined } {
  const m = /^(\d+)(?:@(\d+))?$/.exec(value.trim());
  if (!m) throw new PlaylistError(`Invalid BYTERANGE: ${value.slice(0, 40)}`);
  return { length: Number(m[1]), offset: m[2] === undefined ? undefined : Number(m[2]) };
}

function parseResolution(value: string | undefined): { width?: number; height?: number } {
  const m = /^(\d+)x(\d+)$/.exec(value ?? '');
  return m ? { width: Number(m[1]), height: Number(m[2]) } : {};
}

/** No legitimate playlist line comes close; longer ones are hostile or broken. */
const MAX_LINE_LENGTH = 65_536;

function splitLines(text: string): string[] {
  const lines = text
    .replace(/^\u{FEFF}/u, '')
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim());
  if (lines.some((l) => l.length > MAX_LINE_LENGTH))
    throw new PlaylistError('Playlist line too long');
  if (lines[0] !== '#EXTM3U') throw new PlaylistError('Not an HLS playlist: missing #EXTM3U');
  return lines.filter((l) => l !== '');
}

/** Parses a master or media playlist; `baseUrl` is the playlist's own URL. */
export function parsePlaylist(text: string, baseUrl: string): Playlist {
  const lines = splitLines(text);
  const isMaster = lines.some((l) => l.startsWith('#EXT-X-STREAM-INF:'));
  return isMaster ? parseMaster(lines, baseUrl) : parseMedia(lines, baseUrl);
}

function parseMaster(lines: string[], base: string): MasterPlaylist {
  const variants: Variant[] = [];
  const renditions: Rendition[] = [];
  const sessionKeys: KeyInfo[] = [];
  let pending: Attributes | undefined;

  for (const line of lines) {
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      pending = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttributes(line.slice('#EXT-X-MEDIA:'.length));
      const type = a['TYPE'];
      if (
        (type === 'AUDIO' ||
          type === 'VIDEO' ||
          type === 'SUBTITLES' ||
          type === 'CLOSED-CAPTIONS') &&
        a['GROUP-ID'] !== undefined
      ) {
        renditions.push({
          type,
          groupId: a['GROUP-ID'],
          name: a['NAME'] ?? '',
          language: a['LANGUAGE'],
          uri: a['URI'] === undefined ? undefined : resolve(a['URI'], base),
          default: a['DEFAULT'] === 'YES',
          autoselect: a['AUTOSELECT'] === 'YES' || a['DEFAULT'] === 'YES',
          forced: a['FORCED'] === 'YES',
          channels: a['CHANNELS'],
        });
      }
    } else if (line.startsWith('#EXT-X-SESSION-KEY:')) {
      sessionKeys.push(parseKey(line.slice('#EXT-X-SESSION-KEY:'.length), base));
    } else if (!line.startsWith('#') && pending) {
      const bandwidth = Number(pending['BANDWIDTH']);
      variants.push({
        uri: resolve(line, base),
        bandwidth: Number.isFinite(bandwidth) ? bandwidth : 0,
        averageBandwidth: numberOrUndefined(pending['AVERAGE-BANDWIDTH']),
        ...parseResolution(pending['RESOLUTION']),
        codecs: pending['CODECS'],
        frameRate: numberOrUndefined(pending['FRAME-RATE']),
        audioGroup: pending['AUDIO'],
        subtitlesGroup: pending['SUBTITLES'],
      });
      pending = undefined;
    }
  }
  return {
    kind: 'master',
    variants,
    renditions,
    sessionKeys,
    protected: sessionKeys.some((k) => k.protected),
  };
}

function numberOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function parseMedia(lines: string[], base: string): MediaPlaylist {
  let version = 1;
  let targetDuration = 0;
  let mediaSequence = 0;
  let playlistType: MediaPlaylist['playlistType'];
  let endList = false;
  let key: KeyInfo | undefined;
  let map: MapInfo | undefined;
  let pendingDuration: number | undefined;
  let pendingRange: { length: number; offset?: number | undefined } | undefined;
  let discontinuity = false;
  /** End of the previous byte range, per resource (§4.3.2.2: a missing offset continues it). */
  const rangeEnd = new Map<string, number>();
  const segments: Segment[] = [];
  let duration = 0;
  let isProtected = false;

  for (const line of lines) {
    if (!line.startsWith('#')) {
      if (pendingDuration === undefined) continue; // a URI without EXTINF is not a segment
      const uri = resolve(line, base);
      let byteRange: ByteRange | undefined;
      if (pendingRange) {
        const offset = pendingRange.offset ?? rangeEnd.get(uri);
        if (offset === undefined)
          throw new PlaylistError('EXT-X-BYTERANGE without a previous range');
        byteRange = { length: pendingRange.length, offset };
        rangeEnd.set(uri, offset + pendingRange.length);
      }
      segments.push({
        uri,
        duration: pendingDuration,
        sequence: mediaSequence + segments.length,
        byteRange,
        key: key && key.method !== 'NONE' ? key : undefined,
        map,
        discontinuity,
      });
      duration += pendingDuration;
      pendingDuration = undefined;
      pendingRange = undefined;
      discontinuity = false;
    } else if (line.startsWith('#EXTINF:')) {
      const d = Number.parseFloat(line.slice('#EXTINF:'.length));
      pendingDuration = Number.isFinite(d) && d >= 0 ? d : 0;
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = parseByteRange(line.slice('#EXT-X-BYTERANGE:'.length));
    } else if (line.startsWith('#EXT-X-KEY:')) {
      key = parseKey(line.slice('#EXT-X-KEY:'.length), base);
      if (key.protected) isProtected = true;
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttributes(line.slice('#EXT-X-MAP:'.length));
      if (a['URI'] === undefined) continue;
      const r = a['BYTERANGE'] === undefined ? undefined : parseByteRange(a['BYTERANGE']);
      const uri = resolve(a['URI'], base);
      map = { uri, byteRange: r && { length: r.length, offset: r.offset ?? 0 } };
      // A segment range without an offset in the same file continues after the init section.
      if (map.byteRange && !rangeEnd.has(uri))
        rangeEnd.set(uri, map.byteRange.offset + map.byteRange.length);
    } else if (line === '#EXT-X-DISCONTINUITY') {
      discontinuity = true;
    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = Number.parseInt(line.slice('#EXT-X-TARGETDURATION:'.length), 10) || 0;
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = Number.parseInt(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length), 10) || 0;
    } else if (line.startsWith('#EXT-X-VERSION:')) {
      version = Number.parseInt(line.slice('#EXT-X-VERSION:'.length), 10) || 1;
    } else if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
      const t = line.slice('#EXT-X-PLAYLIST-TYPE:'.length);
      if (t === 'VOD' || t === 'EVENT') playlistType = t;
    } else if (line === '#EXT-X-ENDLIST') {
      endList = true;
    }
  }

  return {
    kind: 'media',
    version,
    targetDuration,
    mediaSequence,
    playlistType,
    live: !endList,
    duration,
    segments,
    protected: isProtected,
  };
}

export type Container = 'mp4' | 'mkv' | 'webm';

const MP4_VIDEO = /^(avc[1-4]|hvc1|hev1|dvh1|dvhe)(\.|$)/i;
const MP4_AUDIO = /^(mp4a\.(40\.\d+|6b|69|a5|a6)|ac-3|ec-3)$/i;
const TEXT = /^(wvtt|stpp)(\.|$)/i;
const OPEN_VIDEO = /^(vp0?9|av01)(\.|$)/i;
const OPEN_AUDIO = /^(opus|vorbis|flac)$/i;
const WEBM_CODEC = /^(vp0?8|vp0?9|av01|opus|vorbis)(\.|$)/i;

/**
 * Chooses the output container from an RFC 6381 `CODECS` list (design §4.4): H.264/H.265 + AAC
 * → MP4; VP9/AV1/Opus/Vorbis → WebM when every track fits it, MKV otherwise. Returns undefined
 * when any codec is unknown (design §3.3). Subtitle codecs do not influence the choice. An absent
 * `CODECS` also gives undefined, but that is not "unknown": see `isHiddenVariant`.
 */
export function containerForCodecs(codecs: string | undefined): Container | undefined {
  const list = (codecs ?? '')
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c !== '' && !TEXT.test(c));
  if (list.length === 0) return undefined;
  if (list.every((c) => MP4_VIDEO.test(c) || MP4_AUDIO.test(c))) return 'mp4';
  if (
    list.every(
      (c) => MP4_VIDEO.test(c) || MP4_AUDIO.test(c) || OPEN_VIDEO.test(c) || OPEN_AUDIO.test(c),
    )
  ) {
    return list.every((c) => WEBM_CODEC.test(c)) ? 'webm' : 'mkv';
  }
  return undefined;
}

/**
 * Design §3.3: a variant is hidden when its `CODECS` lists a codec we cannot handle. `CODECS` is
 * optional (RFC 8216 §4.3.4.2), so a variant without it is kept and probed at download time.
 */
export function isHiddenVariant(variant: Pick<Variant, 'codecs'>): boolean {
  return (
    variant.codecs !== undefined &&
    variant.codecs.trim() !== '' &&
    containerForCodecs(variant.codecs) === undefined
  );
}
