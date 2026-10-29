import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runDirectJob, type JobWriter } from '../download/direct-job';
import type { SpeedProfile } from '../rules';
import { startTestServer, type TestServer } from '../../test/server/server';
import { createFetcher } from './fetcher';

let server: TestServer;
beforeAll(async () => {
  server = await startTestServer();
}, 120_000);
afterAll(async () => {
  await server.close();
});

const retry = { attempts: 4, baseMs: 5, maxMs: 20, maxRetryAfterMs: 1000 };

function fetcherFor(profile: SpeedProfile) {
  return createFetcher({
    fetch: (url, init) => fetch(url, { ...init, credentials: 'omit' }),
    profileFor: () => profile,
    retry,
  });
}

describe('fetcher against the test server', () => {
  it('completes a download although the first requests answer 503', async () => {
    server.reset();
    const fetcher = fetcherFor('standard');
    const written = new Uint8Array(2000);
    const writer: JobWriter = {
      writeAt: (at, data) => written.set(data, at),
      truncate: () => undefined,
      finish: async () => new File([written], 'f'),
      remove: async () => undefined,
    };
    const file = await runDirectJob(
      { jobId: 'j', url: `${server.origin}/flaky/2/synthetic/2000` },
      {
        fetch: fetcher.fetch,
        openWriter: async () => writer,
        ensureFreeSpace: async () => undefined,
      },
    );
    expect(file.size).toBe(2000);
    expect(server.requests).toHaveLength(3);
  });

  /** Milliseconds to fetch three files from one host when the server holds each answer 300 ms. */
  async function timeThreeSlowFetches(profile: SpeedProfile): Promise<number> {
    const fetcher = fetcherFor(profile);
    const { signal } = new AbortController();
    const started = Date.now();
    await Promise.all(
      [1, 2, 3].map(async (n) => {
        const response = await fetcher.fetch(
          `${server.origin}/synthetic/10?delay=300&n=${String(n)}`,
          { signal },
        );
        await response.arrayBuffer();
      }),
    );
    return Date.now() - started;
  }

  it('uses a single connection on the Economy profile: the fetches queue one behind another', async () => {
    expect(await timeThreeSlowFetches('economy')).toBeGreaterThanOrEqual(850);
  });

  it('overlaps the fetches on the Standard profile', async () => {
    expect(await timeThreeSlowFetches('standard')).toBeLessThan(700);
  });
});
