import type { z } from 'zod';

/** The subset of `storage.local` / `storage.session` the store needs. */
export interface StorageAreaLike {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Transforms the payload written by version `n` into the payload of version `n + 1`. */
export type Migration = (data: unknown) => unknown;

export interface StoreOptions<S extends z.ZodType> {
  area: StorageAreaLike;
  key: string;
  schema: S;
  /** Current schema version, starting at 1. */
  version: number;
  /** `migrations[n]` upgrades version `n` to `n + 1`; it must define one for every version below `version`. */
  migrations?: Record<number, Migration>;
  /** Used when nothing is stored or the stored value cannot be read. */
  defaults: () => z.infer<S>;
}

interface Envelope {
  v: number;
  data: unknown;
}

function isEnvelope(value: unknown): value is Envelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    Number.isInteger((value as Envelope).v) &&
    (value as Envelope).v >= 1 &&
    'data' in value
  );
}

/**
 * Runs the migrations from `from` up to `to`. Returns `undefined` when the
 * chain is incomplete, a migration throws, or `from` is newer than `to`
 * (written by a newer build: never guess its shape).
 */
export function migrate(
  data: unknown,
  from: number,
  to: number,
  migrations: Record<number, Migration>,
): unknown {
  if (from > to) return undefined;
  let current = data;
  for (let v = from; v < to; v++) {
    const step = migrations[v];
    if (!step) return undefined;
    try {
      current = step(current);
    } catch {
      return undefined;
    }
  }
  return current;
}

export interface Store<T> {
  /** Reads, migrates and validates. Never throws: unreadable data yields the defaults. */
  get(): Promise<T>;
  set(value: T): Promise<void>;
  /** Read-modify-write, serialized with other writes from this context. */
  update(fn: (current: T) => T): Promise<T>;
  clear(): Promise<void>;
}

/**
 * Versioned, validated persistence over a `storage` area. The background can be
 * suspended at any time, so nothing here keeps state in memory between calls
 * (docs/design.md §2.3).
 */
export function createStore<S extends z.ZodType>(options: StoreOptions<S>): Store<z.infer<S>> {
  type T = z.infer<S>;
  const { area, key, schema, version, migrations = {}, defaults } = options;
  let queue: Promise<unknown> = Promise.resolve();

  const serialize = <R>(task: () => Promise<R>): Promise<R> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  async function read(): Promise<T> {
    const raw = (await area.get(key))[key];
    if (!isEnvelope(raw)) return defaults();
    const migrated = migrate(raw.data, raw.v, version, migrations);
    if (migrated === undefined) return defaults();
    const parsed = schema.safeParse(migrated);
    return parsed.success ? parsed.data : defaults();
  }

  async function write(value: T): Promise<void> {
    const data = schema.parse(value);
    await area.set({ [key]: { v: version, data } satisfies Envelope });
  }

  return {
    get: () => read(),
    set: (value) => serialize(() => write(value)),
    update: (fn) =>
      serialize(async () => {
        const next = fn(await read());
        await write(next);
        return next;
      }),
    clear: () => serialize(() => area.remove(key)),
  };
}
