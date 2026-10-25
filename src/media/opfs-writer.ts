/** Structural subsets of the OPFS types so the writer can be tested without a browser. */
export interface SyncAccessHandleLike {
  write(data: ArrayBufferView, options?: { at?: number }): number;
  getSize(): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}

export interface FileHandleLike {
  createSyncAccessHandle(): Promise<SyncAccessHandleLike>;
  getFile(): Promise<File>;
}

export interface DirectoryLike {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirectoryLike>;
  removeEntry(name: string): Promise<void>;
  entries(): AsyncIterable<[string, unknown]>;
}

export const OPFS_DIR = 'servare-tmp';

/** Job ids become file names: keep them from escaping the temp directory. */
function fileNameFor(jobId: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(jobId) || jobId === '.' || jobId === '..') {
    throw new Error(`Invalid job id for a temporary file: ${jobId}`);
  }
  return `${jobId}.part`;
}

async function opfsRoot(): Promise<DirectoryLike> {
  return (await navigator.storage.getDirectory()) as unknown as DirectoryLike;
}

async function tempDir(root: DirectoryLike): Promise<DirectoryLike> {
  return root.getDirectoryHandle(OPFS_DIR, { create: true });
}

/**
 * Positional writer over an OPFS file. The file is never held in memory, so multi-GB
 * outputs are fine. `createSyncAccessHandle` only exists in workers (design §4.9).
 */
export class OpfsWriter {
  private constructor(
    private readonly dir: DirectoryLike,
    private readonly name: string,
    private readonly file: FileHandleLike,
    private handle: SyncAccessHandleLike | null,
  ) {}

  static async open(jobId: string, root?: DirectoryLike): Promise<OpfsWriter> {
    const name = fileNameFor(jobId);
    const dir = await tempDir(root ?? (await opfsRoot()));
    const file = await dir.getFileHandle(name, { create: true });
    return new OpfsWriter(dir, name, file, await file.createSyncAccessHandle());
  }

  private active(): SyncAccessHandleLike {
    if (!this.handle) throw new Error('OPFS writer is closed');
    return this.handle;
  }

  /** Writes all of `data` at `position`; a short write is an error, not something to retry. */
  writeAt(position: number, data: Uint8Array): void {
    const written = this.active().write(data, { at: position });
    if (written !== data.byteLength) {
      throw new Error(`Short OPFS write: ${String(written)} of ${String(data.byteLength)} bytes`);
    }
  }

  get size(): number {
    return this.active().getSize();
  }

  truncate(size: number): void {
    this.active().truncate(size);
  }

  flush(): void {
    this.active().flush();
  }

  /** Releases the exclusive handle; required before `getFile` can be read by other contexts. */
  close(): void {
    if (!this.handle) return;
    this.handle.flush();
    this.handle.close();
    this.handle = null;
  }

  /** Closes the handle and returns the finished file. */
  async finish(): Promise<File> {
    this.close();
    return this.file.getFile();
  }

  /** Closes the handle and deletes the temporary file. Safe to call twice. */
  async remove(): Promise<void> {
    this.close();
    await removeTempFile(this.name, this.dir);
  }
}

async function removeTempFile(name: string, dir: DirectoryLike): Promise<void> {
  try {
    await dir.removeEntry(name);
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'NotFoundError') throw error;
  }
}

/** Removes the temporary file of a job from any context (e.g. the worker host after delivery). */
export async function removeJobFile(jobId: string, root?: DirectoryLike): Promise<void> {
  const dir = await tempDir(root ?? (await opfsRoot()));
  await removeTempFile(fileNameFor(jobId), dir);
}

/**
 * Deletes temp files whose job is no longer known (crash leftovers). A file that cannot be
 * removed (e.g. still held by an open handle) does not stop the rest. Returns what went and
 * what stayed.
 */
export async function cleanupOrphans(
  keepJobIds: ReadonlySet<string>,
  root?: DirectoryLike,
): Promise<{ removed: number; failed: string[] }> {
  const dir = await tempDir(root ?? (await opfsRoot()));
  const stale: string[] = [];
  for await (const [name] of dir.entries()) {
    if (!name.endsWith('.part') || !keepJobIds.has(name.slice(0, -'.part'.length))) {
      stale.push(name);
    }
  }
  let removed = 0;
  const failed: string[] = [];
  for (const name of stale) {
    try {
      await removeTempFile(name, dir);
      removed++;
    } catch {
      failed.push(name);
    }
  }
  return { removed, failed };
}
