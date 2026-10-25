import { describe, expect, it, vi } from 'vitest';
import { HostController } from './host-controller';

function setup(deliver = vi.fn(async () => ({ downloadId: 1 }))) {
  const deps = {
    deliver,
    reportFailure: vi.fn(async () => null),
    createObjectURL: vi.fn(() => 'blob:abc'),
    revokeObjectURL: vi.fn(),
    removeJobFile: vi.fn(async () => {}),
  };
  return { deps, controller: new HostController(deps) };
}

const done = { type: 'done', jobId: 'j1', filename: 'a.mp4', file: new Blob(['x']) } as const;

describe('HostController', () => {
  it('delivers a finished file and keeps the blob URL and file until release', async () => {
    const { deps, controller } = setup();
    await controller.onWorkerMessage(done);
    expect(deps.deliver).toHaveBeenCalledWith({
      jobId: 'j1',
      blobUrl: 'blob:abc',
      filename: 'a.mp4',
    });
    expect(deps.revokeObjectURL).not.toHaveBeenCalled();
    expect(deps.removeJobFile).not.toHaveBeenCalled();

    await controller.release('j1');
    expect(deps.revokeObjectURL).toHaveBeenCalledWith('blob:abc');
    expect(deps.removeJobFile).toHaveBeenCalledWith('j1');
  });

  it('revokes, removes the file and reports when deliver throws', async () => {
    const { deps, controller } = setup(
      vi.fn(async () => {
        throw new Error('cancelled');
      }),
    );
    await controller.onWorkerMessage(done);
    expect(deps.revokeObjectURL).toHaveBeenCalledWith('blob:abc');
    expect(deps.removeJobFile).toHaveBeenCalledWith('j1');
    expect(deps.reportFailure).toHaveBeenCalledWith('j1', {
      kind: 'unknown',
      message: 'cancelled',
    });
  });

  it('still reports when the cleanup after a failed deliver also fails', async () => {
    const { deps, controller } = setup(
      vi.fn(async () => {
        throw new Error('x');
      }),
    );
    deps.removeJobFile.mockRejectedValueOnce(new Error('locked'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await controller.onWorkerMessage(done);
    expect(deps.reportFailure).toHaveBeenCalledWith('j1', { kind: 'unknown', message: 'x' });
  });

  it('forwards a worker failure to the background', async () => {
    const { deps, controller } = setup();
    await controller.onWorkerMessage({ type: 'failed', jobId: 'j2', error: { kind: 'quota' } });
    expect(deps.reportFailure).toHaveBeenCalledWith('j2', { kind: 'quota' });
    expect(deps.createObjectURL).not.toHaveBeenCalled();
  });

  it('release removes the file even when the URL is unknown (host restarted)', async () => {
    const { deps, controller } = setup();
    await controller.release('old');
    expect(deps.revokeObjectURL).not.toHaveBeenCalled();
    expect(deps.removeJobFile).toHaveBeenCalledWith('old');
  });
});
