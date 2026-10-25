import { describe, expect, it } from 'vitest';
import { QuotaError, ensureFreeSpace } from './storage';
import {
  OPFS_DIR,
  OpfsWriter,
  cleanupOrphans,
  removeJobFile,
  type DirectoryLike,
  type SyncAccessHandleLike,
} from './opfs-writer';

class FakeFs {
  files = new Map<string, Uint8Array>();
  dir: DirectoryLike = {
    getFileHandle: async (name) => {
      if (!this.files.has(name)) this.files.set(name, new Uint8Array(0));
      return {
        createSyncAccessHandle: async () => this.handleFor(name),
        getFile: async () => new File([this.files.get(name)!.slice()], name),
      };
    },
    getDirectoryHandle: async () => this.dir,
    removeEntry: async (name) => {
      if (!this.files.delete(name)) throw Object.assign(new Error('x'), { name: 'NotFoundError' });
    },
    async *entries() {},
  };
  root: DirectoryLike = {
    ...this.dir,
    getDirectoryHandle: async (n) => {
      expect(n).toBe(OPFS_DIR);
      return { ...this.dir, entries: () => this.list() };
    },
  };
  private async *list(): AsyncGenerator<[string, unknown]> {
    for (const k of this.files.keys()) yield [k, {}];
  }
  private handleFor(name: string): SyncAccessHandleLike {
    return {
      write: (data, opts) => {
        const at = opts?.at ?? 0;
        const cur = this.files.get(name)!;
        const next = new Uint8Array(Math.max(cur.length, at + data.byteLength));
        next.set(cur);
        next.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), at);
        this.files.set(name, next);
        return data.byteLength;
      },
      getSize: () => this.files.get(name)!.length,
      truncate: (s) => this.files.set(name, this.files.get(name)!.slice(0, s)),
      flush: () => {},
      close: () => {},
    };
  }
}

describe('OpfsWriter', () => {
  it('writes at positions, returns the file and removes it', async () => {
    const fs = new FakeFs();
    const w = await OpfsWriter.open('job1', fs.root);
    w.writeAt(3, Uint8Array.of(3, 4));
    w.writeAt(0, Uint8Array.of(0, 1, 2));
    expect(w.size).toBe(5);
    const file = await w.finish();
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(Uint8Array.of(0, 1, 2, 3, 4));
    await w.remove();
    await w.remove();
    expect(fs.files.size).toBe(0);
  });

  it('rejects use after close and unsafe job ids', async () => {
    const fs = new FakeFs();
    const w = await OpfsWriter.open('job1', fs.root);
    w.close();
    expect(() => w.writeAt(0, Uint8Array.of(1))).toThrow('closed');
    await expect(OpfsWriter.open('../evil', fs.root)).rejects.toThrow('Invalid job id');
  });

  it('removes files by job id and cleans up orphans', async () => {
    const fs = new FakeFs();
    await OpfsWriter.open('a', fs.root);
    await OpfsWriter.open('b', fs.root);
    await OpfsWriter.open('c', fs.root);
    await removeJobFile('a', fs.root);
    expect(await cleanupOrphans(new Set(['b']), fs.root)).toBe(1);
    expect([...fs.files.keys()]).toEqual(['b.part']);
  });
});

describe('ensureFreeSpace', () => {
  const est = (usage: number, quota?: number) => ({
    estimate: async () => ({ usage, ...(quota !== undefined && { quota }) }),
  });
  it('passes when the file fits or quota is unknown', async () => {
    await ensureFreeSpace(100, est(0, 100));
    await ensureFreeSpace(1e12, est(0));
  });
  it('throws QuotaError when it does not fit', async () => {
    await expect(ensureFreeSpace(101, est(0, 100))).rejects.toBeInstanceOf(QuotaError);
    await expect(ensureFreeSpace(60, est(50, 100))).rejects.toMatchObject({ available: 50 });
  });
});
