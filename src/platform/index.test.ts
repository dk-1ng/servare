import { describe, expect, it } from 'vitest';
import { resolvePlatform } from './index';

describe('resolvePlatform', () => {
  it('maps Firefox to its native capabilities', () => {
    expect(resolvePlatform('firefox')).toEqual({
      name: 'firefox',
      needsOffscreenDocument: false,
      needsExtraHeaders: false,
      downloadsIncognitoOption: true,
    });
  });

  it('treats every other target as Chromium', () => {
    for (const name of ['chrome', 'edge', 'opera']) {
      expect(resolvePlatform(name)).toMatchObject({
        name: 'chrome',
        needsOffscreenDocument: true,
        needsExtraHeaders: true,
        downloadsIncognitoOption: false,
      });
    }
  });
});
