import { describe, expect, it } from 'vitest';
import {
  buildFileName,
  expandTemplate,
  formatDate,
  sanitizeFileName,
  sanitizeSubfolder,
} from './index';

describe('sanitizeFileName', () => {
  it('keeps ordinary names', () => {
    expect(sanitizeFileName('My Video')).toBe('My Video');
  });

  it('keeps emoji and non-Latin text', () => {
    expect(sanitizeFileName('Aula 🎬 日本語')).toBe('Aula 🎬 日本語');
  });

  it('normalizes to NFC', () => {
    expect(sanitizeFileName('cafe\u0301')).toBe('caf\u00e9');
  });

  it('replaces slashes and other invalid characters', () => {
    expect(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a b c d e f g h i j');
  });

  it('removes control and invisible characters', () => {
    expect(sanitizeFileName('a\u0000b\u200bc\n d')).toBe('a bc d');
  });

  it('collapses whitespace and trims dots', () => {
    expect(sanitizeFileName('  ..a \t  b..  ')).toBe('a b');
  });

  it.each(['', '   ', '...', '///', '\u0000'])('falls back to video for %j', (input) => {
    expect(sanitizeFileName(input)).toBe('video');
  });

  it.each(['CON', 'nul', 'Com1', 'LPT9', 'aux.txt', 'COM¹'])('prefixes reserved name %s', (n) => {
    expect(sanitizeFileName(n)).toBe(`_${n}`);
  });

  it('leaves names that merely contain a reserved word', () => {
    expect(sanitizeFileName('console')).toBe('console');
  });

  it('limits length to 180 characters including the extension', () => {
    const result = sanitizeFileName('a'.repeat(500), 'mp4');
    expect(Array.from(result)).toHaveLength(180);
    expect(result.endsWith('.mp4')).toBe(true);
  });

  it('does not split surrogate pairs when truncating', () => {
    const result = sanitizeFileName('🎬'.repeat(300));
    expect(Array.from(result)).toHaveLength(60);
    expect(new TextEncoder().encode(result).length).toBeLessThanOrEqual(240);
  });

  it('applies the fallback and reserved check before adding the extension', () => {
    expect(sanitizeFileName('', '.mkv')).toBe('video.mkv');
    expect(sanitizeFileName('con', 'mp4')).toBe('_con.mp4');
  });

  it('keeps the limit when the reserved prefix is added', () => {
    const result = sanitizeFileName('con.' + 'a'.repeat(300), 'mp4');
    expect(Array.from(result)).toHaveLength(180);
    expect(result.startsWith('_con.')).toBe(true);
  });

  it('caps multi-byte names at 240 UTF-8 bytes', () => {
    const result = sanitizeFileName('日本語'.repeat(100), 'mp4');
    expect(new TextEncoder().encode(result).length).toBeLessThanOrEqual(240);
    expect(result.endsWith('.mp4')).toBe(true);
  });

  it.each(['CONIN$', 'clock$'])('prefixes reserved device %s', (n) => {
    expect(sanitizeFileName(n)).toBe(`_${n}`);
  });

  it('drops unsafe characters from the extension', () => {
    expect(sanitizeFileName('a', '../x/y')).toBe('a.xy');
    expect(sanitizeFileName('a', '..')).toBe('a');
  });
});

describe('sanitizeSubfolder', () => {
  it('cleans each segment and joins with a slash', () => {
    expect(sanitizeSubfolder('Videos/ My: Show ')).toBe('Videos/My Show');
  });

  it('drops traversal, roots and empty segments', () => {
    expect(sanitizeSubfolder('/../a//./b/..')).toBe('a/b');
    expect(sanitizeSubfolder('C:\\Windows')).toBe('C/Windows');
  });

  it('is empty when unset or unusable', () => {
    expect(sanitizeSubfolder(undefined)).toBe('');
    expect(sanitizeSubfolder('..')).toBe('');
  });

  it('does not leave trailing spaces or dots after truncation', () => {
    expect(sanitizeSubfolder('a'.repeat(179) + ' b')).toBe('a'.repeat(179));
    expect(sanitizeSubfolder('a'.repeat(179) + '.b')).toBe('a'.repeat(179));
  });

  it('keeps the byte cap when a reserved segment gets its prefix', () => {
    const segment = sanitizeSubfolder('con.ab' + '日'.repeat(100));
    expect(new TextEncoder().encode(segment).length).toBeLessThanOrEqual(240);
    expect(segment.startsWith('_con.ab')).toBe(true);
  });

  it('avoids reserved segment names', () => {
    expect(sanitizeSubfolder('nul/x')).toBe('_nul/x');
  });
});

describe('expandTemplate', () => {
  it('fills known variables', () => {
    expect(
      expandTemplate('{host} - {title} [{quality}] {lang} {date}', {
        host: 'example.com',
        title: 'T',
        quality: '720p',
        lang: 'pt',
        date: '2026-01-02',
      }),
    ).toBe('example.com - T [720p] pt 2026-01-02');
  });

  it('expands unknown and missing variables to nothing', () => {
    expect(expandTemplate('{title}{nope}{lang}', { title: 'x' })).toBe('x');
  });

  it('ignores inherited property names', () => {
    expect(expandTemplate('{constructor}{toString}{__proto__}x', {})).toBe('x');
  });

  it('cleans values so they cannot add path segments', () => {
    expect(expandTemplate('{title}', { title: '../../etc/passwd' })).toBe('etc passwd');
  });
});

describe('buildFileName', () => {
  it('defaults to the title template', () => {
    expect(buildFileName('', { title: 'Clip' }, { extension: 'mp4' })).toBe('Clip.mp4');
  });

  it('falls back when every variable is empty', () => {
    expect(buildFileName('{title}', {}, { extension: 'mp4' })).toBe('video.mp4');
  });

  it('prepends a sanitized subfolder', () => {
    expect(
      buildFileName('{title}', { title: 'a/b' }, { extension: 'mp4', subfolder: 'Servare/x' }),
    ).toBe('Servare/x/a b.mp4');
  });

  it('sanitizes characters in the template itself', () => {
    expect(buildFileName('{host}/{title}', { host: 'h', title: 't' })).toBe('h t');
  });
});

describe('formatDate', () => {
  it('pads month and day', () => {
    expect(formatDate(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});
