import type { CapturedHeaders } from '../detection/header-cache';
import {
  RULE_ID_MAX,
  RULE_ID_MIN,
  buildReplayRule,
  sameHeaderSet,
  type ReplayRule,
} from './header-rules';

/** The `declarativeNetRequest` subset used here. */
export interface DnrLike {
  getSessionRules(): Promise<{ id: number }[]>;
  updateSessionRules(update: { addRules?: ReplayRule[]; removeRuleIds?: number[] }): Promise<void>;
}

/** What the background persists per running job (a rule must never outlive its owner). */
export interface ReplayRecord {
  ruleIds: number[];
  /** Header set per origin, kept to detect conflicts between running jobs. */
  origins: Record<string, CapturedHeaders>;
}

export interface ReplayOwners {
  read(): Promise<Record<string, ReplayRecord>>;
  update(
    fn: (current: Record<string, ReplayRecord>) => Record<string, ReplayRecord>,
  ): Promise<unknown>;
}

export class HeaderConflictError extends Error {
  constructor(
    readonly origin: string,
    readonly blockingJobId: string,
  ) {
    super(`Another running job needs different headers for ${origin}`);
    this.name = 'HeaderConflictError';
  }
}

/**
 * Per-job header replay rules with guaranteed removal (design §4.1.1). Ownership lives in the
 * persisted job record, never in memory: the IDs are written before the rules exist
 * (write-ahead), so a crash in between leaves a rule that `sweep` can attribute and remove.
 */
export class HeaderReplay {
  constructor(
    private readonly dnr: DnrLike,
    private readonly owners: ReplayOwners,
    private readonly ownHost: string,
  ) {}

  /** Adds one rule per origin for `jobId`. Throws `HeaderConflictError` if another job clashes. */
  async apply(jobId: string, origins: Record<string, CapturedHeaders>): Promise<void> {
    const entries = Object.entries(origins);
    if (entries.length === 0) return;
    const used = new Set((await this.dnr.getSessionRules()).map((rule) => rule.id));
    let conflict: HeaderConflictError | undefined;
    let ids: number[] = [];
    await this.owners.update((current) => {
      conflict = undefined;
      for (const [otherId, record] of Object.entries(current)) {
        if (otherId === jobId) continue;
        for (const [origin, headers] of entries) {
          const theirs = record.origins[origin];
          if (theirs && !sameHeaderSet(theirs, headers))
            conflict ??= new HeaderConflictError(origin, otherId);
        }
      }
      if (conflict) return current;
      for (const record of Object.values(current)) for (const id of record.ruleIds) used.add(id);
      ids = allocate(used, entries.length);
      return { ...current, [jobId]: { ruleIds: ids, origins } };
    });
    if (conflict) throw conflict;
    try {
      await this.dnr.updateSessionRules({
        addRules: entries.map(([origin, headers], i) =>
          buildReplayRule(ids[i] as number, origin, headers, this.ownHost),
        ),
      });
    } catch (error) {
      await this.remove(jobId);
      throw error;
    }
  }

  /** Removes the job's rules and its ownership record. Safe to call twice. */
  async remove(jobId: string): Promise<void> {
    // Rules first: an owned ID with no rule behind it is harmless and a retry clears it, but a
    // rule without an owner would keep rewriting headers until the next background start.
    const ids = (await this.owners.read())[jobId]?.ruleIds ?? [];
    if (ids.length > 0) await this.dnr.updateSessionRules({ removeRuleIds: ids });
    await this.owners.update((current) =>
      Object.fromEntries(Object.entries(current).filter(([id]) => id !== jobId)),
    );
  }

  /** At background start: removes every rule in the reserved range that no job owns. */
  async sweep(): Promise<number> {
    const owned = new Set(Object.values(await this.owners.read()).flatMap((r) => r.ruleIds));
    const stale = (await this.dnr.getSessionRules())
      .map((rule) => rule.id)
      .filter((id) => id >= RULE_ID_MIN && id <= RULE_ID_MAX && !owned.has(id));
    if (stale.length > 0) await this.dnr.updateSessionRules({ removeRuleIds: stale });
    return stale.length;
  }
}

function allocate(used: Set<number>, count: number): number[] {
  const ids: number[] = [];
  for (let id = RULE_ID_MIN; id <= RULE_ID_MAX && ids.length < count; id++) {
    if (!used.has(id)) ids.push(id);
  }
  if (ids.length < count) throw new Error('No free header rule IDs');
  return ids;
}
