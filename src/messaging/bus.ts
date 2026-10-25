import {
  type EventName,
  type EventPayload,
  type RequestInput,
  type RequestName,
  type RequestPayload,
  type ResponseEnvelope,
  type ResponsePayload,
  MessagingError,
  eventSchemas,
  isEventName,
  isRequestName,
  parseWireMessage,
  requestSchemas,
} from './protocol';

/** The subset of `runtime.Port` the bus uses, so tests can fake it. */
export interface PortLike {
  /** Present on ports received through `runtime.onConnect`. */
  sender?: { url?: string };
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

export type Handlers = {
  [N in RequestName]: (
    payload: RequestPayload<N>,
  ) => ResponsePayload<N> | Promise<ResponsePayload<N>>;
};

function errorResponse(
  id: string,
  code: MessagingError['code'],
  message: string,
): ResponseEnvelope {
  return { kind: 'response', id, ok: false, error: { code, message } };
}

/**
 * Validates a raw message and runs the matching handler. Never throws: every
 * failure becomes an error response, so a malformed sender cannot crash the
 * background. Returns `undefined` for anything that is not a request.
 */
export async function handleRequest(
  raw: unknown,
  handlers: Partial<Handlers>,
): Promise<ResponseEnvelope | undefined> {
  let message;
  try {
    message = parseWireMessage(raw);
  } catch (error) {
    // Without a valid envelope there is no id to answer; salvage one if present.
    const id =
      typeof raw === 'object' && raw !== null && 'id' in raw && typeof raw.id === 'string'
        ? raw.id
        : undefined;
    const isRequest =
      typeof raw === 'object' && raw !== null && 'kind' in raw && raw.kind === 'request';
    return id !== undefined && isRequest
      ? errorResponse(id, 'invalid-message', String(error))
      : undefined;
  }
  if (message.kind !== 'request') return undefined;

  const { id, name } = message;
  if (!isRequestName(name)) return errorResponse(id, 'unknown-request', `Unknown request: ${name}`);
  const handler = handlers[name] as ((payload: unknown) => unknown) | undefined;
  if (!handler) return errorResponse(id, 'unknown-request', `No handler for: ${name}`);

  const parsed = requestSchemas[name].request.safeParse(message.payload);
  if (!parsed.success) return errorResponse(id, 'invalid-payload', parsed.error.message);

  let result: unknown;
  try {
    result = await handler(parsed.data);
  } catch (error) {
    return errorResponse(
      id,
      'handler-failed',
      error instanceof Error ? error.message : String(error),
    );
  }
  const checked = requestSchemas[name].response.safeParse(result);
  if (!checked.success) return errorResponse(id, 'invalid-response', checked.error.message);
  return { kind: 'response', id, ok: true, payload: checked.data };
}

/** Runs a listener so that one throwing subscriber cannot break the others or the bus. */
function safely(fn: () => void): void {
  try {
    fn();
  } catch (error) {
    console.error('[servare] messaging listener failed', error);
  }
}

/** Background side: answers requests from connected ports and pushes events to all of them. */
export class PortServer {
  private readonly ports = new Set<PortLike>();

  /**
   * @param extensionOrigin e.g. `runtime.getURL('/')`. `runtime.onConnect` also
   *   fires for content scripts, which run inside untrusted pages and must not
   *   issue requests or see other tabs' media, so only extension pages are served.
   */
  constructor(
    private readonly handlers: Partial<Handlers>,
    private readonly extensionOrigin: string,
  ) {}

  /**
   * Call from `runtime.onConnect`. Ports vanish on disconnect; clients reconnect
   * on demand. Returns false (and disconnects) for ports from other senders.
   */
  accept(port: PortLike): boolean {
    if (!port.sender?.url?.startsWith(this.extensionOrigin)) {
      port.disconnect();
      return false;
    }
    this.ports.add(port);
    port.onDisconnect.addListener(() => {
      this.ports.delete(port);
    });
    port.onMessage.addListener((raw) => {
      handleRequest(raw, this.handlers)
        .then((response) => {
          if (response) this.send(port, response);
        })
        .catch(() => {
          this.ports.delete(port);
        });
    });
    return true;
  }

  emit<N extends EventName>(name: N, payload: EventPayload<N>): void {
    const checked = eventSchemas[name].safeParse(payload);
    if (!checked.success) throw new MessagingError('invalid-payload', checked.error.message);
    for (const port of [...this.ports]) {
      this.send(port, { kind: 'event', name, payload: checked.data });
    }
  }

  /** A port can die before its `onDisconnect` is delivered; one dead port must not affect the rest. */
  private send(port: PortLike, message: unknown): void {
    if (!this.ports.has(port)) return;
    try {
      port.postMessage(message);
    } catch {
      this.ports.delete(port);
    }
  }

  get connectionCount(): number {
    return this.ports.size;
  }
}

export interface PortClientOptions {
  /** First reconnect delay in ms; doubles after each failed attempt. */
  reconnectDelay?: number;
  maxReconnectDelay?: number;
  /** Rejects a request with `timeout` when no answer arrives in this many ms. Off by default. */
  requestTimeout?: number;
}

type Pending = {
  name: RequestName;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
};

/**
 * UI / worker side. Connects lazily. The background may suspend at any time
 * (docs/design.md §2.3), so a disconnect is normal: pending requests fail with
 * `disconnected`, the next request reconnects, and while event listeners exist
 * the client reconnects by itself with exponential backoff.
 */
export class PortClient {
  private port: PortLike | undefined;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Map<EventName, Set<(payload: never) => void>>();
  private readonly reconnectListeners = new Set<() => void>();
  private nextId = 0;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private hasConnected = false;

  constructor(
    private readonly connect: () => PortLike,
    private readonly options: PortClientOptions = {},
  ) {}

  async request<N extends RequestName>(
    name: N,
    payload: RequestInput<N>,
  ): Promise<ResponsePayload<N>> {
    const parsed = requestSchemas[name].request.safeParse(payload);
    if (!parsed.success) throw new MessagingError('invalid-payload', parsed.error.message);

    const port = this.ensurePort();
    const id = String(++this.nextId);
    return new Promise<ResponsePayload<N>>((resolve, reject) => {
      const entry: Pending = { name, resolve: resolve as (v: unknown) => void, reject };
      const timeout = this.options.requestTimeout;
      if (timeout !== undefined) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new MessagingError('timeout', `No answer to ${name} after ${String(timeout)} ms`));
        }, timeout);
      }
      this.pending.set(id, entry);
      try {
        port.postMessage({ kind: 'request', id, name, payload: parsed.data });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(entry.timer);
        reject(new MessagingError('disconnected', String(error)));
      }
    });
  }

  on<N extends EventName>(name: N, listener: (payload: EventPayload<N>) => void): () => void {
    let set = this.listeners.get(name);
    if (!set) this.listeners.set(name, (set = new Set()));
    set.add(listener);
    if (!this.closed) this.ensurePort();
    return () => set.delete(listener);
  }

  /** Fires after a reconnect so the UI can refetch state it may have missed. */
  onReconnect(listener: () => void): () => void {
    this.reconnectListeners.add(listener);
    return () => this.reconnectListeners.delete(listener);
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    const port = this.port;
    this.port = undefined;
    port?.disconnect();
    this.failPending(new MessagingError('disconnected', 'Client closed'));
  }

  private ensurePort(): PortLike {
    if (this.closed) throw new MessagingError('disconnected', 'Client closed');
    if (this.port) return this.port;
    clearTimeout(this.timer);
    const port = this.connect();
    this.port = port;
    const reconnected = this.hasConnected;
    this.hasConnected = true;
    port.onMessage.addListener((raw) => {
      this.receive(raw);
    });
    port.onDisconnect.addListener(() => {
      this.lost(port);
    });
    if (reconnected) for (const listener of [...this.reconnectListeners]) safely(listener);
    return port;
  }

  private receive(raw: unknown): void {
    this.attempt = 0;
    let message;
    try {
      message = parseWireMessage(raw);
    } catch {
      return; // not ours; ignore rather than crash the page
    }
    if (message.kind === 'response') {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (!message.ok) {
        entry.reject(new MessagingError(message.error.code, message.error.message));
        return;
      }
      const checked = requestSchemas[entry.name].response.safeParse(message.payload);
      if (checked.success) entry.resolve(checked.data);
      else entry.reject(new MessagingError('invalid-response', checked.error.message));
    } else if (message.kind === 'event' && isEventName(message.name)) {
      const checked = eventSchemas[message.name].safeParse(message.payload);
      if (!checked.success) return;
      for (const listener of [...(this.listeners.get(message.name) ?? [])]) {
        safely(() => {
          (listener as (payload: unknown) => void)(checked.data);
        });
      }
    }
  }

  private lost(port: PortLike): void {
    if (this.port !== port) return;
    this.port = undefined;
    this.failPending(new MessagingError('disconnected', 'Background disconnected'));
    if (this.closed || ![...this.listeners.values()].some((set) => set.size > 0)) return;
    const base = this.options.reconnectDelay ?? 250;
    const max = this.options.maxReconnectDelay ?? 10_000;
    const delay = Math.min(base * 2 ** this.attempt++, max);
    this.scheduleReconnect(delay);
  }

  private scheduleReconnect(delay: number): void {
    this.timer = setTimeout(() => {
      try {
        this.ensurePort();
      } catch {
        // connect() itself failed: keep backing off until close().
        if (!this.closed) {
          const max = this.options.maxReconnectDelay ?? 10_000;
          this.scheduleReconnect(Math.min(delay * 2, max));
        }
      }
    }, delay);
  }

  private failPending(error: MessagingError): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }
}
