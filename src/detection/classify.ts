import { essence, isDashType, isDirectMediaType, isFragmentType, isHlsType } from './mime';

/** What the network observer decided a response is (docs/design.md §3.1, step 3). */
export type DetectedKind = 'hls' | 'dash' | 'direct';

/** The part of a `webRequest` response that classification needs, independent of the browser. */
export interface ResponseInfo {
  url: string;
  /** `webRequest` resource type (`media`, `xmlhttprequest`, `other`, …). */
  type: string;
  status: number;
  /** Lower-cased header names. */
  headers: Record<string, string>;
}

export interface Classification {
  kind: DetectedKind;
  /** Content type without parameters, when the server sent one. */
  mime?: string;
  /** Full size of the resource in bytes, when the server said. */
  size?: number;
  /** The server accepts `Range` requests (design §3.2). */
  resumable: boolean;
}

/**
 * One step of the classification chain. Returns a result when it recognizes the response,
 * `undefined` otherwise. HLS and DASH are recognized from hints only; confirming them from
 * the manifest body belongs to the manifest issues (design §3.3).
 */
export type Classifier = (
  response: ResponseInfo,
  context: ClassifierContext,
) => Classification | undefined;

export interface ClassifierContext {
  /** Minimum size for a direct file, in bytes. */
  minDirectSize: number;
}

/** Segment extensions that are never offered, whatever the content type says (design §3.1). */
const FRAGMENT_EXTENSIONS = new Set(['ts', 'm4s', 'aac', 'm4f', 'cmfv', 'cmfa']);

export function pathExtension(url: string): string | undefined {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return undefined;
  }
  const name = pathname.slice(pathname.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : undefined;
}

export function isFragmentUrl(url: string): boolean {
  const extension = pathExtension(url);
  return extension !== undefined && FRAGMENT_EXTENSIONS.has(extension);
}

/** `Content-Range: bytes 0-99/1000` → `{ start: 0, total: 1000 }`; `*` totals are unknown. */
export function parseContentRange(
  value: string | undefined,
): { start: number; total?: number } | undefined {
  const match = /^\s*bytes\s+(\d+)-\d+\/(\d+|\*)\s*$/i.exec(value ?? '');
  if (!match) return undefined;
  const start = Number(match[1]);
  const total = match[2] === '*' ? undefined : Number(match[2]);
  return total === undefined ? { start } : { start, total };
}

function parseLength(value: string | undefined): number | undefined {
  if (value === undefined || !/^\s*\d+\s*$/.test(value)) return undefined;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : undefined;
}

/**
 * Full resource size. A `206` carries the range length in `Content-Length`, so the total comes
 * from `Content-Range` there.
 */
export function resourceSize(response: ResponseInfo): number | undefined {
  if (response.status === 206) return parseContentRange(response.headers['content-range'])?.total;
  return parseLength(response.headers['content-length']);
}

export function supportsRanges(response: ResponseInfo): boolean {
  return (
    response.status === 206 || response.headers['accept-ranges']?.trim().toLowerCase() === 'bytes'
  );
}

/** True for a `206` that does not start at byte 0: the player is seeking, not starting the file. */
export function isContinuationRange(response: ResponseInfo): boolean {
  if (response.status !== 206) return false;
  const range = parseContentRange(response.headers['content-range']);
  return range !== undefined && range.start > 0;
}

const hlsClassifier: Classifier = (response) => {
  const mime = essence(response.headers['content-type']);
  if (isHlsType(mime) || pathExtension(response.url) === 'm3u8') {
    return { kind: 'hls', ...(mime && { mime }), resumable: false };
  }
  return undefined;
};

const dashClassifier: Classifier = (response) => {
  const mime = essence(response.headers['content-type']);
  if (isDashType(mime) || pathExtension(response.url) === 'mpd') {
    return { kind: 'dash', ...(mime && { mime }), resumable: false };
  }
  return undefined;
};

const directClassifier: Classifier = (response, { minDirectSize }) => {
  const contentType = response.headers['content-type'];
  const mime = essence(contentType);
  if (isFragmentType(mime) || isFragmentUrl(response.url)) return undefined;
  if (response.type !== 'media' && !isDirectMediaType(mime)) return undefined;
  if (isContinuationRange(response)) return undefined;
  const size = resourceSize(response);
  // An unknown size cannot be shown to be small, so it is kept.
  if (size !== undefined && size < minDirectSize) return undefined;
  return {
    kind: 'direct',
    ...(mime && { mime }),
    ...(size !== undefined && { size }),
    resumable: supportsRanges(response),
  };
};

/**
 * Classification order is HLS → DASH → direct file (design §3.1). Later issues replace the first
 * two with classifiers that also read the manifest.
 */
export const defaultClassifiers: readonly Classifier[] = [
  hlsClassifier,
  dashClassifier,
  directClassifier,
];

export function classify(
  response: ResponseInfo,
  context: ClassifierContext,
  classifiers: readonly Classifier[] = defaultClassifiers,
): Classification | undefined {
  if (response.status < 200 || response.status > 299) return undefined;
  for (const classifier of classifiers) {
    const result = classifier(response, context);
    if (result) return result;
  }
  return undefined;
}
