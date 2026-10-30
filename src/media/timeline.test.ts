import { describe, expect, it } from 'vitest';
import { joinTs, NOPTS, splitTs, Timeline, type TimedPacket } from './timeline';

const TB90K = { time_base_num: 1, time_base_den: 90000 };

/** A packet with 64-bit timestamps given as plain numbers (NOPTS when null). */
function packet(
  stream: number,
  pts: number | null,
  dts: number | null,
  duration: number,
  tb = TB90K,
): TimedPacket {
  const [plo, phi] = splitTs(pts ?? NOPTS);
  const [dlo, dhi] = splitTs(dts ?? NOPTS);
  const [lo, hi] = splitTs(duration);
  return {
    stream_index: stream,
    pts: plo,
    ptshi: phi,
    dts: dlo,
    dtshi: dhi,
    duration: lo,
    durationhi: hi,
    ...tb,
  };
}

const ptsOf = (p: TimedPacket): number => joinTs(p.pts ?? 0, p.ptshi ?? 0);
const dtsOf = (p: TimedPacket): number => joinTs(p.dts ?? 0, p.dtshi ?? 0);

/**
 * A segment of `seconds` with 15 fps video (stream 0, decode delay of one frame) and AAC-like
 * audio frames of 1920 ticks (stream 1), both 1/90000, starting at `start` ticks.
 */
function segment(start: number, seconds = 2): TimedPacket[] {
  const out: TimedPacket[] = [];
  const frames = seconds * 15;
  for (let i = 0; i < frames; i++) {
    out.push(packet(0, start + (i + 1) * 6000, start + i * 6000, 6000));
  }
  for (let t = start + 6000; t < start + 6000 + seconds * 90000; t += 1920) {
    out.push(packet(1, t, t, 1920));
  }
  return out;
}

describe('joinTs / splitTs', () => {
  it.each([0, 1, 2 ** 31, 2 ** 32 - 1, 2 ** 32, 2 ** 33 + 5, 2 ** 52, -1, -(2 ** 32) - 3])(
    'round-trips %d',
    (n) => {
      const [lo, hi] = splitTs(n);
      expect(lo).toBeGreaterThanOrEqual(0);
      expect(lo).toBeLessThan(2 ** 32);
      expect(joinTs(lo, hi)).toBe(n);
    },
  );

  it('reads a low word given as a signed 32-bit value', () => {
    expect(joinTs(-1, 0)).toBe(2 ** 32 - 1);
    expect(joinTs(-(2 ** 31), 1)).toBe(2 ** 32 + 2 ** 31);
  });

  it('represents AV_NOPTS_VALUE exactly', () => {
    expect(joinTs(0, -(2 ** 31))).toBe(NOPTS);
    expect(splitTs(NOPTS)).toEqual([0, -(2 ** 31)]);
  });
});

describe('Timeline', () => {
  it('anchors the earliest presentation timestamp of the first segment at 0', () => {
    const timeline = new Timeline();
    const placed = timeline.place(segment(126000));
    // The first video frame is presented one frame after it is decoded, at 132000.
    expect(Math.min(...placed.map(ptsOf))).toBe(0);
    const video = placed.filter((p) => p.stream_index === 0);
    expect(ptsOf(video[0]!)).toBe(0);
    expect(dtsOf(video[0]!)).toBe(-6000);
    const audio = placed.filter((p) => p.stream_index === 1);
    expect(ptsOf(audio[0]!)).toBe(0);
  });

  it('keeps the source timing of a continuing segment', () => {
    const timeline = new Timeline();
    timeline.place(segment(126000));
    const next = timeline.place(segment(126000 + 180000));
    expect(dtsOf(next.find((p) => p.stream_index === 0)!)).toBe(180000 - 6000);
    expect(dtsOf(next.find((p) => p.stream_index === 1)!)).toBe(180000);
    expect(next).toHaveLength(segment(0).length);
  });

  it('passes AV_NOPTS_VALUE through', () => {
    const timeline = new Timeline();
    const placed = timeline.place([packet(0, 9000, 9000, 3000), packet(0, null, 12000, 3000)]);
    expect(ptsOf(placed[1]!)).toBe(NOPTS);
    expect(dtsOf(placed[1]!)).toBe(3000);
  });

  it('re-anchors a discontinuity so that every stream starts after its end', () => {
    const timeline = new Timeline();
    timeline.place(segment(126000));
    const videoEnd = timeline.streamEndUs(0);
    const audioEnd = timeline.streamEndUs(1);
    // The same source timestamps again, as after an encoder restart.
    const placed = timeline.place(segment(126000), { discontinuity: true });
    const firstVideo = placed.find((p) => p.stream_index === 0)!;
    const firstAudio = placed.find((p) => p.stream_index === 1)!;
    const toUs = (ticks: number): number => (ticks * 1e6) / 90000;
    // Audio ends last: it starts exactly at its own end, video a little after its own.
    expect(toUs(dtsOf(firstAudio))).toBeCloseTo(audioEnd!, 6);
    expect(toUs(dtsOf(firstVideo))).toBeGreaterThanOrEqual(videoEnd!);
    expect(placed).toHaveLength(segment(0).length);
  });

  it('keeps the gap of a skipped segment when the source timeline continues', () => {
    const timeline = new Timeline();
    timeline.place(segment(126000));
    timeline.skip(2_000_000);
    const placed = timeline.place(segment(126000 + 360000));
    expect(dtsOf(placed.find((p) => p.stream_index === 0)!)).toBe(360000 - 6000);
  });

  it('reports as gap only the skipped time a later segment follows', () => {
    const timeline = new Timeline();
    timeline.place(segment(126000));
    timeline.skip(2_000_000);
    expect(timeline.gapUs).toBe(0);
    timeline.place(segment(126000 + 360000));
    expect(timeline.gapUs).toBe(2_000_000);
    const duration = timeline.durationUs;
    // A trailing run of skipped segments: no gap, the output just ends earlier.
    timeline.skip(2_000_000);
    timeline.skip(2_000_000);
    expect(timeline.gapUs).toBe(2_000_000);
    expect(timeline.durationUs).toBe(duration);
  });

  it('places a re-anchored segment after the skipped time', () => {
    const timeline = new Timeline();
    timeline.place(segment(126000));
    const audioEnd = timeline.streamEndUs(1)!;
    timeline.skip(2_000_000);
    const placed = timeline.place(segment(9_000_000), { discontinuity: true });
    const firstAudio = placed.find((p) => p.stream_index === 1)!;
    expect((dtsOf(firstAudio) * 1e6) / 90000).toBeCloseTo(audioEnd + 2_000_000, 6);
  });

  it('re-anchors a backward jump such as the 33-bit MPEG-TS wrap without a tag', () => {
    const timeline = new Timeline();
    const nearWrap = 2 ** 33 - 90000;
    timeline.place(segment(nearWrap - 90000));
    const ends = [timeline.streamEndUs(0)!, timeline.streamEndUs(1)!];
    // The next segment continues past 2^33, so its timestamps wrapped around to 0.
    const placed = timeline.place(segment(nearWrap + 90000 - 2 ** 33));
    for (const stream of [0, 1]) {
      const first = (dtsOf(placed.find((p) => p.stream_index === stream)!) * 1e6) / 90000;
      expect(first).toBeGreaterThanOrEqual(ends[stream]! - 1);
      expect(first).toBeLessThan(timeline.endUs - 1_000_000);
    }
    // The stream that ended last (audio) starts exactly at the end of the output.
    const audio = placed.find((p) => p.stream_index === 1)!;
    expect((dtsOf(audio) * 1e6) / 90000).toBeCloseTo(Math.max(...ends), 0);
    expect(placed).toHaveLength(segment(0).length);
  });

  it('re-anchors a forward jump beyond the limit and keeps a smaller one', () => {
    const small = new Timeline({ forwardLimitUs: 10_000_000 });
    small.place(segment(0));
    // 5 s ahead of the end: within the limit, the source gap stays.
    expect(dtsOf(small.place(segment(180000 + 450000))[0]!)).toBe(630000 - 6000);

    const big = new Timeline({ forwardLimitUs: 10_000_000 });
    big.place(segment(0));
    const end = big.endUs;
    const placed = big.place(segment(180000 + 90000 * 60));
    expect(Math.min(...placed.map((p) => (dtsOf(p) * 1e6) / 90000))).toBeLessThan(end + 100_000);
  });

  it('drops packets whose shifted DTS does not increase within a stream', () => {
    const timeline = new Timeline();
    const placed = timeline.place([
      packet(0, 0, 0, 3000),
      packet(0, 3000, 3000, 3000),
      packet(0, 3000, 3000, 3000),
      packet(0, 1500, 1500, 3000),
      packet(0, 6000, 6000, 3000),
    ]);
    expect(placed.map(dtsOf)).toEqual([0, 3000, 6000]);
    // Across segments too: an overlap of less than a second is not a jump, it is trimmed.
    const next = timeline.place([packet(0, 6000, 6000, 3000), packet(0, 9000, 9000, 3000)]);
    expect(next.map(dtsOf)).toEqual([9000]);
  });

  it('estimates a missing duration from the previous DTS step', () => {
    const timeline = new Timeline();
    timeline.place([packet(0, 0, 0, 0), packet(0, 3000, 3000, 0), packet(0, 6000, 6000, 0)]);
    expect(timeline.streamEndUs(0)).toBeCloseTo(((6000 + 3000) * 1e6) / 90000, 6);
  });

  it('shifts streams with different time bases exactly (fMP4: 1/15360 and 1/48000)', () => {
    const video = { time_base_num: 1, time_base_den: 15360 };
    const audio = { time_base_num: 1, time_base_den: 48000 };
    const timeline = new Timeline();
    // Video presented from 1024 (one 15 fps frame of 1/15360), audio from 0.
    const first = timeline.place([
      packet(0, 2048, 0, 1024, video),
      packet(1, 0, 0, 1024, audio),
      packet(0, 1024, 1024, 1024, video),
    ]);
    expect(first.map((p) => [ptsOf(p), dtsOf(p)])).toEqual([
      [2048, 0],
      [0, 0],
      [1024, 1024],
    ]);
    // Second segment, continuing: 2 s later in both time bases.
    const second = timeline.place([
      packet(0, 2 * 15360 + 2048, 2 * 15360, 1024, video),
      packet(1, 2 * 48000, 2 * 48000, 1024, audio),
    ]);
    expect(second.map(dtsOf)).toEqual([2 * 15360, 2 * 48000]);
    // Re-anchored: the offset in each time base is the rounded microsecond offset.
    const third = timeline.place(
      [packet(0, 2048, 1024, 1024, video), packet(1, 0, 0, 1024, audio)],
      { discontinuity: true },
    );
    const audioStart = (dtsOf(third[1]!) * 1e6) / 48000;
    expect(audioStart).toBeCloseTo(timeline.streamEndUs(1)! - (1024 * 1e6) / 48000, 0);
    expect(Number.isInteger(dtsOf(third[0]!))).toBe(true);
  });
});
