import { describe, expect, it, vi } from 'vitest';
import { MessagingError, requestOverRuntime, respondToRuntimeMessage } from './index';

const release = { jobId: 'j1', outcome: 'complete' } as const;

describe('requestOverRuntime', () => {
  it('sends a validated envelope and returns the parsed response', async () => {
    const sendMessage = vi.fn(async (m: unknown) => ({
      kind: 'response',
      id: (m as { id: string }).id,
      ok: true,
      payload: null,
    }));
    await expect(
      requestOverRuntime({ sendMessage }, 'delivery/release', release),
    ).resolves.toBeNull();
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'request', name: 'delivery/release', payload: release }),
    );
  });

  it('rejects an invalid payload before sending', async () => {
    const sendMessage = vi.fn();
    await expect(
      requestOverRuntime({ sendMessage }, 'delivery/release', { jobId: 1 } as never),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('retries while nobody listens, then succeeds', async () => {
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error('Receiving end does not exist'))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ kind: 'response', id: 'x', ok: true, payload: null });
    await expect(
      requestOverRuntime({ sendMessage }, 'delivery/release', release, { retries: 2, delay: 1 }),
    ).resolves.toBeNull();
    expect(sendMessage).toHaveBeenCalledTimes(3);
  });

  it('fails with disconnected when retries run out', async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error('gone'));
    await expect(
      requestOverRuntime({ sendMessage }, 'delivery/release', release, { retries: 1, delay: 1 }),
    ).rejects.toMatchObject({ code: 'disconnected' });
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('surfaces an error response as a MessagingError', async () => {
    const sendMessage = vi.fn(async () => ({
      kind: 'response',
      id: 'x',
      ok: false,
      error: { code: 'handler-failed', message: 'boom' },
    }));
    const error = await requestOverRuntime({ sendMessage }, 'delivery/release', release).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(MessagingError);
    expect(error).toMatchObject({ code: 'handler-failed' });
  });
});

describe('respondToRuntimeMessage', () => {
  const handlers = { 'delivery/release': vi.fn(async () => null) };
  const req = (name: string) => ({ kind: 'request', id: 'r', name, payload: release });

  it('answers requests it has a handler for', async () => {
    const res = await respondToRuntimeMessage(req('delivery/release'), handlers);
    expect(res).toEqual({ kind: 'response', id: 'r', ok: true, payload: null });
  });

  it('stays silent for other requests, unknown names and non-requests', () => {
    expect(respondToRuntimeMessage(req('media/list'), handlers)).toBeUndefined();
    expect(respondToRuntimeMessage(req('nope'), handlers)).toBeUndefined();
    expect(respondToRuntimeMessage({ kind: 'event' }, handlers)).toBeUndefined();
    expect(respondToRuntimeMessage('hi', handlers)).toBeUndefined();
  });
});
