import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PlaylistError,
  containerForCodecs,
  isHiddenVariant,
  parseAttributes,
  parsePlaylist,
  type MasterPlaylist,
  type MediaPlaylist,
} from './hls';

const OUT = path.resolve(import.meta.dirname, '../../test/fixtures/out/hls');
const BASE = 'https://example.test/v/';
const fixture = (rel: string): string | undefined => {
  try {
    return readFileSync(path.join(OUT, rel), 'utf8');
  } catch {
    return undefined; // FFmpeg missing: fixture-backed cases skip
  }
};
const media = (text: string, base = BASE): MediaPlaylist => {
  const p = parsePlaylist(text, base);
  if (p.kind !== 'media') throw new Error('expected media playlist');
  return p;
};

describe('parseAttributes', () => {
  it('handles quoted commas and bare values', () => {
    expect(parseAttributes('BANDWIDTH=1,CODECS="avc1.4d4015,mp4a.40.2",NAME="a=b"')).toEqual({
      BANDWIDTH: '1',
      CODECS: 'avc1.4d4015,mp4a.40.2',
      NAME: 'a=b',
    });
  });
});

describe('fixtures', () => {
  const f = (rel: string) => fixture(rel);

  it('master with two variants', () => {
    const text = f('variants/master.m3u8');
    if (!text) return;
    const p = parsePlaylist(text, BASE) as MasterPlaylist;
    expect(p.kind).toBe('master');
    expect(p.variants).toMatchObject([
      {
        uri: BASE + 'hi.m3u8',
        bandwidth: 800000,
        width: 320,
        height: 240,
        codecs: 'avc1.4d4015,mp4a.40.2',
      },
      { uri: BASE + 'lo.m3u8', bandwidth: 300000, width: 160, height: 120 },
    ]);
    expect(p.protected).toBe(false);
  });

  it('VOD media playlist: duration, no live', () => {
    const text = f('variants/hi.m3u8');
    if (!text) return;
    const p = media(text);
    expect(p.live).toBe(false);
    expect(p.playlistType).toBe('VOD');
    expect(p.duration).toBeCloseTo(6, 1);
    expect(p.segments.map((s) => s.uri)).toEqual(
      [0, 1, 2].map((i) => `${BASE}hi_00${String(i)}.ts`),
    );
    expect(p.segments.map((s) => s.sequence)).toEqual([0, 1, 2]);
  });

  it('fMP4 playlist carries EXT-X-MAP on every segment', () => {
    const text = f('fmp4/index.m3u8');
    if (!text) return;
    const p = media(text);
    expect(p.segments.every((s) => s.map?.uri === BASE + 'init.mp4')).toBe(true);
  });

  it('AES-128 with explicit IV and with implicit IV', () => {
    const iv = f('aes128-iv/index.m3u8');
    const noiv = f('aes128-noiv/index.m3u8');
    if (!iv || !noiv) return;
    const a = media(iv);
    expect(a.protected).toBe(false);
    expect(a.segments[0]!.key).toMatchObject({
      method: 'AES-128',
      uri: BASE + 'key.bin',
      iv: 'a0a1a2a3a4a5a6a7a8a9aaabacadaeaf',
    });
    const b = media(noiv);
    expect(b.segments[0]!.key?.iv).toBeUndefined();
    expect(b.segments[2]!.sequence).toBe(2);
  });

  it('alternate audio and subtitles', () => {
    const text = f('alt/master.m3u8');
    if (!text) return;
    const p = parsePlaylist(text, BASE) as MasterPlaylist;
    expect(p.variants[0]).toMatchObject({ audioGroup: 'aud', subtitlesGroup: 'sub' });
    expect(p.renditions.map((r) => [r.type, r.language, r.default, r.uri])).toEqual([
      ['AUDIO', 'en', true, BASE + 'audio_en.m3u8'],
      ['AUDIO', 'pt', false, BASE + 'audio_pt.m3u8'],
      ['SUBTITLES', 'en', true, BASE + 'subs.m3u8'],
    ]);
    const subs = f('alt/subs.m3u8');
    if (subs) expect(media(subs).segments[0]!.uri).toBe(BASE + 'subs.vtt');
  });
});

describe('media playlist semantics', () => {
  it('detects live and starts sequence numbers at EXT-X-MEDIA-SEQUENCE', () => {
    const p = media(
      '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:100\n#EXTINF:4,\na.ts\n#EXTINF:3.5,\nb.ts\n',
    );
    expect(p.live).toBe(true);
    expect(p.duration).toBe(7.5);
    expect(p.segments.map((s) => s.sequence)).toEqual([100, 101]);
  });

  it('resolves BYTERANGE offsets, continuing the previous range of the same resource', () => {
    const p = media(
      '#EXTM3U\n#EXT-X-MAP:URI="i.mp4",BYTERANGE="10@0"\n#EXTINF:1,\n#EXT-X-BYTERANGE:100@50\nf.mp4\n#EXTINF:1,\n#EXT-X-BYTERANGE:200\nf.mp4\n#EXTINF:1,\n#EXT-X-BYTERANGE:5@0\ng.mp4\n#EXT-X-ENDLIST',
    );
    expect(p.segments.map((s) => s.byteRange)).toEqual([
      { length: 100, offset: 50 },
      { length: 200, offset: 150 },
      { length: 5, offset: 0 },
    ]);
    expect(p.segments[0]!.map?.byteRange).toEqual({ length: 10, offset: 0 });
  });

  it('applies a key to the segments after it, until METHOD=NONE', () => {
    const p = media(
      '#EXTM3U\n#EXTINF:1,\na.ts\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:1,\nb.ts\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:1,\nc.ts\n',
    );
    expect(p.segments.map((s) => s.key?.method)).toEqual([undefined, 'AES-128', undefined]);
  });

  it('flags other methods and key formats as protected, without exposing the key URI', () => {
    for (const attrs of [
      'METHOD=SAMPLE-AES,URI="k"',
      'METHOD=AES-128,URI="k",KEYFORMAT="com.example.drm"',
    ]) {
      const p = media(`#EXTM3U\n#EXT-X-KEY:${attrs}\n#EXTINF:1,\na.ts\n#EXT-X-ENDLIST`);
      expect(p.protected).toBe(true);
      expect(p.segments[0]!.key?.uri).toBeUndefined();
    }
  });

  it('flags protected session keys in a master', () => {
    const p = parsePlaylist(
      '#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="k"\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8',
      BASE,
    );
    expect(p).toMatchObject({ kind: 'master', protected: true });
  });

  it('tolerates BOM, CRLF and unknown tags', () => {
    const p = media('﻿#EXTM3U\r\n#EXT-X-FUTURE:1\r\n#EXTINF:2,\r\na.ts\r\n#EXT-X-ENDLIST\r\n');
    expect(p.segments).toHaveLength(1);
  });

  it('rejects non-playlists and non-http URIs', () => {
    expect(() => parsePlaylist('<html>', BASE)).toThrow(PlaylistError);
    expect(() => media('#EXTM3U\n#EXTINF:1,\nfile:///etc/passwd\n')).toThrow(PlaylistError);
    expect(() => media('#EXTM3U\n#EXTINF:1,\njavascript:alert(1)\n')).toThrow(PlaylistError);
  });
});

describe('hostile and malformed input', () => {
  it('parses a megabyte-long attribute value in linear time', () => {
    const start = performance.now();
    expect(parseAttributes('A'.repeat(1_000_000))).toEqual({});
    expect(performance.now() - start).toBeLessThan(500);
    expect(() => media(`#EXTM3U\n#EXT-X-KEY:${'A'.repeat(100_000)}\n`)).toThrow(PlaylistError);
  });

  it('skips a malformed entry and keeps the rest', () => {
    expect(parseAttributes('A=1,garbage,B=2')).toEqual({ A: '1', B: '2' });
  });

  it('rejects a malformed IV and an AES-128 key without URI', () => {
    const key = (a: string) => () => media(`#EXTM3U\n#EXT-X-KEY:${a}\n#EXTINF:1,\na.ts\n`);
    expect(key('METHOD=AES-128,URI="k",IV=0x' + 'a'.repeat(34))).toThrow(PlaylistError);
    expect(key('METHOD=AES-128,URI="k",IV=zz')).toThrow(PlaylistError);
    expect(key('METHOD=AES-128')).toThrow(PlaylistError);
  });

  it('continues a segment range after a byte-ranged EXT-X-MAP in the same file', () => {
    const p = media(
      '#EXTM3U\n#EXT-X-MAP:URI="f.mp4",BYTERANGE="720@0"\n#EXTINF:1,\n#EXT-X-BYTERANGE:1000\nf.mp4\n#EXT-X-ENDLIST',
    );
    expect(p.segments[0]!.byteRange).toEqual({ length: 1000, offset: 720 });
  });
});

describe('attribute edge cases', () => {
  it('fails closed when an unparsable entry precedes KEYFORMAT', () => {
    const p = media(
      '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://e.com/k",x-vendor=1,KEYFORMAT="com.vendor.drm"\n#EXTINF:1,\na.ts\n',
    );
    expect(p.protected).toBe(true);
    expect(p.segments[0]!.key?.uri).toBeUndefined();
  });

  it('accepts spaces after commas', () => {
    expect(parseAttributes('METHOD=AES-128, URI="k"')).toEqual({ METHOD: 'AES-128', URI: 'k' });
  });

  it('keeps a repeated byte-ranged MAP from rewinding the range', () => {
    const map = '#EXT-X-MAP:URI="f.mp4",BYTERANGE="720@0"';
    const p = media(
      `#EXTM3U\n${map}\n#EXTINF:1,\n#EXT-X-BYTERANGE:1000\nf.mp4\n#EXT-X-DISCONTINUITY\n${map}\n#EXTINF:1,\n#EXT-X-BYTERANGE:1000\nf.mp4\n#EXT-X-ENDLIST`,
    );
    expect(p.segments.map((x) => x.byteRange?.offset)).toEqual([720, 1720]);
  });

  it('rejects a byte range whose offset cannot be derived', () => {
    expect(() => media('#EXTM3U\n#EXTINF:1,\n#EXT-X-BYTERANGE:10\nf.mp4\n')).toThrow(PlaylistError);
  });
});

describe('isHiddenVariant', () => {
  it('hides only variants with an unsupported codec, not those without CODECS', () => {
    expect(isHiddenVariant({ codecs: undefined })).toBe(false);
    expect(isHiddenVariant({ codecs: 'avc1.4d4015,mp4a.40.2' })).toBe(false);
    expect(isHiddenVariant({ codecs: 'avc1.4d4015,mp4a.40.2,wvtt' })).toBe(false);
    expect(isHiddenVariant({ codecs: 'avc1.4d4015,mystery.1' })).toBe(true);
  });
});

describe('containerForCodecs', () => {
  it.each([
    ['avc1.4d4015,mp4a.40.2', 'mp4'],
    ['hvc1.1.6.L93.B0,mp4a.40.5', 'mp4'],
    ['avc1.64001f', 'mp4'],
    ['vp09.00.10.08,opus', 'webm'],
    ['av01.0.04M.08,opus', 'webm'],
    ['avc1.4d4015,opus', 'mkv'],
    ['vp9,mp4a.40.2', 'mkv'],
    ['avc1.4d4015,mystery.1', undefined],
    ['', undefined],
    [undefined, undefined],
  ])('%s → %s', (codecs, expected) => {
    expect(containerForCodecs(codecs)).toBe(expected);
  });
});
