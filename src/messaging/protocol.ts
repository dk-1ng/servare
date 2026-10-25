import { z } from 'zod';
import { DownloadErrorSchema, DownloadJobSchema, MediaItemSchema, TrackSchema } from './schemas';

/**
 * Every request the background answers, with its payload and response schema.
 * Detailed semantics live in docs/ui-contract.md.
 */
export const requestSchemas = {
  'media/list': {
    request: z.object({ tabId: z.number().int() }),
    response: z.array(MediaItemSchema),
  },
  'download/enqueue': {
    request: z.object({
      mediaId: z.string(),
      variantId: z.string().optional(),
      audioTrackIds: z.array(z.string()).default([]),
      subtitleIds: z.array(z.string()).default([]),
      mode: z.enum(['video', 'audio']).default('video'),
      outputName: z.string().max(255).optional(),
    }),
    response: DownloadJobSchema,
  },
  'download/cancel': {
    request: z.object({ jobId: z.string() }),
    response: z.null(),
  },
  'download/pause': {
    request: z.object({ jobId: z.string() }),
    response: z.null(),
  },
  'download/resume': {
    request: z.object({ jobId: z.string() }),
    response: z.null(),
  },
  'download/list': {
    request: z.object({}),
    response: z.array(DownloadJobSchema),
  },
  /** Worker host → background: a finished file is ready in a blob URL (design §4.9). */
  'delivery/deliver': {
    request: z.object({
      jobId: z.string(),
      blobUrl: z.string().startsWith('blob:'),
      filename: z.string().min(1).max(255),
      saveAs: z.boolean().default(false),
    }),
    response: z.object({ downloadId: z.number().int() }),
  },
  /** Background → worker host: the download ended, so the blob URL and OPFS file can go. */
  'delivery/release': {
    request: z.object({ jobId: z.string(), outcome: z.enum(['complete', 'interrupted']) }),
    response: z.null(),
  },
  /** Background → worker host (over `runtime.sendMessage`): run a job in the download worker. */
  'worker/start': {
    request: z.object({
      jobId: z.string(),
      url: z.url().max(8192),
      filename: z.string().min(1).max(255),
    }),
    response: z.null(),
  },
  /** Worker host → background: the job failed before or during delivery. */
  'worker/failed': {
    request: z.object({ jobId: z.string(), error: DownloadErrorSchema }),
    response: z.null(),
  },
  /** Background → worker host (over `runtime.sendMessage`): stop a job and delete its file. */
  'worker/cancel': {
    request: z.object({ jobId: z.string() }),
    response: z.null(),
  },
  /** Worker host → background: bytes written so far (throttled by the worker). */
  'worker/progress': {
    request: z.object({
      jobId: z.string(),
      bytesWritten: z.number().nonnegative(),
      total: z.number().positive().optional(),
    }),
    response: z.null(),
  },
  /**
   * TEMPORARY entry point for development and E2E (until #11/#25 provide real enqueueing):
   * saves a single http(s) URL as a direct file. Only extension pages can reach it.
   */
  'download/start-direct': {
    request: z.object({
      url: z.url({ protocol: /^https?$/ }).max(8192),
      filename: z.string().min(1).max(255),
      /** Tab whose player headers (Referer, Origin, Cookie) the download replays (§4.1.1). */
      tabId: z.number().int().optional(),
    }),
    response: z.object({ jobId: z.string() }),
  },
} as const;

/** Events pushed from the background to every connected port. */
export const eventSchemas = {
  'media/updated': z.object({ tabId: z.number().int(), items: z.array(MediaItemSchema) }),
  'job/updated': z.object({ job: DownloadJobSchema }),
  'tracks/updated': z.object({ mediaId: z.string(), audioTracks: z.array(TrackSchema) }),
} as const;

export type RequestName = keyof typeof requestSchemas;
export type EventName = keyof typeof eventSchemas;
/** Payload as the caller writes it (defaults not yet applied). */
export type RequestInput<N extends RequestName> = z.input<(typeof requestSchemas)[N]['request']>;
/** Payload as the handler receives it (defaults applied). */
export type RequestPayload<N extends RequestName> = z.output<(typeof requestSchemas)[N]['request']>;
export type ResponsePayload<N extends RequestName> = z.output<
  (typeof requestSchemas)[N]['response']
>;
export type EventPayload<N extends EventName> = z.output<(typeof eventSchemas)[N]>;

export const ErrorCodeSchema = z.enum([
  'invalid-message',
  'unknown-request',
  'invalid-payload',
  'invalid-response',
  'handler-failed',
  'disconnected',
  'timeout',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/** Typed failure for every messaging problem, on either side of the wire. */
export class MessagingError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'MessagingError';
    this.code = code;
  }
}

/** Wire envelopes. Payloads are validated separately, per request or event name. */
export const RequestEnvelopeSchema = z.object({
  kind: z.literal('request'),
  id: z.string(),
  name: z.string(),
  payload: z.unknown(),
});
export const ResponseEnvelopeSchema = z.discriminatedUnion('ok', [
  z.object({
    kind: z.literal('response'),
    id: z.string(),
    ok: z.literal(true),
    payload: z.unknown(),
  }),
  z.object({
    kind: z.literal('response'),
    id: z.string(),
    ok: z.literal(false),
    error: z.object({ code: ErrorCodeSchema, message: z.string() }),
  }),
]);
export const EventEnvelopeSchema = z.object({
  kind: z.literal('event'),
  name: z.string(),
  payload: z.unknown(),
});

export const WireMessageSchema = z.union([
  RequestEnvelopeSchema,
  ResponseEnvelopeSchema,
  EventEnvelopeSchema,
]);
export type RequestEnvelope = z.infer<typeof RequestEnvelopeSchema>;
export type ResponseEnvelope = z.infer<typeof ResponseEnvelopeSchema>;
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;
export type WireMessage = z.infer<typeof WireMessageSchema>;

export function parseWireMessage(raw: unknown): WireMessage {
  const result = WireMessageSchema.safeParse(raw);
  if (!result.success) {
    throw new MessagingError('invalid-message', result.error.message);
  }
  return result.data;
}

export function isRequestName(name: string): name is RequestName {
  return Object.hasOwn(requestSchemas, name);
}

export function isEventName(name: string): name is EventName {
  return Object.hasOwn(eventSchemas, name);
}
