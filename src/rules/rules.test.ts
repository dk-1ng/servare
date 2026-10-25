import { describe, expect, it } from 'vitest';
import { DEFAULT_DOMAIN_RULES, defaultRules, parseRules, rulesFor } from './index';

const rules = parseRules({
  version: 1,
  domains: {
    'example.com': { minDirectSize: 5, speedProfile: 'fast', detection: false },
    'cdn.example.com': { detection: true, feedMode: true },
  },
});

describe('rulesFor', () => {
  it('returns the defaults for an unknown host', () => {
    expect(rulesFor('other.org', rules)).toEqual(DEFAULT_DOMAIN_RULES);
  });

  it('matches the domain itself', () => {
    expect(rulesFor('example.com', rules)).toEqual({
      ...DEFAULT_DOMAIN_RULES,
      minDirectSize: 5,
      speedProfile: 'fast',
      detection: false,
    });
  });

  it('inherits from the parent domain on subdomains', () => {
    expect(rulesFor('www.example.com', rules).minDirectSize).toBe(5);
    expect(rulesFor('a.b.example.com', rules).detection).toBe(false);
  });

  it('lets a subdomain override key by key and still inherit the rest', () => {
    expect(rulesFor('cdn.example.com', rules)).toEqual({
      ...DEFAULT_DOMAIN_RULES,
      minDirectSize: 5,
      speedProfile: 'fast',
      detection: true,
      feedMode: true,
    });
    expect(rulesFor('x.cdn.example.com', rules).feedMode).toBe(true);
  });

  it('does not match on a partial label or the other direction', () => {
    expect(rulesFor('notexample.com', rules)).toEqual(DEFAULT_DOMAIN_RULES);
    expect(rulesFor('com', rules)).toEqual(DEFAULT_DOMAIN_RULES);
    expect(rulesFor('example.com.evil.net', rules)).toEqual(DEFAULT_DOMAIN_RULES);
  });

  it('ignores case and a trailing dot', () => {
    expect(rulesFor('WWW.Example.COM.', rules).minDirectSize).toBe(5);
  });

  it('does not apply suffix inheritance to IP addresses', () => {
    const ip = parseRules({
      version: 1,
      domains: { '0.1': { detection: false }, '192.168.0.1': { audioOnly: true } },
    });
    expect(rulesFor('10.0.0.1', ip)).toEqual(DEFAULT_DOMAIN_RULES);
    expect(rulesFor('192.168.0.1', ip).audioOnly).toBe(true);
    expect(rulesFor('192.168.0.1', ip).detection).toBe(true);
  });

  it('is not fooled by prototype keys', () => {
    expect(rulesFor('constructor', rules)).toEqual(DEFAULT_DOMAIN_RULES);
    expect(rulesFor('__proto__', rules)).toEqual(DEFAULT_DOMAIN_RULES);
  });

  it('works with the bundled default rules', () => {
    expect(rulesFor('example.com')).toEqual(DEFAULT_DOMAIN_RULES);
    expect(defaultRules.version).toBe(1);
  });
});

describe('parseRules', () => {
  it('rejects a wrong version', () => {
    expect(() => parseRules({ version: 2, domains: {} })).toThrow();
  });

  it.each([
    ['unknown key', { 'a.com': { nope: true } }],
    ['wrong type', { 'a.com': { detection: 'yes' } }],
    ['negative size', { 'a.com': { minDirectSize: -1 } }],
    ['fractional size', { 'a.com': { minDirectSize: 1.5 } }],
    ['bad profile', { 'a.com': { speedProfile: 'turbo' } }],
    ['scheme in key', { 'https://a.com': {} }],
    ['port in key', { 'a.com:8080': {} }],
    ['uppercase key', { 'A.com': {} }],
    ['leading dot key', { '.a.com': {} }],
    ['empty key', { '': {} }],
  ])('rejects %s', (_name, domains) => {
    expect(() => parseRules({ version: 1, domains })).toThrow();
  });

  it('accepts a complete rule', () => {
    expect(() =>
      parseRules({
        version: 1,
        domains: {
          'a.com': {
            detection: true,
            minDirectSize: 0,
            propagateQuery: true,
            audioOnly: false,
            feedMode: false,
            hideFragments: false,
            speedProfile: 'economy',
          },
        },
      }),
    ).not.toThrow();
  });
});
