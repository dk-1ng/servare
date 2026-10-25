import type { DownloadError } from '../messaging';
import type { FromWorker } from './worker-messages';

export interface HostControllerDeps {
  /** `delivery/deliver` to the background. */
  deliver(request: {
    jobId: string;
    blobUrl: string;
    filename: string;
    bytes: number;
  }): Promise<unknown>;
  /** `worker/failed` to the background. */
  /** `worker/progress` to the background. */
  reportProgress(jobId: string, bytesWritten: number, total: number | undefined): Promise<unknown>;
  reportFailure(jobId: string, error: DownloadError): Promise<unknown>;
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  removeJobFile(jobId: string): Promise<void>;
}

/**
 * Worker host side of §4.9. Owns the blob URLs: each one stays valid from the moment the
 * worker finishes until the background says the download ended (`release`), and the OPFS
 * file goes away at the same time.
 */
export class HostController {
  private readonly urls = new Map<string, string>();

  constructor(private readonly deps: HostControllerDeps) {}

  async onWorkerMessage(message: FromWorker): Promise<void> {
    if (message.type === 'progress') {
      // Progress is best effort: a lost update is replaced by the next one.
      await this.deps
        .reportProgress(message.jobId, message.bytesWritten, message.total)
        .catch(() => undefined);
      return;
    }
    if (message.type === 'failed') {
      await this.report(message.jobId, message.error);
      return;
    }
    const { jobId, filename } = message;
    const blobUrl = this.deps.createObjectURL(message.file);
    this.urls.set(jobId, blobUrl);
    try {
      await this.deps.deliver({ jobId, blobUrl, filename, bytes: message.file.size });
    } catch (error) {
      // Nothing will ever release this job: undo everything here.
      await this.release(jobId).catch((cleanupError: unknown) => {
        console.error('[servare] cleanup after a failed delivery failed', cleanupError);
      });
      await this.report(jobId, {
        kind: 'unknown',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** The download ended (or was given up on): revoke the URL and delete the temporary file. */
  async release(jobId: string): Promise<void> {
    const url = this.urls.get(jobId);
    if (url !== undefined) {
      this.urls.delete(jobId);
      this.deps.revokeObjectURL(url);
    }
    // Also without a URL: the file can outlive the page that created it.
    await this.deps.removeJobFile(jobId);
  }

  private async report(jobId: string, error: DownloadError): Promise<void> {
    try {
      await this.deps.reportFailure(jobId, error);
    } catch (reportError) {
      console.error('[servare] could not report a failed job', reportError);
    }
  }
}
