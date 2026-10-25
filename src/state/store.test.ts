import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type StorageAreaLike, createStore, migrate } from './store';

function memoryArea(): StorageAreaLike & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    get: (key) =>
      Promise.resolve(
        key in data ? { [key]: JSON.parse(JSON.stringify(data[key])) as unknown } : {},
      ),
    set: (items) => {
      Object.assign(data, JSON.parse(JSON.stringify(items)) as Record<string, unknown>);
      return Promise.resolve();
    },
    remove: (key) => {
      Reflect.deleteProperty(data, key);
      return Promise.resolve();
    },
  };
}

type V1 = { names: string[] };
const V2 = z.object({ items: z.array(z.object({ name: z.string(), pinned: z.boolean() })) });

const migrationsToV2 = {
  1: (data: unknown) => ({
    items: (data as V1).names.map((name) => ({ name, pinned: false })),
  }),
};

const optionsV2 = (area: StorageAreaLike) => ({
  area,
  key: 'list',
  schema: V2,
  version: 2,
  migrations: migrationsToV2,
  defaults: () => ({ items: [] }),
});

describe('createStore', () => {
  it('returns the defaults when nothing is stored', async () => {
    const store = createStore(optionsV2(memoryArea()));
    expect(await store.get()).toEqual({ items: [] });
  });

  it('survives a restart: a new store over the same area reads the saved value', async () => {
    const area = memoryArea();
    await createStore(optionsV2(area)).set({ items: [{ name: 'a', pinned: true }] });
    const afterRestart = createStore(optionsV2(area));
    expect(await afterRestart.get()).toEqual({ items: [{ name: 'a', pinned: true }] });
  });

  it('migrates v1 data to v2 on read', async () => {
    const area = memoryArea();
    area.data['list'] = { v: 1, data: { names: ['a', 'b'] } };
    const store = createStore(optionsV2(area));
    expect(await store.get()).toEqual({
      items: [
        { name: 'a', pinned: false },
        { name: 'b', pinned: false },
      ],
    });
  });

  it('writes the migrated value back with the current version on the next write', async () => {
    const area = memoryArea();
    area.data['list'] = { v: 1, data: { names: ['a'] } };
    const store = createStore(optionsV2(area));
    await store.update((current) => current);
    expect(area.data['list']).toEqual({ v: 2, data: { items: [{ name: 'a', pinned: false }] } });
  });

  it('falls back to the defaults when stored data fails validation', async () => {
    const area = memoryArea();
    area.data['list'] = { v: 2, data: { items: [{ name: 1 }] } };
    expect(await createStore(optionsV2(area)).get()).toEqual({ items: [] });
  });

  it('falls back to the defaults when the value is not an envelope', async () => {
    const area = memoryArea();
    area.data['list'] = 'garbage';
    expect(await createStore(optionsV2(area)).get()).toEqual({ items: [] });
  });

  it('does not guess the shape of data written by a newer version', async () => {
    const area = memoryArea();
    area.data['list'] = { v: 3, data: { items: [{ name: 'a', pinned: true }] } };
    expect(await createStore(optionsV2(area)).get()).toEqual({ items: [] });
  });

  it('falls back to the defaults when a migration is missing or throws', async () => {
    const missing = memoryArea();
    missing.data['list'] = { v: 1, data: { names: [] } };
    expect(await createStore({ ...optionsV2(missing), migrations: {} }).get()).toEqual({
      items: [],
    });

    const throwing = memoryArea();
    throwing.data['list'] = { v: 1, data: { names: [] } };
    const store = createStore({
      ...optionsV2(throwing),
      migrations: {
        1: () => {
          throw new Error('boom');
        },
      },
    });
    expect(await store.get()).toEqual({ items: [] });
  });

  it('keeps a copy of unreadable data before overwriting it', async () => {
    const area = memoryArea();
    const newer = { v: 3, data: { items: [{ name: 'a', pinned: true }] } };
    area.data['list'] = newer;
    await createStore(optionsV2(area)).update((cur) => cur);
    expect(area.data['list:unreadable']).toEqual(newer);
    expect(area.data['list']).toEqual({ v: 2, data: { items: [] } });
  });

  it('returns the defaults when the storage area rejects', async () => {
    const area = memoryArea();
    area.get = () => Promise.reject(new Error('backend down'));
    expect(await createStore(optionsV2(area)).get()).toEqual({ items: [] });
  });

  it('rejects writes that do not match the schema', async () => {
    const store = createStore(optionsV2(memoryArea()));
    await expect(store.set({ items: [{ name: 'a' }] } as never)).rejects.toThrow();
  });

  it('serializes concurrent updates so none is lost', async () => {
    const store = createStore(optionsV2(memoryArea()));
    await Promise.all(
      ['a', 'b', 'c'].map((name) =>
        store.update((cur) => ({ items: [...cur.items, { name, pinned: false }] })),
      ),
    );
    expect((await store.get()).items.map((i) => i.name)).toEqual(['a', 'b', 'c']);
  });

  it('keeps the queue usable after a failed update', async () => {
    const store = createStore(optionsV2(memoryArea()));
    await expect(
      store.update(() => {
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');
    await store.set({ items: [] });
    expect(await store.get()).toEqual({ items: [] });
  });

  it('clear removes the stored value', async () => {
    const area = memoryArea();
    const store = createStore(optionsV2(area));
    await store.set({ items: [] });
    await store.clear();
    expect(area.data['list']).toBeUndefined();
  });
});

describe('migrate', () => {
  it('chains migrations in order', () => {
    const result = migrate(1, 1, 3, { 1: (n) => (n as number) + 1, 2: (n) => (n as number) * 10 });
    expect(result).toBe(20);
  });

  it('returns the data untouched when already current', () => {
    expect(migrate('x', 2, 2, {})).toBe('x');
  });
});
