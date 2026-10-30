/**
 * Stream selection and matching for the remux pipeline (design §4.4, "Stream selection").
 * Pure functions over plain stream descriptions, so they run without libav.
 */
import { isSupportedCodec } from './container';

/** FFmpeg's `AVMediaType`, by name. */
export type MediaType = 'video' | 'audio' | 'data' | 'subtitle' | 'attachment' | 'unknown';

const AV_MEDIA_TYPES: readonly MediaType[] = ['video', 'audio', 'data', 'subtitle', 'attachment'];

/** Maps `AVMediaType` (video 0, audio 1, data 2, subtitle 3, attachment 4) to its name. */
export function mediaTypeOf(avMediaType: number): MediaType {
  return AV_MEDIA_TYPES[avMediaType] ?? 'unknown';
}

/** What the remuxer needs to know about one demuxed stream. */
export interface StreamInfo {
  /** Index in its own input. */
  index: number;
  type: MediaType;
  /** FFmpeg codec name (`avcodec_get_name`). */
  codec: string;
  timeBase: { num: number; den: number };
  /** Audio only; 0 when unknown. */
  sampleRate: number;
  /** Audio only; 0 when unknown. */
  channels: number;
  /** Video only; 0 when unknown. */
  width: number;
  height: number;
  /** Codec configuration (fMP4 `avcC`, …); null when the stream has none (MPEG-TS). */
  extradata: Uint8Array | null;
}

/** The media cannot be saved at all (`unknown` with this message). Not a per-segment failure. */
export class UnsupportedMediaError extends Error {
  override name = 'UnsupportedMediaError';
}

export interface Selection {
  /** Streams to mux, in input order. */
  kept: StreamInfo[];
  dropped: { index: number; reason: string }[];
}

/** Why a stream is never muxed, whatever else the input holds; undefined when it is usable. */
function unusable(stream: StreamInfo): string | undefined {
  if (stream.type !== 'video' && stream.type !== 'audio') return `${stream.type} stream`;
  // A stream listed by the container but never identified (e.g. private data probed as MP3).
  if (stream.type === 'audio' && !(stream.sampleRate > 0)) return 'audio without a sample rate';
  if (stream.type === 'video' && !(stream.width > 0 && stream.height > 0)) {
    return 'video without dimensions';
  }
  return undefined;
}

/**
 * Picks the streams of the first segment that go into the output. Only video and audio are kept.
 * A stream with a codec outside the container table is dropped when another stream of the same
 * type is kept; when it is the only one of its type the media is refused, naming the codec.
 */
export function selectStreams(streams: readonly StreamInfo[]): Selection {
  const kept: StreamInfo[] = [];
  const dropped: Selection['dropped'] = [];
  const unsupported: StreamInfo[] = [];
  for (const stream of streams) {
    const reason = unusable(stream);
    if (reason !== undefined) dropped.push({ index: stream.index, reason });
    else if (!isSupportedCodec(stream.codec)) unsupported.push(stream);
    else kept.push(stream);
  }
  for (const stream of unsupported) {
    if (!kept.some((k) => k.type === stream.type)) {
      throw new UnsupportedMediaError(`Unsupported codec ${stream.codec}`);
    }
    dropped.push({ index: stream.index, reason: `unsupported codec ${stream.codec}` });
  }
  dropped.sort((x, y) => x.index - y.index);
  return { kept, dropped };
}

/** Candidates of a later segment, filtered the same way as the first segment's streams. */
function candidates(streams: readonly StreamInfo[], type: MediaType): StreamInfo[] {
  return streams.filter(
    (s) => s.type === type && unusable(s) === undefined && isSupportedCodec(s.codec),
  );
}

function sameBytes(a: Uint8Array, b: Uint8Array | null): boolean {
  if (!b || a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

export type StreamMatch =
  | { ok: true; /** Input stream index → output stream index. */ map: Map<number, number> }
  | { ok: false; reason: string };

/**
 * Matches a later segment's streams to the output streams by type and order. The segment is
 * incompatible when an output stream finds no partner, or its partner has another codec, sample
 * rate or channel count, or other extradata when the output stream has some (fMP4). A resolution
 * change is accepted (MPEG-TS carries parameter sets in band). Extra streams are ignored.
 */
export function matchStreams(
  outputs: readonly StreamInfo[],
  segment: readonly StreamInfo[],
): StreamMatch {
  const map = new Map<number, number>();
  const used: Partial<Record<MediaType, number>> = {};
  for (const [outputIndex, output] of outputs.entries()) {
    const position = used[output.type] ?? 0;
    used[output.type] = position + 1;
    const input = candidates(segment, output.type)[position];
    const name = `${output.type} stream ${String(position + 1)}`;
    if (!input) return { ok: false, reason: `the segment has no ${name}` };
    if (input.codec !== output.codec) {
      return { ok: false, reason: `${name} changed codec from ${output.codec} to ${input.codec}` };
    }
    if (output.type === 'audio') {
      if (input.sampleRate !== output.sampleRate) {
        return { ok: false, reason: `${name} changed sample rate` };
      }
      if (input.channels !== output.channels) {
        return { ok: false, reason: `${name} changed channel count` };
      }
    }
    if (
      output.extradata &&
      output.extradata.byteLength > 0 &&
      !sameBytes(output.extradata, input.extradata)
    ) {
      return { ok: false, reason: `${name} changed codec configuration` };
    }
    map.set(input.index, outputIndex);
  }
  return { ok: true, map };
}
