/** File name templates and sanitization (design §7). Pure functions, no browser APIs. */

export const MAX_NAME_LENGTH = 180;
/** UTF-8 cap, under the 255-byte limit of ext4/APFS to leave room for the browser's ` (1)` suffix. */
export const MAX_NAME_BYTES = 240;
export const FALLBACK_NAME = 'video';
export const DEFAULT_TEMPLATE = '{title}';

export type TemplateVariable = 'title' | 'host' | 'date' | 'quality' | 'lang';

export type TemplateValues = Partial<Record<TemplateVariable, string>>;

export interface NameOptions {
  /** Appended after the name, e.g. `mp4`; a leading dot is accepted. Never truncated away. */
  extension?: string;
  /** Folder inside the downloads folder; sanitized per segment. */
  subfolder?: string;
}

// Invalid on Windows (the strictest of the three) plus all control characters.
// eslint-disable-next-line no-control-regex
const INVALID_CHARS = /[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/g;
// Format characters that render as nothing or reorder text: zero-width, bidi controls, BOM.
const INVISIBLE_CHARS = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|clock\$|com[0-9¹²³]|lpt[0-9¹²³])$/i;
const VARIABLE = /\{(\w+)\}/g;
const VARIABLES: ReadonlySet<string> = new Set<TemplateVariable>([
  'title',
  'host',
  'date',
  'quality',
  'lang',
]);
const encoder = new TextEncoder();

/** Cuts at whole code points so the result fits `maxLength` characters and `maxBytes` of UTF-8. */
function truncate(text: string, maxLength: number, maxBytes = MAX_NAME_BYTES): string {
  let out = '';
  let bytes = 0;
  let count = 0;
  for (const point of text) {
    const size = encoder.encode(point).length;
    if (count + 1 > maxLength || bytes + size > maxBytes) break;
    out += point;
    bytes += size;
    count += 1;
  }
  return out;
}

function stripEdges(text: string): string {
  // Windows drops trailing dots and spaces; a leading dot would hide the file on Unix.
  return text.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
}

function cleanSegment(raw: string): string {
  const cleaned = raw
    .normalize('NFC')
    .replace(INVALID_CHARS, ' ')
    .replace(INVISIBLE_CHARS, '')
    .replace(/\s+/g, ' ');
  return stripEdges(cleaned);
}

/** Windows treats `CON.txt` like `CON`, so the check looks at the part before the first dot. */
function isReserved(name: string): boolean {
  return RESERVED.test(name.split('.')[0]?.trimEnd() ?? name);
}

function avoidReserved(name: string): string {
  return isReserved(name) ? `_${name}` : name;
}

function cleanExtension(extension: string | undefined): string {
  if (extension === undefined) return '';
  const ext = extension.replace(/^\.+/, '').replace(/[^\p{L}\p{N}]/gu, '');
  return ext === '' ? '' : `.${truncate(ext, 16)}`;
}

/**
 * Turns arbitrary text into a name safe on Windows, macOS and Linux. The result is at most
 * `maxLength` code points including `extension`, and never empty (falls back to `video`).
 */
export function sanitizeFileName(
  name: string,
  extension?: string,
  maxLength = MAX_NAME_LENGTH,
): string {
  const ext = cleanExtension(extension);
  const cleaned = cleanSegment(name) || FALLBACK_NAME;
  // Reserve room for the `_` prefix up front so the limit holds after it is added.
  const prefix = isReserved(cleaned) ? 1 : 0;
  const budget = Math.max(1, maxLength - Array.from(ext).length - prefix);
  const byteBudget = Math.max(1, MAX_NAME_BYTES - encoder.encode(ext).length - prefix);
  const base = stripEdges(truncate(cleaned, budget, byteBudget)) || FALLBACK_NAME;
  return avoidReserved(base) + ext;
}

/** Sanitizes each segment of a relative folder path; `.`/`..`, absolute roots and empties vanish. */
export function sanitizeSubfolder(path: string | undefined): string {
  if (path === undefined) return '';
  return path
    .split(/[/\\]+/)
    .map((segment) => {
      const cleaned = cleanSegment(segment);
      const prefix = isReserved(cleaned) ? 1 : 0;
      const cut = stripEdges(truncate(cleaned, MAX_NAME_LENGTH - prefix, MAX_NAME_BYTES - prefix));
      return cut === '' ? '' : avoidReserved(cut);
    })
    .filter((segment) => segment !== '')
    .join('/');
}

/** Local calendar date as `YYYY-MM-DD`. */
export function formatDate(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Fills `{variable}` placeholders. Values are cleaned before insertion so a title containing
 * `/` cannot add path segments; unknown or missing variables expand to nothing.
 */
export function expandTemplate(template: string, values: TemplateValues): string {
  return template.replace(VARIABLE, (_match, key: string) => {
    if (!VARIABLES.has(key)) return '';
    const value = values[key as TemplateVariable];
    return value === undefined ? '' : cleanSegment(value);
  });
}

/**
 * Full download path relative to the downloads folder: optional subfolder plus a sanitized
 * file name built from `template`.
 */
export function buildFileName(
  template: string,
  values: TemplateValues,
  options: NameOptions = {},
): string {
  const name = sanitizeFileName(
    expandTemplate(template === '' ? DEFAULT_TEMPLATE : template, values),
    options.extension,
  );
  const folder = sanitizeSubfolder(options.subfolder);
  return folder === '' ? name : `${folder}/${name}`;
}
