import { describe, expect, it, vi } from 'vitest';
import { WorkerHost, type WorkerHostApi } from './worker-host';

function fakeApi(overrides: Partial<WorkerHostApi> = {}) {
  let open = false;
  const api: WorkerHostApi = {
    exists: vi.fn(async () => open),
    open: vi.fn(async () => {
      await Promise.resolve();
      open = true;
    }),
    close: vi.fn(async () => {
      open = false;
    }),
    ...overrides,
  };
  return { api, setOpen: (v: boolean) => (open = v) };
}

describe('WorkerHost', () => {
  it('opens once for concurrent ensure calls', async () => {
    const { api } = fakeApi();
    const host = new WorkerHost(api);
    await Promise.all([host.ensure(), host.ensure(), host.ensure()]);
    expect(api.open).toHaveBeenCalledTimes(1);
  });

  it('does not open when a host already exists', async () => {
    const { api, setOpen } = fakeApi();
    setOpen(true);
    await new WorkerHost(api).ensure();
    expect(api.open).not.toHaveBeenCalled();
  });

  it('treats a failed open as success when the host exists afterwards', async () => {
    const { api, setOpen } = fakeApi({
      open: vi.fn(async () => {
        setOpen(true);
        throw new Error('Only a single offscreen document may be created');
      }),
    });
    await expect(new WorkerHost(api).ensure()).resolves.toBeUndefined();
  });

  it('rethrows an open failure when no host exists', async () => {
    const { api } = fakeApi({
      open: vi.fn(async () => {
        throw new Error('nope');
      }),
    });
    const host = new WorkerHost(api);
    await expect(host.ensure()).rejects.toThrow('nope');
    // A failed attempt must not wedge later ones.
    await expect(host.ensure()).rejects.toThrow('nope');
    expect(api.open).toHaveBeenCalledTimes(2);
  });

  it('closes only an existing host', async () => {
    const { api, setOpen } = fakeApi();
    const host = new WorkerHost(api);
    await host.close();
    expect(api.close).not.toHaveBeenCalled();
    setOpen(true);
    await host.close();
    expect(api.close).toHaveBeenCalledTimes(1);
  });
});
