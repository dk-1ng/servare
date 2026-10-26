import { AVERROR_EOF, EAGAIN } from './libav/loader';
import type { Libav } from './libav/types';

/** Writes `data` at `position` of the output; must finish before it returns (design §8). */
export type PositionalWrite = (position: number, data: Uint8Array) => void;

/** Packet data read per batch; cancellation is checked between batches. */
const READ_BATCH_BYTES = 256 * 1024;
const INPUT_NAME = 'input';
const OUTPUT_NAME = 'output.mp4';
const YIELD_INTERVAL_MS = 50;

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The remux was aborted', 'AbortError');
}

/**
 * Stream-copies every stream of `input` into an MP4 (design §4.4). The output never
 * accumulates in memory: libav writes it through a block writer device straight to `write`.
 * Resolves with the size of the output.
 *
 * Not handled here (remux pipeline, #22): timestamp continuity across segments, the choice
 * of container per codec, and streaming input.
 */
export async function remuxToMp4(
  libav: Libav,
  input: Uint8Array,
  write: PositionalWrite,
  signal?: AbortSignal,
): Promise<number> {
  let size = 0;
  // An exception thrown inside libav's write callback would unwind through WASM: keep it and
  // rethrow it after the libav call that triggered it returns.
  let writeError: { error: unknown } | undefined;
  libav.onwrite = (name, position, data) => {
    if (name !== OUTPUT_NAME || writeError) return;
    try {
      write(position, data);
      size = Math.max(size, position + data.byteLength);
    } catch (error) {
      writeError = { error };
    }
  };
  const checkpoint = (): void => {
    if (writeError) throw writeError.error;
    if (signal?.aborted) throw abortError(signal);
  };

  let demuxer = 0;
  let muxer = 0;
  let io = 0;
  let readPacket = 0;
  let writePacket = 0;
  let wroteInput = false;
  let madeOutput = false;
  try {
    checkpoint();
    await libav.writeFile(INPUT_NAME, input);
    wroteInput = true;
    const [inputContext, streams] = await libav.ff_init_demuxer_file(INPUT_NAME);
    demuxer = inputContext;
    if (streams.length === 0) throw new Error('The input has no streams');

    madeOutput = true;
    const [outputContext, , outputIo] = await libav.ff_init_muxer(
      { format_name: 'mp4', filename: OUTPUT_NAME, device: true, open: true, codecpars: true },
      streams.map((s) => [s.codecpar, s.time_base_num, s.time_base_den]),
    );
    muxer = outputContext;
    io = outputIo;
    const header = await libav.avformat_write_header(muxer, 0);
    if (header < 0) {
      throw new Error(`Could not write the MP4 header: ${await libav.ff_error(header)}`);
    }
    checkpoint();

    readPacket = await libav.av_packet_alloc();
    writePacket = await libav.av_packet_alloc();
    let lastYield = Date.now();
    for (;;) {
      const [result, packets] = await libav.ff_read_frame_multi(demuxer, readPacket, {
        limit: READ_BATCH_BYTES,
        unify: true,
      });
      const batch = packets[0];
      if (batch && batch.length > 0) await libav.ff_write_multi(muxer, writePacket, batch);
      // libav's calls may all complete synchronously: give queued messages (a cancel) a turn.
      if (Date.now() - lastYield > YIELD_INTERVAL_MS) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        lastYield = Date.now();
      }
      checkpoint();
      if (result === AVERROR_EOF) break;
      if (result !== 0 && result !== -EAGAIN) {
        throw new Error(`Could not read the input: ${await libav.ff_error(result)}`);
      }
    }
    const trailer = await libav.av_write_trailer(muxer);
    if (trailer < 0) {
      throw new Error(`Could not finish the MP4: ${await libav.ff_error(trailer)}`);
    }
    checkpoint();
    return size;
  } finally {
    // Release everything, in reverse order; a cleanup failure must not hide the real error.
    const quietly = async (step: () => unknown): Promise<void> => {
      try {
        await step();
      } catch {
        // The instance is dropped with the job anyway.
      }
    };
    if (writePacket) await quietly(() => libav.av_packet_free_js(writePacket));
    if (readPacket) await quietly(() => libav.av_packet_free_js(readPacket));
    if (muxer) await quietly(() => libav.ff_free_muxer(muxer, io));
    if (demuxer) await quietly(() => libav.avformat_close_input_js(demuxer));
    if (madeOutput) await quietly(() => libav.unlink(OUTPUT_NAME));
    if (wroteInput) await quietly(() => libav.unlink(INPUT_NAME));
    libav.onwrite = null;
  }
}
