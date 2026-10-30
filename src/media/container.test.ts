import { describe, expect, it } from 'vitest';
import {
  chooseContainer,
  codecFromRfc6381,
  refusalReason,
  type ContainerStream,
} from './container';

const v = (codec: string, hasExtradata = true): ContainerStream => ({
  type: 'video',
  codec,
  hasExtradata,
});
const a = (codec: string, hasExtradata = true): ContainerStream => ({
  type: 'audio',
  codec,
  hasExtradata,
});

describe('chooseContainer', () => {
  it.each([
    [[v('h264'), a('aac')], 'mp4'],
    [[v('hevc', false), a('ac3', false)], 'mp4'],
    [[v('h264', false), a('mp2'), a('eac3')], 'mp4'],
    [[a('mp3')], 'mp4'],
    [[v('vp9'), a('opus')], 'webm'],
    [[v('av1'), a('vorbis')], 'webm'],
    [[v('vp8')], 'webm'],
    [[v('h264'), a('opus')], 'mkv'],
    [[v('vp9'), a('aac')], 'mkv'],
    [[v('vp9'), a('flac')], 'mkv'],
    [[a('flac')], 'mkv'],
    [[v('hevc'), a('flac')], 'mkv'],
  ] as const)('%j → %s', (streams, expected) => {
    expect(chooseContainer(streams)).toBe(expected);
  });

  it('refuses H.264 from MPEG-TS (no extradata) with Opus', () => {
    const streams = [v('h264', false), a('opus')];
    expect(chooseContainer(streams)).toBeUndefined();
    expect(refusalReason(streams)).toMatch(/combination h264 \+ opus/);
  });

  it('refuses HEVC without extradata with FLAC', () => {
    expect(chooseContainer([v('hevc', false), a('flac')])).toBeUndefined();
  });

  it('refuses unknown codecs and names them', () => {
    const streams = [v('h264'), a('dts')];
    expect(chooseContainer(streams)).toBeUndefined();
    expect(refusalReason(streams)).toBe('Unsupported codec dts');
  });

  it('refuses an empty list', () => {
    expect(chooseContainer([])).toBeUndefined();
  });
});

describe('codecFromRfc6381', () => {
  it.each([
    ['avc1.4d4015', 'h264'],
    ['avc3.640028', 'h264'],
    ['AVC1.64001F', 'h264'],
    ['hvc1.1.6.L93.B0', 'hevc'],
    ['hev1.2.4.L120.B0', 'hevc'],
    ['dvh1.05.06', 'hevc'],
    ['dvhe.05.06', 'hevc'],
    ['mp4a.40.2', 'aac'],
    ['mp4a.40.5', 'aac'],
    ['mp4a.6b', 'mp3'],
    ['mp4a.69', 'mp3'],
    ['mp4a.a5', 'ac3'],
    ['ac-3', 'ac3'],
    ['mp4a.a6', 'eac3'],
    ['ec-3', 'eac3'],
    ['vp8', 'vp8'],
    ['vp08.00.10.08', 'vp8'],
    ['vp9', 'vp9'],
    ['vp09.00.10.08', 'vp9'],
    ['av01.0.04M.08', 'av1'],
    ['opus', 'opus'],
    ['Opus', 'opus'],
    ['vorbis', 'vorbis'],
    ['fLaC', 'flac'],
    ['wvtt', 'subtitle'],
    ['stpp.ttml.im1t', 'subtitle'],
    ['mystery.1', undefined],
    ['mp4a.40', undefined],
    ['avc', undefined],
  ])('%s → %s', (entry, expected) => {
    expect(codecFromRfc6381(entry)).toBe(expected);
  });
});
