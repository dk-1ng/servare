import { z } from 'zod';
import type { PageMeta } from './page-meta';

/** Background-side check of what a content script, which runs in an untrusted page, replied. */
export const PageMetaSchema: z.ZodType<PageMeta> = z.object({
  title: z.string().max(1024).optional(),
  thumbnail: z.string().max(8192).optional(),
});
