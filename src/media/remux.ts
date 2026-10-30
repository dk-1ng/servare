import { chooseContainer, MUXER_FORMAT, refusalReason, type Container } from './container';
import { AVERROR_EOF, EAGAIN } from './libav/loader';
import type { Libav, LibavPacket, LibavStream } from './libav/types';
import {
  matchStreams,
  mediaTypeOf,
  selectStreams,
  UnsupportedMediaError,
  type StreamInfo,
} from './streams';
import { Timeline } from './timeline';

/** Writes `data` at `position` of the output; must finish before it returns (design §8). */
export type PositionalWrite = (position: number, data: Uint8Array) => void;

/** Packet data read per batch; cancellation is checked between batches. */
const READ_BATCH_BYTES = 256 * 1024;
/** Packet data handed to the muxer per call, for the same reason. */
const WRITE_BATCH_BYTES = 1024 * 1024;
const SEGMENT_NAME = 'segment';
const OUTPUT_NAME = 'output';
const YIELD_INTERVAL_MS = 50;

/**
 * A segment that cannot go into the output (design §4.4, §4.8): it counts as a failed segment
 * and is not retried. Nothing of it was written. Any other error from the remuxer is fatal.
 */
export class SegmentError extends Error {
  override name = 'SegmentError';
  constructor(
    readonly reason: 'demux' | 'empty' | 'incompatible',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export { UnsupportedMediaError };

export interface RemuxResult {
  /** Bytes in the output. */
  size: number;
  container: Container;
  /**
   * Latest presentation end of the output. Gaps left by skipped segments inside the output are
   * part of it (`gapSeconds`); skipped segments at the end are not.
   */
  durationSeconds: number;
  /** Total `EXTINF` duration of the segments left out, wherever they were. */
  skippedSeconds: number;
  /**
   * Skipped time that became a gap inside the output (a later segment followed it). The time
   * covered with media is `durationSeconds - gapSeconds` (design §4.8).
   */
  gapSeconds: number;
}

export interface RemuxerOptions {
  signal?: AbortSignal | undefined;
  /**
   * How far ahead a stream may continue before the jump counts as a reset (design §4.4): the
   * HLS runner passes max(10 s, 3 × `EXT-X-TARGETDURATION`).
   */
  forwardJumpLimitSeconds?: number | undefined;
}

export interface Remuxer {
  /** Known once the first segment was added. */
  readonly container: Container | undefined;
  /**
   * Demuxes one whole segment (init section in front, already decrypted) and muxes its packets.
   * Throws `SegmentError` for a segment that must be skipped; anything else is fatal.
   */
  add(segment: { data: Uint8Array; discontinuity?: boolean | undefined }): Promise<void>;
  /** Records a segment left out; its duration stays as a gap. */
  skip(seconds: number): void;
  /** Writes the trailer. The output is complete once this resolves. */
  finish(): Promise<RemuxResult>;
  /** Releases libav resources; safe to call more than once, and after a failure. */
  dispose(): Promise<void>;
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The remux was aborted', 'AbortError');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function quietly(step: () => unknown): Promise<void> {
  try {
    await step();
  } catch {
    // Cleanup must not hide the real error; the instance is dropped with the job anyway.
  }
}

class LibavRemuxer implements Remuxer {
  readonly #libav: Libav;
  readonly #write: PositionalWrite;
  readonly #signal: AbortSignal | undefined;
  readonly #timeline: Timeline;
  #size = 0;
  // An exception thrown inside libav's write callback would unwind through WASM: keep it and
  // rethrow it after the libav call that triggered it returns.
  #writeError: { error: unknown } | undefined;
  #container: Container | undefined;
  #outputs: StreamInfo[] | undefined;
  #muxer = 0;
  #io = 0;
  #madeOutput = false;
  #readPacket = 0;
  #writePacket = 0;
  #skippedUs = 0;
  #closed = false;
  #disposed = false;
  #lastYield = Date.now();

  constructor(libav: Libav, write: PositionalWrite, options: RemuxerOptions) {
    this.#libav = libav;
    this.#write = write;
    this.#signal = options.signal;
    this.#timeline = new Timeline({
      forwardLimitUs: (options.forwardJumpLimitSeconds ?? 10) * 1_000_000,
    });
    libav.onwrite = (name, position, data) => {
      if (name !== OUTPUT_NAME || this.#writeError) return;
      try {
        const bytes =
          data instanceof Uint8Array
            ? data
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        this.#write(position, bytes);
        this.#size = Math.max(this.#size, position + bytes.byteLength);
      } catch (error) {
        this.#writeError = { error };
      }
    };
  }

  get container(): Container | undefined {
    return this.#container;
  }

  #checkpoint(): void {
    if (this.#writeError) throw this.#writeError.error;
    if (this.#signal?.aborted) throw abortError(this.#signal);
  }

  /** libav's calls may all complete synchronously: give queued messages (a cancel) a turn. */
  async #yield(): Promise<void> {
    if (Date.now() - this.#lastYield > YIELD_INTERVAL_MS) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      this.#lastYield = Date.now();
    }
    this.#checkpoint();
  }

  async add(segment: { data: Uint8Array; discontinuity?: boolean | undefined }): Promise<void> {
    if (this.#closed) throw new Error('The remuxer is closed');
    this.#checkpoint();
    const libav = this.#libav;
    await libav.writeFile(SEGMENT_NAME, segment.data);
    let demuxer = 0;
    try {
      let streams: LibavStream[];
      try {
        [demuxer, streams] = await libav.ff_init_demuxer_file(SEGMENT_NAME);
      } catch (error) {
        throw new SegmentError('demux', `The segment could not be opened: ${messageOf(error)}`, {
          cause: error,
        });
      }
      this.#checkpoint();
      const infos: StreamInfo[] = [];
      for (const stream of streams) infos.push(await this.#describe(stream));

      let map: Map<number, number>;
      let first: { kept: StreamInfo[]; container: Container } | undefined;
      if (this.#outputs) {
        const match = matchStreams(this.#outputs, infos);
        if (!match.ok) {
          throw new SegmentError('incompatible', `The segment does not match: ${match.reason}`);
        }
        map = match.map;
      } else {
        const { kept } = selectStreams(infos);
        if (kept.length === 0) {
          throw new SegmentError('empty', 'The segment has no audio or video stream');
        }
        const described = kept.map((s) => ({
          type: s.type === 'video' ? ('video' as const) : ('audio' as const),
          codec: s.codec,
          hasExtradata: (s.extradata?.byteLength ?? 0) > 0,
        }));
        const container = chooseContainer(described);
        if (!container) throw new UnsupportedMediaError(refusalReason(described));
        first = { kept, container };
        map = new Map(kept.map((s, i) => [s.index, i]));
      }

      // The whole segment is read before anything is written, so a segment that fails to
      // demux leaves nothing in the output.
      const packets = await this.#readAll(demuxer, map);
      if (packets.length === 0) throw new SegmentError('empty', 'The segment has no packets');
      if (first) await this.#openMuxer(first.kept, streams, first.container);
      const placed = this.#timeline.place(packets, { discontinuity: segment.discontinuity });
      await this.#writeAll(placed);
    } finally {
      if (demuxer) await quietly(() => libav.avformat_close_input_js(demuxer));
      await quietly(() => libav.unlink(SEGMENT_NAME));
    }
  }

  async #describe(stream: LibavStream): Promise<StreamInfo> {
    const libav = this.#libav;
    const type = mediaTypeOf(stream.codec_type);
    const codecpar = stream.codecpar;
    return {
      index: stream.index,
      type,
      codec: await libav.avcodec_get_name(stream.codec_id),
      timeBase: { num: stream.time_base_num, den: stream.time_base_den },
      sampleRate: type === 'audio' ? await libav.AVCodecParameters_sample_rate(codecpar) : 0,
      channels:
        type === 'audio' ? await libav.AVCodecParameters_ch_layout_nb_channels(codecpar) : 0,
      width: type === 'video' ? await libav.AVCodecParameters_width(codecpar) : 0,
      height: type === 'video' ? await libav.AVCodecParameters_height(codecpar) : 0,
      extradata: await libav.ff_copyout_codecpar_extradata(codecpar),
    };
  }

  /** Every packet of the mapped streams, renumbered to the output streams. */
  async #readAll(demuxer: number, map: ReadonlyMap<number, number>): Promise<LibavPacket[]> {
    const libav = this.#libav;
    this.#readPacket ||= await libav.av_packet_alloc();
    const out: LibavPacket[] = [];
    for (;;) {
      const [result, batches] = await libav.ff_read_frame_multi(demuxer, this.#readPacket, {
        limit: READ_BATCH_BYTES,
        unify: true,
      });
      for (const packet of batches[0] ?? []) {
        const output = map.get(packet.stream_index ?? 0);
        if (output === undefined) continue;
        packet.stream_index = output;
        out.push(packet);
      }
      await this.#yield();
      if (result === AVERROR_EOF) return out;
      if (result !== 0 && result !== -EAGAIN) {
        throw new SegmentError(
          'demux',
          `The segment could not be read: ${await libav.ff_error(result)}`,
        );
      }
    }
  }

  async #openMuxer(
    kept: StreamInfo[],
    streams: LibavStream[],
    container: Container,
  ): Promise<void> {
    const libav = this.#libav;
    this.#madeOutput = true;
    const [muxer, , io] = await libav.ff_init_muxer(
      {
        format_name: MUXER_FORMAT[container],
        filename: OUTPUT_NAME,
        device: true,
        open: true,
        codecpars: true,
      },
      kept.map((s) => {
        const stream = streams.find((candidate) => candidate.index === s.index);
        if (!stream) throw new Error(`Stream ${String(s.index)} vanished`);
        return [stream.codecpar, s.timeBase.num, s.timeBase.den];
      }),
    );
    this.#muxer = muxer;
    this.#io = io;
    const header = await libav.avformat_write_header(muxer, 0);
    if (header < 0) {
      throw new Error(`Could not write the ${container} header: ${await libav.ff_error(header)}`);
    }
    this.#checkpoint();
    this.#writePacket = await libav.av_packet_alloc();
    this.#outputs = kept;
    this.#container = container;
  }

  async #writeAll(packets: LibavPacket[]): Promise<void> {
    let start = 0;
    while (start < packets.length) {
      let end = start;
      let bytes = 0;
      while (end < packets.length && bytes < WRITE_BATCH_BYTES) {
        bytes += packets[end]?.data.byteLength ?? 0;
        end++;
      }
      await this.#libav.ff_write_multi(this.#muxer, this.#writePacket, packets.slice(start, end));
      await this.#yield();
      start = end;
    }
  }

  skip(seconds: number): void {
    if (!(seconds > 0)) return;
    this.#skippedUs += seconds * 1_000_000;
    this.#timeline.skip(seconds * 1_000_000);
  }

  async finish(): Promise<RemuxResult> {
    if (this.#closed) throw new Error('The remuxer is closed');
    this.#checkpoint();
    const container = this.#container;
    if (!this.#muxer || !container) throw new Error('No segment was remuxed');
    this.#closed = true;
    const trailer = await this.#libav.av_write_trailer(this.#muxer);
    if (trailer < 0) {
      throw new Error(`Could not finish the ${container}: ${await this.#libav.ff_error(trailer)}`);
    }
    if (this.#writeError) throw this.#writeError.error;
    return {
      size: this.#size,
      container,
      durationSeconds: this.#timeline.durationUs / 1_000_000,
      skippedSeconds: this.#skippedUs / 1_000_000,
      gapSeconds: this.#timeline.gapUs / 1_000_000,
    };
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#closed = true;
    const libav = this.#libav;
    // Release everything in reverse order.
    if (this.#writePacket) await quietly(() => libav.av_packet_free_js(this.#writePacket));
    if (this.#readPacket) await quietly(() => libav.av_packet_free_js(this.#readPacket));
    // Freeing an unfinished muxer may still flush buffered bytes through `onwrite`; a write
    // error then is ignored, the job removes its file anyway.
    if (this.#muxer) await quietly(() => libav.ff_free_muxer(this.#muxer, this.#io));
    if (this.#madeOutput) await quietly(() => libav.unlink(OUTPUT_NAME));
    libav.onwrite = null;
  }
}

/**
 * The remux pipeline of design §4.4: segments go in one by one, each demuxed on its own, and
 * their audio and video packets go into one muxer whose container follows the first segment's
 * codecs. The output never accumulates in memory: libav writes it through a block writer device
 * straight to `write`. One remuxer per job and per libav instance.
 */
export function createRemuxer(
  libav: Libav,
  write: PositionalWrite,
  options: RemuxerOptions = {},
): Remuxer {
  return new LibavRemuxer(libav, write, options);
}

/** Remuxes one whole media file (a single segment), with the same stream and container rules. */
export async function remuxFile(
  libav: Libav,
  input: Uint8Array,
  write: PositionalWrite,
  signal?: AbortSignal,
): Promise<RemuxResult> {
  const remuxer = createRemuxer(libav, write, { signal });
  try {
    await remuxer.add({ data: input });
    return await remuxer.finish();
  } finally {
    await remuxer.dispose();
  }
}
