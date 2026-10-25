import { browser } from 'wxt/browser';
import type { StorageAreaLike } from './store';

export * from './store';

/** Survives browser restarts. */
export const localArea: StorageAreaLike = browser.storage.local;
/** Cleared when the browser closes; survives background suspension. */
export const sessionArea: StorageAreaLike = browser.storage.session;
