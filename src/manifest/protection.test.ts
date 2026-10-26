import { describe, expect, it } from 'vitest';
import { parsePlaylist } from './hls';
import {
  ProtectedContentError,
  assertDownloadable,
  mpdIsProtected,
  playlistIsProtected,
} from './protection';

const BASE = 'https://example.test/v/';
const mpd = (inner: string): string =>
  `<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:cenc="urn:mpeg:cenc:2013">` +
  `<Period><AdaptationSet>${inner}<Representation id="1" bandwidth="1"/></AdaptationSet></Period></MPD>`;

describe('mpdIsProtected', () => {
  it('flags ContentProtection for any scheme', () => {
    expect(
      mpdIsProtected(
        mpd('<ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>'),
      ),
    ).toBe(true);
    expect(
      mpdIsProtected(mpd('<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" />')),
    ).toBe(true);
    expect(mpdIsProtected(mpd('<ContentProtection\n schemeIdUri="x"></ContentProtection>'))).toBe(
      true,
    );
  });

  it('flags prefixed elements', () => {
    expect(mpdIsProtected(mpd('<mpd:ContentProtection schemeIdUri="x"/>'))).toBe(true);
  });

  it('accepts a clear manifest', () => {
    expect(mpdIsProtected(mpd(''))).toBe(false);
  });

  it('ignores mentions inside comments and CDATA', () => {
    expect(mpdIsProtected(mpd('<!-- <ContentProtection schemeIdUri="x"/> -->'))).toBe(false);
    expect(mpdIsProtected(mpd('<![CDATA[<ContentProtection/>]]>'))).toBe(false);
  });

  it('is not fooled by a comment placed before a real element', () => {
    expect(mpdIsProtected(mpd('<!-- x --><ContentProtection schemeIdUri="x"/>'))).toBe(true);
  });

  it('is not fooled by a processing instruction that contains a comment opener', () => {
    expect(
      mpdIsProtected('<MPD><?pi <!-- ?><ContentProtection schemeIdUri="x"/><!-- --></MPD>'),
    ).toBe(true);
  });

  it('treats a DTD as protected', () => {
    expect(
      mpdIsProtected('<!DOCTYPE MPD [<!ENTITY cp "&#60;ContentProtection/>">]><MPD>&cp;</MPD>'),
    ).toBe(true);
  });

  it('does not match similarly named elements', () => {
    expect(mpdIsProtected(mpd('<ContentProtectionNote/>'))).toBe(false);
  });
});

describe('playlistIsProtected', () => {
  const media = (key: string): string =>
    `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n${key}\n#EXTINF:6,\ns0.ts\n#EXT-X-ENDLIST\n`;

  it.each([
    '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="k",KEYFORMAT="com.apple.streamingkeydelivery"',
    '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="k"',
    '#EXT-X-KEY:METHOD=AES-128,URI="k",KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"',
    '#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI="k"',
  ])('flags %s', (key) => {
    expect(playlistIsProtected(parsePlaylist(media(key), BASE))).toBe(true);
  });

  it('accepts AES-128 with the identity key format and unencrypted playlists', () => {
    expect(
      playlistIsProtected(parsePlaylist(media('#EXT-X-KEY:METHOD=AES-128,URI="k"'), BASE)),
    ).toBe(false);
    expect(playlistIsProtected(parsePlaylist(media('#EXT-X-KEY:METHOD=NONE'), BASE))).toBe(false);
  });

  it('flags a protected EXT-X-SESSION-KEY in a master playlist', () => {
    const master =
      '#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="k",KEYFORMAT="com.apple.streamingkeydelivery"\n' +
      '#EXT-X-STREAM-INF:BANDWIDTH=1000\nv.m3u8\n';
    expect(playlistIsProtected(parsePlaylist(master, BASE))).toBe(true);
  });
});

describe('assertDownloadable', () => {
  it('refuses a protected item', () => {
    expect(() => assertDownloadable({ protected: true })).toThrow(ProtectedContentError);
  });

  it('refuses an item built from a parsed protected playlist', () => {
    const text =
      '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="k"\n#EXTINF:6,\ns0.ts\n#EXT-X-ENDLIST\n';
    const item = { protected: playlistIsProtected(parsePlaylist(text, BASE)) };
    expect(() => assertDownloadable(item)).toThrow(ProtectedContentError);
  });

  it('lets a clear item through', () => {
    expect(() => assertDownloadable({ protected: false })).not.toThrow();
  });
});
