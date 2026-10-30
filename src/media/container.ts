/**
 * Output container by codec (design §4.4, "Container table"). Pure data and functions: the
 * remuxer applies them to demuxed streams, and the HLS parser to `CODECS` before a download, so
 * the prediction and the decision cannot drift apart. Codec names are FFmpeg's
 * (`avcodec_get_name`).
 */

export type Container = 'mp4' | 'webm' | 'mkv';

/** libav muxer name per container. */
export const MUXER_FORMAT: Readonly<Record<Container, string>> = {
  mp4: 'mp4',
  webm: 'webm',
  mkv: 'matroska',
};

/** File name extension per container, without the dot. */
export const FILE_EXTENSION: Readonly<Record<Container, string>> = {
  mp4: 'mp4',
  webm: 'webm',
  mkv: 'mkv',
};

const MP4_CODECS: ReadonlySet<string> = new Set([
  'h264',
  'hevc',
  'aac',
  'mp3',
  'mp2',
  'ac3',
  'eac3',
]);
const WEBM_CODECS: ReadonlySet<string> = new Set(['vp8', 'vp9', 'av1', 'opus', 'vorbis']);
const MATROSKA_ONLY: ReadonlySet<string> = new Set(['flac']);
/** Matroska needs these in `CodecPrivate`; MPEG-TS carries them in band, without extradata. */
const NEEDS_EXTRADATA_IN_MATROSKA: ReadonlySet<string> = new Set(['h264', 'hevc']);

export interface ContainerStream {
  type: 'video' | 'audio';
  codec: string;
  hasExtradata: boolean;
}

/** True when the codec appears in some row of the table, whatever the other streams are. */
export function isSupportedCodec(codec: string): boolean {
  return MP4_CODECS.has(codec) || WEBM_CODECS.has(codec) || MATROSKA_ONLY.has(codec);
}

/** The container for these streams, or undefined when the table refuses them. */
export function chooseContainer(streams: readonly ContainerStream[]): Container | undefined {
  if (streams.length === 0) return undefined;
  if (streams.every((s) => MP4_CODECS.has(s.codec))) return 'mp4';
  if (streams.every((s) => WEBM_CODECS.has(s.codec))) return 'webm';
  if (
    streams.every(
      (s) =>
        isSupportedCodec(s.codec) && (!NEEDS_EXTRADATA_IN_MATROSKA.has(s.codec) || s.hasExtradata),
    )
  ) {
    return 'mkv';
  }
  return undefined;
}

/** Why `chooseContainer` refused these streams, for the `unknown` error the job reports. */
export function refusalReason(streams: readonly ContainerStream[]): string {
  const unknown = streams.find((s) => !isSupportedCodec(s.codec));
  if (unknown) return `Unsupported codec ${unknown.codec}`;
  if (streams.length === 0) return 'No audio or video stream';
  // Every codec is known, so only Matroska was left, and it needs in-band parameter sets moved
  // into the header, which a stream copy cannot do.
  const codecs = streams.map((s) => s.codec).join(' + ');
  return `Unsupported codec combination ${codecs} (no MP4 or WebM, and no codec configuration for Matroska)`;
}

/**
 * What an RFC 6381 `CODECS` entry names: an FFmpeg codec name, `'subtitle'` for a subtitle
 * format, or undefined when the entry is not known.
 */
export function codecFromRfc6381(entry: string): string | undefined {
  const e = entry.trim().toLowerCase();
  if (/^avc[1-4](\.|$)/.test(e)) return 'h264';
  if (/^(hvc1|hev1|dvh1|dvhe)(\.|$)/.test(e)) return 'hevc';
  if (/^mp4a\.40\.\d+$/.test(e)) return 'aac';
  if (e === 'mp4a.6b' || e === 'mp4a.69') return 'mp3';
  if (e === 'mp4a.a5' || e === 'ac-3') return 'ac3';
  if (e === 'mp4a.a6' || e === 'ec-3') return 'eac3';
  if (/^vp0?8(\.|$)/.test(e)) return 'vp8';
  if (/^vp0?9(\.|$)/.test(e)) return 'vp9';
  if (/^av01(\.|$)/.test(e)) return 'av1';
  if (e === 'opus' || e === 'vorbis' || e === 'flac') return e;
  if (/^(wvtt|stpp)(\.|$)/.test(e)) return 'subtitle';
  return undefined;
}

const VIDEO_CODECS: ReadonlySet<string> = new Set(['h264', 'hevc', 'vp8', 'vp9', 'av1']);

/** Stream type of a supported codec; every codec of the table that is not video is audio. */
export function codecType(codec: string): 'video' | 'audio' {
  return VIDEO_CODECS.has(codec) ? 'video' : 'audio';
}
