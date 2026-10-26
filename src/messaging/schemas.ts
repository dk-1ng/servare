import { z } from 'zod';

/** URLs and text here come from page-controlled manifests and DOM: restrict schemes and sizes. */
const HttpUrlSchema = z.url({ protocol: /^https?$/ }).max(8192);
const ThumbnailSchema = z.union([
  HttpUrlSchema,
  z
    .string()
    .regex(/^data:image\/[a-z0-9.+-]+[;,]/i)
    .max(262_144),
]);
const TitleSchema = z.string().max(1024);

/** Data model from docs/design.md §2.5. The inferred types are the UI contract. */

export const MediaKindSchema = z.enum(['direct', 'hls', 'dash']);
export type MediaKind = z.infer<typeof MediaKindSchema>;

export const VariantSchema = z.object({
  id: z.string(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  bandwidth: z.number().nonnegative().optional(),
  codecs: z.string().optional(),
  container: z.string(),
});
export type Variant = z.infer<typeof VariantSchema>;

export const TrackSchema = z.object({
  id: z.string(),
  language: z.string().optional(),
  label: TitleSchema.optional(),
  codecs: z.string().optional(),
});
export type Track = z.infer<typeof TrackSchema>;

export const MediaItemSchema = z.object({
  id: z.string(),
  tabId: z.number().int(),
  kind: MediaKindSchema,
  url: HttpUrlSchema,
  pageUrl: HttpUrlSchema,
  title: TitleSchema,
  thumbnail: ThumbnailSchema.optional(),
  duration: z.union([z.number().nonnegative(), z.literal('live')]),
  variants: z.array(VariantSchema),
  audioTracks: z.array(TrackSchema),
  subtitles: z.array(TrackSchema),
  /** DRM detected: the item is shown but cannot be downloaded. */
  protected: z.boolean(),
  detectedAt: z.number(),
});
export type MediaItem = z.infer<typeof MediaItemSchema>;

export const DownloadErrorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cancelled') }),
  z.object({ kind: z.literal('http'), status: z.number().int() }),
  z.object({ kind: z.literal('incomplete'), ratio: z.number().min(0).max(1) }),
  z.object({ kind: z.literal('decrypt') }),
  z.object({ kind: z.literal('quota') }),
  z.object({ kind: z.literal('protected') }),
  z.object({ kind: z.literal('unknown'), message: z.string() }),
]);
export type DownloadError = z.infer<typeof DownloadErrorSchema>;

export const JobStatusSchema = z.enum([
  'queued',
  'running',
  'paused',
  'done',
  'failed',
  'cancelled',
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const DownloadJobSchema = z.object({
  id: z.string(),
  mediaId: z.string(),
  variantId: z.string().optional(),
  audioTrackIds: z.array(z.string()),
  subtitleIds: z.array(z.string()),
  mode: z.enum(['video', 'audio']),
  status: JobStatusSchema,
  progress: z.union([z.number().min(0).max(1), z.literal('indeterminate')]),
  bytesWritten: z.number().nonnegative(),
  error: DownloadErrorSchema.optional(),
  outputName: z.string().max(255),
  /** Browser download, from `done` on (design §4.9.1); absent when it will be erased. */
  downloadId: z.number().int().nonnegative().optional(),
});
export type DownloadJob = z.infer<typeof DownloadJobSchema>;
