/** The subset of `navigator.storage` the free space check needs. */
export interface StorageEstimator {
  estimate(): Promise<{ usage?: number; quota?: number }>;
}

/** Thrown when the origin quota cannot hold the file; maps to the `quota` download error. */
export class QuotaError extends Error {
  readonly required: number;
  readonly available: number;

  constructor(required: number, available: number) {
    super(`Not enough storage: need ${String(required)} bytes, ${String(available)} available`);
    this.name = 'QuotaError';
    this.required = required;
    this.available = available;
  }
}

/**
 * Fails early when `requiredBytes` will not fit. If the browser reports no quota the check
 * passes, because refusing on missing data would block downloads that would have worked.
 */
export async function ensureFreeSpace(
  requiredBytes: number,
  storage: StorageEstimator = navigator.storage,
): Promise<void> {
  const { usage = 0, quota } = await storage.estimate();
  if (quota === undefined) return;
  const available = Math.max(0, quota - usage);
  if (requiredBytes > available) throw new QuotaError(requiredBytes, available);
}
