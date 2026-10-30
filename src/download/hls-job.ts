import { DecryptError, decryptSegment, KeyCache } from '../crypto/aes128';
import {
  parsePlaylist,
  PlaylistError,
  type ByteRange,
  type MapInfo,
  type MediaPlaylist,
  type Segment,
} from '../manifest/hls';
import type { Container } from '../media/container';
import type { Libav } from '../media/libav/types';
import {
  createRemuxer as createLibavRemuxer,
  SegmentError,
  type PositionalWrite,
  type Remuxer,
  type RemuxerOptions,
} from '../media/remux';
import { abortableSleep, backoffDelay, DEFAULT_RETRY, type RetryPolicy } from '../net/fetcher';
import { JobError, type JobWriter } from './direct-job';

/** A media playlist larger than this is refused; real ones are far smaller. */
export const PLAYLIST_LIMIT = 4 * 1024 ** 2;
/** A segment (or init section) is held in memory while it is demuxed: larger ones fail. */
export const SEGMENT_LIMIT = 128 * 1024 ** 2;
/** An AES-128 key is 16 bytes; anything much larger is not a key. */
export const KEY_LIMIT = 1024;
/** Share of failed segments the job tolerates (design §4.8). */
export const DEFAULT_FAILURE_THRESHOLD = 0.2;

const YIELD_INTERVAL_MS = 50;

type Fetch = (
  url: string,
  init: { signal: AbortSignal; headers?: Record<string, string> },
) => Promise<Response>;

export interface HlsJobDeps {
  /** The worker's fetcher (§4.2): per-host limit and request-phase retries. */
  fetch: Fetch;
  openWriter(jobId: string): Promise<JobWriter>;
  /** Creates the job's own libav instance (design §8: never shared between jobs). */
  loadLibav(): Promise<Libav>;
  /** Replaceable for tests; defaults to the libav remuxer of `src/media/remux.ts`. */
  createRemuxer?: (libav: Libav, write: PositionalWrite, options: RemuxerOptions) => Remuxer;
  /** Segments fetched ahead of the one being remuxed (the speed profile's connections). */
  concurrency: number;
  /** Share of segments that may fail before the job does (default 0.2, design §4.8). */
  failureThreshold?: number;
  /** Downloaded bytes so far; the total of a playlist is not known in advance. */
  onProgress?(bytesWritten: number, total: number | undefined): void;
  /** Resolves after `ms`, or rejects when `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Backoff for a body cut midway; request-phase failures are the fetcher's. */
  retry?: Pick<RetryPolicy, 'attempts' | 'baseMs' | 'maxMs'>;
  /** Random source in [0, 1) for jitter. */
  random?: () => number;
}

export interface HlsJobResult {
  file: File;
  container: Container;
  /** Segments left out after their failure (design §4.8); their gaps stay in the output. */
  skippedSegments: number;
  skippedSeconds: number;
  /** Duration of the output, gaps included. */
  durationSeconds: number;
  /** Sum of the playlist's `EXTINF`. */
  expectedSeconds: number;
}

/** Thrown inside an attempt for failures worth another try (a body cut midway). */
class Transient extends Error {
  constructor(readonly reason: unknown) {
    super('transient');
  }
}

function concat(parts: readonly Uint8Array[], length: number): Uint8Array {
  if (parts.length === 1 && parts[0]?.byteLength === length) return parts[0];
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/** The bytes as an `ArrayBuffer` of their own, as WebCrypto wants them. */
function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function unknown(message: string): JobError {
  return new JobError({ kind: 'unknown', message });
}

/**
 * Runner for an HLS media playlist (design §4.4, §4.8): fetches the segments in order, a few
 * ahead (`concurrency`), decrypts them (§4.3) and feeds them to the remuxer, which writes the
 * output to OPFS. Segments that still fail are skipped and leave a gap, unless it is the first
 * one or too many fail. Cancelling through `signal` or any failure removes the temporary file.
 */
export async function runHlsJob(
  job: { jobId: string; url: string },
  deps: HlsJobDeps,
  signal: AbortSignal = new AbortController().signal,
): Promise<HlsJobResult> {
  // Prefetches outlive the segment that fails the job: one abort stops them all.
  const inner = new AbortController();
  const onAbort = (): void => {
    inner.abort(signal.reason);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) inner.abort(signal.reason);
  const runner = new HlsRunner(job, deps, inner.signal);
  try {
    return await runner.run();
  } catch (error) {
    if (signal.aborted) throw new JobError({ kind: 'cancelled' });
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
    inner.abort();
  }
}

class HlsRunner {
  readonly #retry: Pick<RetryPolicy, 'attempts' | 'baseMs' | 'maxMs'>;
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly #random: () => number;
  readonly #keys: KeyCache;
  readonly #inits = new Map<string, Promise<Uint8Array>>();
  #downloaded = 0;
  #lastYield = Date.now();

  constructor(
    private readonly job: { jobId: string; url: string },
    private readonly deps: HlsJobDeps,
    private readonly signal: AbortSignal,
  ) {
    this.#retry = deps.retry ?? DEFAULT_RETRY;
    this.#sleep = deps.sleep ?? abortableSleep;
    this.#random = deps.random ?? ((): number => Math.random());
    this.#keys = new KeyCache(async (uri) => {
      const { bytes } = await this.#fetchBytes(uri, undefined, KEY_LIMIT, false);
      return bufferOf(bytes);
    });
  }

  async run(): Promise<HlsJobResult> {
    const playlist = await this.#playlist();
    const { deps, signal } = this;
    let writer: JobWriter | undefined;
    let remuxer: Remuxer | undefined;
    try {
      const libav = await deps.loadLibav();
      if (signal.aborted) throw new JobError({ kind: 'cancelled' });
      const output = await deps.openWriter(this.job.jobId);
      writer = output;
      remuxer = (deps.createRemuxer ?? createLibavRemuxer)(
        libav,
        (position, data) => {
          output.writeAt(position, data);
        },
        { signal, forwardJumpLimitSeconds: Math.max(10, 3 * playlist.targetDuration) },
      );
      const skipped = await this.#feed(playlist, remuxer);
      const result = await remuxer.finish();
      await remuxer.dispose();
      if (result.size === 0) throw new JobError({ kind: 'incomplete', ratio: 0 });
      return {
        file: await output.finish(),
        container: result.container,
        skippedSegments: skipped.segments,
        skippedSeconds: skipped.seconds,
        durationSeconds: result.durationSeconds,
        expectedSeconds: playlist.duration,
      };
    } catch (error) {
      // The remuxer may still flush buffered bytes while it is freed: it goes before the file.
      await remuxer?.dispose().catch(() => undefined);
      await writer?.remove().catch(() => {
        // The original failure is the useful one; host cleanup removes leftovers.
      });
      throw error;
    }
  }

  /** Read through a call, so the checks around an `await` are not narrowed away. */
  #aborted(): boolean {
    return this.signal.aborted;
  }

  /** Fetches and checks the media playlist. */
  async #playlist(): Promise<MediaPlaylist> {
    const { bytes, url } = await this.#fetchBytes(this.job.url, undefined, PLAYLIST_LIMIT, false);
    let playlist;
    try {
      // Relative URIs resolve against where the playlist really came from, after redirects.
      playlist = parsePlaylist(new TextDecoder().decode(bytes), url || this.job.url);
    } catch (error) {
      if (error instanceof PlaylistError) throw unknown(error.message);
      throw error;
    }
    if (playlist.kind !== 'media')
      throw unknown('Expected a media playlist, got a master playlist');
    if (playlist.protected) throw new JobError({ kind: 'protected' });
    if (playlist.live) throw unknown('Live playlists are not supported yet');
    if (playlist.segments.length === 0) throw new JobError({ kind: 'incomplete', ratio: 0 });
    return playlist;
  }

  /** Feeds every segment in order and applies the failure policy (design §4.8). */
  async #feed(
    playlist: MediaPlaylist,
    remuxer: Remuxer,
  ): Promise<{ segments: number; seconds: number }> {
    const { segments } = playlist;
    const threshold = this.deps.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    const ahead = Math.max(1, Math.floor(this.deps.concurrency));
    const tasks = new Map<number, Promise<Uint8Array>>();
    const prefetch = (index: number): void => {
      const segment = segments[index];
      if (!segment || tasks.has(index)) return;
      const task = this.#segmentData(segment);
      task.catch(() => undefined); // awaited in order below; a failure is handled there
      tasks.set(index, task);
    };

    let failed = 0;
    const skipped = { segments: 0, seconds: 0 };
    /** A discontinuity on a skipped segment still applies to the next one placed. */
    let discontinuity = false;
    for (const [index, segment] of segments.entries()) {
      for (let next = index; next < index + ahead; next++) prefetch(next);
      let failure: { error: unknown } | undefined;
      let data: Uint8Array | undefined;
      try {
        data = await tasks.get(index);
      } catch (error) {
        failure = { error };
      }
      tasks.delete(index);
      if (this.signal.aborted) throw new JobError({ kind: 'cancelled' });
      if (data) {
        try {
          await remuxer.add({ data, discontinuity: discontinuity || segment.discontinuity });
          discontinuity = false;
        } catch (error) {
          // The remuxer checks the signal between steps: an abort surfaces as its reason.
          if (this.#aborted()) throw new JobError({ kind: 'cancelled' });
          // Anything but a segment the remuxer refuses (a write, the muxer itself) is fatal.
          if (!(error instanceof SegmentError)) throw error;
          failure = { error };
        }
      }
      if (!failure) continue;
      failed++;
      if (index === 0 || failed > threshold * segments.length) throw failure.error;
      discontinuity ||= segment.discontinuity;
      remuxer.skip(segment.duration);
      skipped.segments++;
      skipped.seconds += segment.duration;
    }
    return skipped;
  }

  /** One segment ready to demux: init section in front, both decrypted. */
  async #segmentData(segment: Segment): Promise<Uint8Array> {
    const init = segment.map ? this.#init(segment.map) : undefined;
    let { bytes } = await this.#fetchBytes(segment.uri, segment.byteRange, SEGMENT_LIMIT, true);
    if (segment.key) {
      bytes = new Uint8Array(
        await decryptSegment(bufferOf(bytes), segment.key, segment.sequence, this.#keys),
      );
    }
    const head = init ? await init : undefined;
    return head ? concat([head, bytes], head.byteLength + bytes.byteLength) : bytes;
  }

  /** Each init section is fetched (and decrypted) once per job; a failure is not cached. */
  #init(map: MapInfo): Promise<Uint8Array> {
    const id = JSON.stringify([
      map.uri,
      map.byteRange?.offset,
      map.byteRange?.length,
      map.key?.uri,
      map.key?.iv,
    ]);
    let task = this.#inits.get(id);
    if (!task) {
      task = this.#loadInit(map);
      this.#inits.set(id, task);
      task.catch(() => this.#inits.delete(id));
    }
    return task;
  }

  async #loadInit(map: MapInfo): Promise<Uint8Array> {
    // RFC 8216 §4.3.2.5: an encrypted init section needs an explicit IV (no sequence number).
    if (map.key && map.key.iv === undefined) {
      throw new DecryptError('The encrypted EXT-X-MAP section has no IV');
    }
    const { bytes } = await this.#fetchBytes(map.uri, map.byteRange, SEGMENT_LIMIT, true);
    if (!map.key) return bytes;
    return new Uint8Array(await decryptSegment(bufferOf(bytes), map.key, 0, this.#keys));
  }

  /** Fetches a resource (or a byte range of it) whole, retrying a body cut midway. */
  async #fetchBytes(
    url: string,
    range: ByteRange | undefined,
    limit: number,
    counted: boolean,
  ): Promise<{ bytes: Uint8Array; url: string }> {
    for (let tries = 1; ; tries++) {
      try {
        return await this.#attempt(url, range, limit, counted);
      } catch (error) {
        if (this.signal.aborted) throw new JobError({ kind: 'cancelled' });
        if (!(error instanceof Transient)) throw error;
        if (tries >= this.#retry.attempts) throw error.reason;
        await this.#sleep(backoffDelay(tries, this.#retry, this.#random), this.signal);
      }
    }
  }

  async #attempt(
    url: string,
    range: ByteRange | undefined,
    limit: number,
    counted: boolean,
  ): Promise<{ bytes: Uint8Array; url: string }> {
    const init: { signal: AbortSignal; headers?: Record<string, string> } = {
      signal: this.signal,
    };
    if (range) {
      init.headers = {
        Range: `bytes=${String(range.offset)}-${String(range.offset + range.length - 1)}`,
      };
    }
    const response = await this.deps.fetch(url, init);
    // The fetcher holds a host slot until the body ends: never leave one half read.
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let drained = false;
    let received = 0;
    try {
      if (!response.ok) throw new JobError({ kind: 'http', status: response.status });
      if (!response.body) throw new Transient(new JobError({ kind: 'incomplete', ratio: 0 }));

      /** Bytes to drop before the range starts (a server that ignored `Range` sent all). */
      let skip = 0;
      let want: number | undefined;
      if (range) {
        want = range.length;
        if (response.status === 206) {
          const start = /^bytes (\d+)-\d+\/(?:\d+|\*)$/.exec(
            response.headers.get('content-range') ?? '',
          )?.[1];
          if (Number(start) !== range.offset) {
            throw unknown('The server answered with another byte range');
          }
        } else {
          skip = range.offset;
        }
        if (want > limit) throw unknown(`A segment is larger than ${String(limit)} bytes`);
      }
      const declared = Number(response.headers.get('content-length'));
      const total =
        Number.isFinite(declared) && declared > 0 && !response.headers.has('content-encoding')
          ? declared
          : undefined;
      if (!range && total !== undefined && total > limit) {
        throw unknown(`A resource is larger than ${String(limit)} bytes`);
      }

      const parts: Uint8Array[] = [];
      let kept = 0;
      reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            drained = true;
            break;
          }
          received += value.byteLength;
          let chunk = value;
          if (skip > 0) {
            const dropped = Math.min(skip, chunk.byteLength);
            skip -= dropped;
            chunk = chunk.subarray(dropped);
          }
          if (want !== undefined && kept + chunk.byteLength > want) {
            chunk = chunk.subarray(0, want - kept);
          }
          if (chunk.byteLength > 0) {
            parts.push(chunk);
            kept += chunk.byteLength;
          }
          if (kept > limit) throw unknown(`A resource is larger than ${String(limit)} bytes`);
          if (counted) {
            this.#downloaded += value.byteLength;
            this.deps.onProgress?.(this.#downloaded, undefined);
          }
          if (want !== undefined && kept === want) break; // the rest is not ours
          // A buffered fast stream would otherwise starve the worker's message queue.
          if (Date.now() - this.#lastYield > YIELD_INTERVAL_MS) {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            this.#lastYield = Date.now();
          }
        }
      } catch (error) {
        if (error instanceof JobError) throw error;
        if (this.signal.aborted) throw new JobError({ kind: 'cancelled' });
        throw new Transient(error);
      }
      if (want !== undefined && kept < want) {
        throw new Transient(new JobError({ kind: 'incomplete', ratio: kept / want }));
      }
      if (!range && total !== undefined && received < total) {
        throw new Transient(new JobError({ kind: 'incomplete', ratio: received / total }));
      }
      if (kept === 0) throw new JobError({ kind: 'incomplete', ratio: 0 });
      return { bytes: concat(parts, kept), url: response.url };
    } catch (error) {
      // Bytes of a failed attempt are counted again by the next one.
      if (counted && received > 0) this.#downloaded -= received;
      throw error;
    } finally {
      if (!drained) await (reader ?? response.body)?.cancel().catch(() => undefined);
    }
  }
}
