/**
 * The part of the libav.js API Servare uses, as plain structural types (design §8).
 *
 * The download worker loads the Emscripten factory without libav.js's frontend, so it talks
 * to the module object directly. Functions that may suspend (Asyncify-based I/O) return a
 * promise and the rest return their value: every result is typed `T | Promise<T>` and
 * callers always `await` it.
 */
type MaybePromise<T> = T | Promise<T>;

/** A stream as reported by `ff_init_demuxer_file`. */
export interface LibavStream {
  /** Pointer to the `AVStream`. */
  ptr: number;
  index: number;
  /** Pointer to the stream's `AVCodecParameters`. */
  codecpar: number;
  codec_type: number;
  codec_id: number;
  time_base_num: number;
  time_base_den: number;
  /** Seconds; non-positive or NaN when the container does not say. */
  duration: number;
}

/** A packet copied out of WASM memory, as `ff_read_frame_multi` returns it. */
export interface LibavPacket {
  data: Uint8Array;
  pts?: number;
  ptshi?: number;
  dts?: number;
  dtshi?: number;
  time_base_num?: number;
  time_base_den?: number;
  stream_index?: number;
  flags?: number;
  duration?: number;
  durationhi?: number;
  /** Packet side data, copied through as it is. */
  side_data?: { data: Uint8Array; type: number }[] | null;
}

export interface MuxerOptions {
  format_name: string;
  filename: string;
  /** Create a block writer device for `filename` (output goes to `onwrite`). */
  device?: boolean;
  /** Open `filename` for writing and attach it to the context. */
  open?: boolean;
  /** The stream list holds codec parameters, not codec contexts. */
  codecpars?: boolean;
}

export interface ReadMultiOptions {
  /** Stop once this many bytes of packet data were read. */
  limit?: number;
  /** Return every packet under key 0, in file order. */
  unify?: boolean;
}

export interface Libav {
  /**
   * Called synchronously for every write to a block writer device. `data` may be a view into
   * WASM memory that is only valid during the call: copy or consume it before returning. It can
   * be an `Int8Array` (design §4.4, Evidence).
   */
  onwrite:
    ((name: string, position: number, data: Uint8Array | Int8Array) => void) | null | undefined;

  writeFile(name: string, content: Uint8Array): MaybePromise<unknown>;
  unlink(name: string): MaybePromise<unknown>;
  mkwriterdev(name: string, mode?: number): MaybePromise<unknown>;

  /** Returns `[AVFormatContext, streams]`; `format` forces a demuxer instead of probing. */
  ff_init_demuxer_file(name: string, format?: string): MaybePromise<[number, LibavStream[]]>;
  /** Returns `[AVFormatContext, AVOutputFormat, AVIOContext, AVStream[]]`. */
  ff_init_muxer(
    options: MuxerOptions,
    streams: [codecpar: number, timeBaseNum: number, timeBaseDen: number][],
  ): MaybePromise<[number, number, number, number[]]>;
  avformat_write_header(context: number, options: number): MaybePromise<number>;
  /** Returns `[result, packets by stream]`; result is 0, `EAGAIN`, `AVERROR_EOF` or an error. */
  ff_read_frame_multi(
    context: number,
    packet: number,
    options?: ReadMultiOptions,
  ): MaybePromise<[number, Record<number, LibavPacket[] | undefined>]>;
  ff_write_multi(context: number, packet: number, packets: LibavPacket[]): MaybePromise<unknown>;
  av_write_trailer(context: number): MaybePromise<number>;
  ff_free_muxer(context: number, io: number): MaybePromise<unknown>;
  avformat_close_input_js(context: number): MaybePromise<unknown>;
  av_packet_alloc(): MaybePromise<number>;
  av_packet_free_js(packet: number): MaybePromise<unknown>;
  ff_error(code: number): MaybePromise<string>;

  /** FFmpeg's short codec name for an `AVCodecID` (`h264`, `aac`, …). */
  avcodec_get_name(codecId: number): MaybePromise<string>;
  AVCodecParameters_sample_rate(codecpar: number): MaybePromise<number>;
  AVCodecParameters_ch_layout_nb_channels(codecpar: number): MaybePromise<number>;
  AVCodecParameters_width(codecpar: number): MaybePromise<number>;
  AVCodecParameters_height(codecpar: number): MaybePromise<number>;
  /** A copy of the codec configuration, or null when the stream has none. */
  ff_copyout_codecpar_extradata(codecpar: number): MaybePromise<Uint8Array | null>;
}

/** The Emscripten factory exported by `libav-*.wasm.mjs`. */
export type LibavFactory = (options: { wasmurl: string }) => Promise<object>;
