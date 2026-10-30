/**
 * Output timeline of the remux pipeline (design §4.4, "Timestamps"). Pure arithmetic on
 * libav.js packets, so it runs without libav.
 *
 * Source timestamps are kept and shifted by one offset shared by every stream, so the source's
 * own audio/video alignment survives. The first segment puts its earliest presentation time at
 * 0. The offset changes (re-anchors) only on `EXT-X-DISCONTINUITY` or when a stream jumps more
 * than 1 s back or more than `forwardLimitUs` ahead of where it ended (encoder resets, the
 * 33-bit MPEG-TS wrap).
 */

const HI = 2 ** 32;

/** `AV_NOPTS_VALUE` (INT64_MIN) as a joined timestamp; exact as a double. */
export const NOPTS = -(2 ** 63);

/** Joins libav.js's low/high 32-bit halves of a 64-bit timestamp. `lo` may be signed. */
export function joinTs(lo: number, hi: number): number {
  return hi * HI + (lo >>> 0);
}

/** Splits a timestamp into libav.js's unsigned low and signed high halves. */
export function splitTs(value: number): [lo: number, hi: number] {
  return [value >>> 0, Math.floor(value / HI)];
}

/** The timing fields of a libav.js packet (`ff_read_frame_multi` / `ff_write_multi`). */
export interface TimedPacket {
  stream_index?: number;
  pts?: number;
  ptshi?: number;
  dts?: number;
  dtshi?: number;
  duration?: number;
  durationhi?: number;
  time_base_num?: number;
  time_base_den?: number;
}

interface StreamState {
  /** Where the stream ends on the output timeline (last DTS plus duration), in µs. */
  endUs: number;
  /** Latest presentation time plus duration on the output timeline, in µs. */
  presentationEndUs: number;
  /** Last shifted DTS kept, in its own time base. */
  lastDts?: { value: number; num: number; den: number };
  /** Last source DTS seen and the step before it, to estimate a missing duration. */
  lastSourceDts?: number | undefined;
  lastStep: number;
}

export interface TimelineOptions {
  /**
   * How far ahead of its end a stream may continue before the jump counts as a reset, in µs.
   * The remuxer uses max(10 s, 3 × `EXT-X-TARGETDURATION`).
   */
  forwardLimitUs?: number;
}

/** A backward step larger than this re-anchors (design §4.4). */
const BACKWARD_LIMIT_US = 1_000_000;

function timestampOf(packet: TimedPacket, field: 'pts' | 'dts'): number | undefined {
  const lo = packet[field];
  if (lo === undefined) return undefined;
  const value = joinTs(lo, packet[field === 'pts' ? 'ptshi' : 'dtshi'] ?? 0);
  return value === NOPTS ? undefined : value;
}

function timeBaseOf(packet: TimedPacket): { num: number; den: number } {
  const num = packet.time_base_num ?? 0;
  const den = packet.time_base_den ?? 0;
  if (!(num > 0 && den > 0)) throw new Error('A packet has no time base');
  return { num, den };
}

function toUs(ticks: number, tb: { num: number; den: number }): number {
  return (ticks * 1_000_000 * tb.num) / tb.den;
}

export class Timeline {
  readonly #forwardLimitUs: number;
  /** Added to every source timestamp, in µs; undefined until the first segment. */
  #offsetUs: number | undefined;
  /** Skipped since the last placed segment. */
  #pendingSkipUs = 0;
  readonly #streams = new Map<number, StreamState>();

  constructor(options: TimelineOptions = {}) {
    this.#forwardLimitUs = options.forwardLimitUs ?? 10_000_000;
  }

  /** A segment left out (design §4.4: its duration stays as a gap). */
  skip(us: number): void {
    if (us > 0) this.#pendingSkipUs += us;
  }

  /** Latest end of any output stream, in µs; 0 before the first packet. */
  get endUs(): number {
    let end = 0;
    for (const state of this.#streams.values()) end = Math.max(end, state.endUs);
    return end;
  }

  /** Latest presentation end of any stream, in µs: the duration of the output. */
  get durationUs(): number {
    let end = 0;
    for (const state of this.#streams.values()) end = Math.max(end, state.presentationEndUs);
    return end;
  }

  /** End of one output stream in µs, or undefined when it has no packet yet. */
  streamEndUs(stream: number): number | undefined {
    return this.#streams.get(stream)?.endUs;
  }

  /**
   * Shifts one segment's packets onto the output timeline, in place, and returns those kept.
   * Packets must already carry the output `stream_index` and their time base.
   */
  place<P extends TimedPacket>(
    packets: P[],
    options: { discontinuity?: boolean | undefined } = {},
  ): P[] {
    if (packets.length === 0) return [];
    this.#anchor(packets, options.discontinuity === true);
    this.#pendingSkipUs = 0;
    // A step across segments can span a gap or a reset: estimate only from steps inside one.
    for (const state of this.#streams.values()) state.lastSourceDts = undefined;
    const offsetUs = this.#offsetUs ?? 0;

    /** Offset per time base, rounded once so it is the same for every packet of a run. */
    const offsets = new Map<string, number>();
    const kept: P[] = [];
    for (const packet of packets) {
      const tb = timeBaseOf(packet);
      const key = `${String(tb.num)}/${String(tb.den)}`;
      let offset = offsets.get(key);
      if (offset === undefined) {
        offset = Math.round((offsetUs * tb.den) / (tb.num * 1_000_000));
        offsets.set(key, offset);
      }
      const stream = packet.stream_index ?? 0;
      let state = this.#streams.get(stream);
      const pts = timestampOf(packet, 'pts');
      const dts = timestampOf(packet, 'dts');

      let duration = joinTs(packet.duration ?? 0, packet.durationhi ?? 0);
      const source = dts ?? pts;
      if (source !== undefined && state?.lastSourceDts !== undefined) {
        const step = source - state.lastSourceDts;
        if (step > 0) state.lastStep = step;
      }
      if (!(duration > 0)) duration = state?.lastStep ?? 0;

      const shiftedDts = dts === undefined ? undefined : dts + offset;
      if (shiftedDts !== undefined && state?.lastDts) {
        const last = state.lastDts;
        const increases =
          last.num === tb.num && last.den === tb.den
            ? shiftedDts > last.value
            : toUs(shiftedDts, tb) > toUs(last.value, last);
        if (!increases) continue;
      }

      if (pts !== undefined) [packet.pts, packet.ptshi] = splitTs(pts + offset);
      if (shiftedDts !== undefined) [packet.dts, packet.dtshi] = splitTs(shiftedDts);
      kept.push(packet);

      state ??= {
        endUs: Number.NEGATIVE_INFINITY,
        presentationEndUs: Number.NEGATIVE_INFINITY,
        lastStep: 0,
      };
      this.#streams.set(stream, state);
      if (shiftedDts !== undefined) state.lastDts = { value: shiftedDts, ...tb };
      if (source !== undefined) {
        state.lastSourceDts = source;
        state.endUs = Math.max(state.endUs, toUs(source + offset + duration, tb));
      }
      const presented = pts ?? source;
      if (presented !== undefined) {
        state.presentationEndUs = Math.max(
          state.presentationEndUs,
          toUs(presented + offset + duration, tb),
        );
      }
    }
    return kept;
  }

  /** Sets or keeps the offset for the segment about to be placed. */
  #anchor(packets: readonly TimedPacket[], discontinuity: boolean): void {
    /** First decode time per stream and earliest presentation time, source µs. */
    const firstUs = new Map<number, number>();
    let earliestPtsUs = Number.POSITIVE_INFINITY;
    for (const packet of packets) {
      const tb = timeBaseOf(packet);
      const stream = packet.stream_index ?? 0;
      const pts = timestampOf(packet, 'pts') ?? timestampOf(packet, 'dts');
      if (pts !== undefined) earliestPtsUs = Math.min(earliestPtsUs, toUs(pts, tb));
      const dts = timestampOf(packet, 'dts') ?? timestampOf(packet, 'pts');
      if (dts !== undefined && !firstUs.has(stream)) firstUs.set(stream, toUs(dts, tb));
    }
    if (firstUs.size === 0) return; // nothing timed: nothing to anchor

    if (this.#offsetUs === undefined) {
      this.#offsetUs = this.#pendingSkipUs - earliestPtsUs;
      return;
    }
    const offset = this.#offsetUs;
    const jumped = [...firstUs].some(([stream, first]) => {
      const end = this.#streams.get(stream)?.endUs;
      if (end === undefined || !Number.isFinite(end)) return false;
      const expected = end + this.#pendingSkipUs;
      const shifted = first + offset;
      return shifted < expected - BACKWARD_LIMIT_US || shifted > expected + this.#forwardLimitUs;
    });
    if (!discontinuity && !jumped) return;

    // Re-anchor: the segment starts after the skipped time, at the end of the output, with no
    // stream starting before its own end (a stream whose source starts later keeps its lead).
    let needed = Number.NEGATIVE_INFINITY;
    for (const [stream, first] of firstUs) {
      const end = this.#streams.get(stream)?.endUs;
      if (end !== undefined && Number.isFinite(end)) {
        needed = Math.max(needed, end + this.#pendingSkipUs - first);
      }
    }
    if (!Number.isFinite(needed)) {
      needed = this.endUs + this.#pendingSkipUs - Math.min(...firstUs.values());
    }
    this.#offsetUs = needed;
  }
}
