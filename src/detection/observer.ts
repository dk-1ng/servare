import { classify, type Classifier, type DetectedKind, defaultClassifiers } from './classify';
import type { HeaderCache } from './header-cache';

export const DEFAULT_MIN_DIRECT_SIZE = 1024 * 1024;

/** A response worth offering, before the per-tab list (issue #10) turns it into a `MediaItem`. */
export interface DetectedMedia {
  tabId: number;
  frameId: number;
  url: string;
  kind: DetectedKind;
  mime?: string;
  size?: number;
  resumable: boolean;
  detectedAt: number;
}

interface HeaderPair {
  name: string;
  value?: string | undefined;
}

/** The fields of a `webRequest` event this module reads; both browsers provide them. */
interface RequestDetails {
  tabId: number;
  frameId: number;
  url: string;
  type: string;
  initiator?: string | undefined;
  originUrl?: string | undefined;
  documentUrl?: string | undefined;
  cookieStoreId?: string | undefined;
  incognito?: boolean | undefined;
}

export interface SendHeadersDetails extends RequestDetails {
  requestHeaders?: HeaderPair[] | undefined;
}

export interface ResponseStartedDetails extends RequestDetails {
  statusCode: number;
  responseHeaders?: HeaderPair[] | undefined;
}

export interface ObserverOptions {
  /** `runtime.getURL('/')` without the trailing slash: the extension's own origin. */
  ownOrigin: string;
  headerCache: HeaderCache;
  onDetect: (media: DetectedMedia) => void;
  /** Per-domain rules (issue #14) plug in here. */
  isDetectionEnabled?: (hostname: string) => boolean;
  minDirectSize?: (hostname: string) => number;
  classifiers?: readonly Classifier[];
  now?: () => number;
}

const HTTP = /^https?:$/;

function parse(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

/**
 * Own requests carry the host tab's ID on Firefox, so they are recognized by their initiator,
 * not by `tabId` (design §3.1, §4.1.1).
 */
export function isOwnRequest(details: RequestDetails, ownOrigin: string): boolean {
  return [details.initiator, details.originUrl, details.documentUrl].some(
    (value) => value !== undefined && (value === ownOrigin || value.startsWith(`${ownOrigin}/`)),
  );
}

function lowerHeaders(list: HeaderPair[] | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const { name, value } of list ?? []) {
    if (value !== undefined) result[name.toLowerCase()] = value;
  }
  return result;
}

export function createObserver(options: ObserverOptions) {
  const now = options.now ?? Date.now;
  const classifiers = options.classifiers ?? defaultClassifiers;

  return {
    /** `webRequest.onSendHeaders`: remember what the player sent. */
    onSendHeaders(details: SendHeadersDetails): void {
      if (details.tabId < 0 || isOwnRequest(details, options.ownOrigin)) return;
      const url = parse(details.url);
      if (!url || !HTTP.test(url.protocol)) return;
      const sent = lowerHeaders(details.requestHeaders);
      options.headerCache.record({
        tabId: details.tabId,
        origin: url.origin,
        headers: {
          ...(sent['referer'] !== undefined && { referer: sent['referer'] }),
          ...(sent['origin'] !== undefined && { origin: sent['origin'] }),
          ...(sent['cookie'] !== undefined && { cookie: sent['cookie'] }),
        },
        ...(details.cookieStoreId !== undefined && { cookieStoreId: details.cookieStoreId }),
        ...(details.incognito !== undefined && { incognito: details.incognito }),
      });
    },

    /** `webRequest.onResponseStarted`: decide whether the response is media. */
    onResponseStarted(details: ResponseStartedDetails): void {
      if (details.tabId < 0 || isOwnRequest(details, options.ownOrigin)) return;
      const url = parse(details.url);
      if (!url || !HTTP.test(url.protocol)) return;
      if (options.isDetectionEnabled && !options.isDetectionEnabled(url.hostname)) return;
      const result = classify(
        {
          url: details.url,
          type: details.type,
          status: details.statusCode,
          headers: lowerHeaders(details.responseHeaders),
        },
        { minDirectSize: options.minDirectSize?.(url.hostname) ?? DEFAULT_MIN_DIRECT_SIZE },
        classifiers,
      );
      if (!result) return;
      options.onDetect({
        tabId: details.tabId,
        frameId: details.frameId,
        url: details.url,
        ...result,
        detectedAt: now(),
      });
    },
  };
}

export type Observer = ReturnType<typeof createObserver>;
