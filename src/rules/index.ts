/** Per-domain rules (design §6). Pure functions, no browser APIs. */
import { z } from 'zod';
import defaultRulesFile from './default-rules.json';

export const SPEED_PROFILES = ['economy', 'standard', 'fast'] as const;

export type SpeedProfile = (typeof SPEED_PROFILES)[number];

export interface DomainRules {
  /** `false` disables detection on the domain. */
  detection: boolean;
  /** Bytes; smaller direct files are not listed. */
  minDirectSize: number;
  /** Copy the manifest query string to its segments. */
  propagateQuery: boolean;
  /** Treat streams as audio. */
  audioOnly: boolean;
  /** Rolling list for infinite-scroll sites. */
  feedMode: boolean;
  /** Hide fragments when a manifest exists. */
  hideFragments: boolean;
  speedProfile: SpeedProfile;
}

export const DEFAULT_DOMAIN_RULES: Readonly<DomainRules> = {
  detection: true,
  minDirectSize: 1024 * 1024,
  propagateQuery: false,
  audioOnly: false,
  feedMode: false,
  hideFragments: true,
  speedProfile: 'standard',
};

const DomainRulesSchema = z
  .object({
    detection: z.boolean(),
    minDirectSize: z.number().int().nonnegative(),
    propagateQuery: z.boolean(),
    audioOnly: z.boolean(),
    feedMode: z.boolean(),
    hideFragments: z.boolean(),
    speedProfile: z.enum(SPEED_PROFILES),
  })
  .partial()
  .strict();

/** A bare lowercase host name: what `URL.hostname` returns, so a rule key can be compared as is. */
const DOMAIN_KEY = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/;

const IP_LITERAL = /^(\d+\.){3}\d+$|^\[.*\]$/;

export const RulesFileSchema = z
  .object({
    version: z.literal(1),
    domains: z.record(
      z.string().regex(DOMAIN_KEY, 'must be a lowercase host name without scheme, port or path'),
      DomainRulesSchema,
    ),
  })
  .strict();

export type RulesFile = z.infer<typeof RulesFileSchema>;

/** Throws a `ZodError` when `input` is not a valid rules file. */
export function parseRules(input: unknown): RulesFile {
  return RulesFileSchema.parse(input);
}

export const defaultRules: RulesFile = parseRules(defaultRulesFile);

/**
 * Effective rules for a host name. A rule applies to its domain and every subdomain; where several
 * match, the more specific domain overrides the broader one key by key, and anything unset falls
 * back to {@link DEFAULT_DOMAIN_RULES}.
 */
export function rulesFor(hostname: string, rules: RulesFile = defaultRules): DomainRules {
  const name = hostname.toLowerCase().replace(/\.$/, '');
  const labels = name.split('.');
  const result: DomainRules = { ...DEFAULT_DOMAIN_RULES };
  // An IP address has no parent domain: `0.1` must not match `192.168.0.1`.
  const last = IP_LITERAL.test(name) ? 0 : labels.length - 1;
  // From the broadest suffix (`com`) down to the full host name, so the most specific wins.
  for (let i = last; i >= 0; i--) {
    const own = Object.hasOwn(rules.domains, labels.slice(i).join('.'))
      ? rules.domains[labels.slice(i).join('.')]
      : undefined;
    if (own) Object.assign(result, own);
  }
  return result;
}
