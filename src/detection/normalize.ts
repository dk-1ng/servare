/**
 * Query parameters that change between requests for the same media: access tokens, signatures,
 * expiry stamps and cache busters (design §3.5). Compared case-insensitively.
 */
const VOLATILE_PARAMS = new Set([
  'token',
  'access_token',
  'auth',
  'authorization',
  'sig',
  'signature',
  'expires',
  'expire',
  'exp',
  'hdnts',
  'hmac',
  'policy',
  'key-pair-id',
  'st',
  'ts',
  'timestamp',
  'session',
  'sessionid',
  'nocache',
  'rand',
  'random',
  '_',
]);

/** Signed-URL schemes of the big object stores use a shared prefix for all their parameters. */
const VOLATILE_PREFIXES = ['x-amz-', 'x-goog-'];

function isVolatile(name: string): boolean {
  const lower = name.toLowerCase();
  return VOLATILE_PARAMS.has(lower) || VOLATILE_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * The identity of a media URL: no fragment, no volatile parameters, remaining parameters
 * sorted. Returns the input when it is not a valid URL.
 */
export function normalizeUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return input;
  }
  url.hash = '';
  const kept = [...url.searchParams].filter(([name]) => !isVolatile(name));
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = '';
  for (const [name, value] of kept) url.searchParams.append(name, value);
  return url.href;
}
