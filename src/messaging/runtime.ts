import { z } from 'zod';
import { type Handlers, handleRequest } from './bus';
import {
  type RequestInput,
  type RequestName,
  type ResponsePayload,
  MessagingError,
  ResponseEnvelopeSchema,
  isRequestName,
  requestSchemas,
} from './protocol';

/**
 * Request/response over `runtime.sendMessage`, for the one direction ports cannot cover:
 * background → worker host. A port dies when the background suspends (design §2.3), while
 * `sendMessage` reaches the host whenever it is open.
 */

/** The subset of `browser.runtime` the sender needs. */
export interface RuntimeSenderLike {
  sendMessage(message: unknown): Promise<unknown>;
}

export interface RuntimeRequestOptions {
  /** Extra attempts when nobody listens yet (a host page that is still loading). */
  retries?: number;
  /** Delay between attempts in ms. */
  delay?: number;
}

let nextId = 0;

export async function requestOverRuntime<N extends RequestName>(
  runtime: RuntimeSenderLike,
  name: N,
  payload: RequestInput<N>,
  options: RuntimeRequestOptions = {},
): Promise<ResponsePayload<N>> {
  const parsed = requestSchemas[name].request.safeParse(payload);
  if (!parsed.success) throw new MessagingError('invalid-payload', parsed.error.message);
  const message = {
    kind: 'request',
    id: `rt${String(++nextId)}`,
    name,
    payload: parsed.data,
  };
  const retries = options.retries ?? 0;
  const delay = options.delay ?? 200;
  let raw: unknown;
  for (let attempt = 0; ; attempt++) {
    try {
      raw = await runtime.sendMessage(message);
      // No listener answered: `undefined` on some browsers instead of a rejection.
      if (raw === undefined) throw new Error('No receiver');
      break;
    } catch (error) {
      if (attempt >= retries) {
        throw new MessagingError('disconnected', String(error));
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  const envelope = ResponseEnvelopeSchema.safeParse(raw);
  if (!envelope.success) throw new MessagingError('invalid-message', envelope.error.message);
  const response = envelope.data;
  if (!response.ok) throw new MessagingError(response.error.code, response.error.message);
  const checked = requestSchemas[name].response.safeParse(response.payload);
  if (!checked.success) throw new MessagingError('invalid-response', checked.error.message);
  return checked.data as ResponsePayload<N>;
}

const NamedRequestSchema = z.object({ kind: z.literal('request'), name: z.string() });

/**
 * For a `runtime.onMessage` listener. Returns a response promise only for requests this
 * context handles, and `undefined` for everything else, so that other extension pages are
 * not shadowed by an `unknown-request` error from this one.
 */
export function respondToRuntimeMessage(
  raw: unknown,
  handlers: Partial<Handlers>,
): ReturnType<typeof handleRequest> | undefined {
  const named = NamedRequestSchema.safeParse(raw);
  if (!named.success) return undefined;
  const { name } = named.data;
  if (!isRequestName(name) || !handlers[name]) return undefined;
  return handleRequest(raw, handlers);
}
