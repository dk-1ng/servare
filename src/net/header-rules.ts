import type { CapturedHeaders } from '../detection/header-cache';

/** Rule IDs reserved for header replay (design §4.1.1); nothing else may use this range. */
export const RULE_ID_MIN = 1_000_000;
export const RULE_ID_MAX = 1_999_999;

export interface ReplayRule {
  id: number;
  priority: number;
  action: {
    type: 'modifyHeaders';
    requestHeaders: { header: string; operation: 'set' | 'remove'; value?: string }[];
  };
  condition: {
    regexFilter: string;
    initiatorDomains: string[];
    resourceTypes: ('xmlhttprequest' | 'other')[];
  };
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * One rule for one exact origin (scheme, host, port) that reapplies the player's headers, but
 * only to requests started by this extension (§4.1.1). Referer, Origin and Cookie are always
 * written: `set` when the player sent a value, `remove` otherwise.
 */
export function buildReplayRule(
  id: number,
  origin: string,
  headers: CapturedHeaders,
  ownHost: string,
): ReplayRule {
  const requestHeaders: ReplayRule['action']['requestHeaders'] = [];
  for (const [header, value] of [
    ['Referer', headers.referer],
    ['Origin', headers.origin],
    ['Cookie', headers.cookie],
  ] as const) {
    requestHeaders.push(
      value === undefined ? { header, operation: 'remove' } : { header, operation: 'set', value },
    );
  }
  return {
    id,
    priority: 1,
    action: { type: 'modifyHeaders', requestHeaders },
    condition: {
      regexFilter: `^${escapeRegExp(origin)}/`,
      initiatorDomains: [ownHost],
      resourceTypes: ['xmlhttprequest', 'other'],
    },
  };
}

/** True when both header sets would produce the same request headers. */
export function sameHeaderSet(a: CapturedHeaders, b: CapturedHeaders): boolean {
  return a.referer === b.referer && a.origin === b.origin && a.cookie === b.cookie;
}
