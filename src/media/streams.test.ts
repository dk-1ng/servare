import { describe, expect, it } from 'vitest';
import {
  matchStreams,
  mediaTypeOf,
  selectStreams,
  UnsupportedMediaError,
  type StreamInfo,
} from './streams';

let next = 0;
function stream(patch: Partial<StreamInfo>): StreamInfo {
  return {
    index: next++,
    type: 'video',
    codec: 'h264',
    timeBase: { num: 1, den: 90000 },
    sampleRate: 0,
    channels: 0,
    width: 0,
    height: 0,
    extradata: null,
    ...patch,
  };
}
const video = (patch: Partial<StreamInfo> = {}): StreamInfo =>
  stream({ type: 'video', codec: 'h264', width: 320, height: 240, ...patch });
const audio = (patch: Partial<StreamInfo> = {}): StreamInfo =>
  stream({ type: 'audio', codec: 'aac', sampleRate: 48000, channels: 2, ...patch });

describe('mediaTypeOf', () => {
  it('maps AVMediaType values', () => {
    expect([0, 1, 2, 3, 4, -1, 9].map(mediaTypeOf)).toEqual([
      'video',
      'audio',
      'data',
      'subtitle',
      'attachment',
      'unknown',
      'unknown',
    ]);
  });
});

describe('selectStreams', () => {
  it('keeps video and audio and drops data, subtitles and attachments', () => {
    const streams = [
      video({ index: 0 }),
      audio({ index: 1 }),
      stream({ index: 2, type: 'data', codec: 'timed_id3' }),
      stream({ index: 3, type: 'subtitle', codec: 'webvtt' }),
      stream({ index: 4, type: 'attachment', codec: 'ttf' }),
    ];
    const { kept, dropped } = selectStreams(streams);
    expect(kept.map((s) => s.index)).toEqual([0, 1]);
    expect(dropped.map((d) => d.index)).toEqual([2, 3, 4]);
  });

  it('drops audio without a sample rate and video without dimensions', () => {
    const streams = [
      video({ index: 0 }),
      audio({ index: 1 }),
      audio({ index: 2, codec: 'mp3', sampleRate: 0 }),
      video({ index: 3, width: 0, height: 0 }),
    ];
    const { kept, dropped } = selectStreams(streams);
    expect(kept.map((s) => s.index)).toEqual([0, 1]);
    expect(dropped).toEqual([
      { index: 2, reason: 'audio without a sample rate' },
      { index: 3, reason: 'video without dimensions' },
    ]);
  });

  it('drops an unsupported codec when another stream of its type is kept', () => {
    const { kept, dropped } = selectStreams([
      video({ index: 0 }),
      audio({ index: 1, codec: 'dts' }),
      audio({ index: 2 }),
    ]);
    expect(kept.map((s) => s.index)).toEqual([0, 2]);
    expect(dropped).toEqual([{ index: 1, reason: 'unsupported codec dts' }]);
  });

  it('refuses an unsupported codec that is the only stream of its type', () => {
    expect(() => selectStreams([video({ index: 0 }), audio({ index: 1, codec: 'dts' })])).toThrow(
      new UnsupportedMediaError('Unsupported codec dts'),
    );
    expect(() => selectStreams([video({ codec: 'mpeg2video' }), audio()])).toThrow(
      UnsupportedMediaError,
    );
  });

  it('keeps several streams of one type', () => {
    expect(selectStreams([video(), audio(), audio()]).kept).toHaveLength(3);
  });

  it('returns nothing to keep for a data-only input', () => {
    expect(selectStreams([stream({ type: 'data', codec: 'timed_id3' })]).kept).toEqual([]);
  });
});

describe('matchStreams', () => {
  const outputs = [video({ index: 0 }), audio({ index: 1 })];

  it('maps by type and order, whatever the input order', () => {
    const result = matchStreams(outputs, [
      stream({ index: 0, type: 'data', codec: 'timed_id3' }),
      audio({ index: 1 }),
      video({ index: 2 }),
    ]);
    expect(result).toEqual({
      ok: true,
      map: new Map([
        [2, 0],
        [1, 1],
      ]),
    });
  });

  it('skips the same streams the first segment dropped before counting', () => {
    const outs = [video({ index: 0 }), audio({ index: 2 })];
    const result = matchStreams(outs, [
      video({ index: 0 }),
      audio({ index: 1, codec: 'dts' }),
      audio({ index: 2, codec: 'mp3', sampleRate: 0 }),
      audio({ index: 3 }),
    ]);
    expect(result).toEqual({
      ok: true,
      map: new Map([
        [0, 0],
        [3, 1],
      ]),
    });
  });

  it('accepts a resolution change and ignores extra streams', () => {
    const result = matchStreams(outputs, [
      video({ index: 0, width: 160, height: 120 }),
      audio({ index: 1 }),
      audio({ index: 2 }),
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect([...result.map.keys()]).toEqual([0, 1]);
  });

  it.each([
    ['a missing stream', [video({ index: 0 })], /no audio stream 1/],
    ['another codec', [video({ index: 0, codec: 'hevc' }), audio({ index: 1 })], /codec/],
    ['another sample rate', [video({ index: 0 }), audio({ index: 1, sampleRate: 44100 })], /rate/],
    ['another channel count', [video({ index: 0 }), audio({ index: 1, channels: 1 })], /channel/],
  ])('is incompatible with %s', (_what, segment, reason) => {
    const result = matchStreams(outputs, segment);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(reason);
  });

  it('compares extradata only when the output stream has some', () => {
    const avcc = new Uint8Array([1, 2, 3]);
    const withConfig = [video({ index: 0, extradata: avcc }), audio({ index: 1 })];
    expect(
      matchStreams(withConfig, [
        video({ index: 0, extradata: new Uint8Array([1, 2, 3]) }),
        audio({ index: 1 }),
      ]).ok,
    ).toBe(true);
    expect(
      matchStreams(withConfig, [
        video({ index: 0, extradata: new Uint8Array([1, 2, 4]) }),
        audio({ index: 1 }),
      ]),
    ).toEqual({ ok: false, reason: 'video stream 1 changed codec configuration' });
    expect(matchStreams(withConfig, [video({ index: 0 }), audio({ index: 1 })]).ok).toBe(false);
    // MPEG-TS: no extradata on either side, parameter sets in band.
    expect(
      matchStreams(outputs, [
        video({ index: 0, extradata: new Uint8Array([9]) }),
        audio({ index: 1 }),
      ]).ok,
    ).toBe(true);
  });
});
