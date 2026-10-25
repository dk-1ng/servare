import { describe, expect, it } from 'vitest';
import { HeaderConflictError, HeaderReplay, type ReplayRecord } from './header-replay';
import { RULE_ID_MIN, buildReplayRule, escapeRegExp } from './header-rules';

function setup() {
  let owners: Record<string, ReplayRecord> = {};
  let rules: { id: number }[] = [];
  const replay = new HeaderReplay(
    {
      getSessionRules: async () => rules,
      updateSessionRules: async ({ addRules = [], removeRuleIds = [] }) => {
        rules = [...rules.filter((r) => !removeRuleIds.includes(r.id)), ...addRules];
      },
    },
    {
      read: async () => owners,
      update: async (fn) => void (owners = fn(owners)),
    },
    'ext-host',
  );
  return { replay, rules: () => rules, owners: () => owners };
}

const A = 'https://cdn.example.com';
const headers = { referer: 'https://example.com/watch', cookie: 'a=1' };

describe('buildReplayRule', () => {
  it('scopes to the exact escaped origin and the extension as initiator', () => {
    const rule = buildReplayRule(5, 'http://[::1]:8080', headers, 'ext-host');
    expect(rule.condition.regexFilter).toBe(String.raw`^http://\[::1\]:8080/`);
    expect(rule.condition.initiatorDomains).toEqual(['ext-host']);
    expect(new RegExp(rule.condition.regexFilter).test('http://[::1]:8080/a.mp4')).toBe(true);
    expect(new RegExp(rule.condition.regexFilter).test('http://[::1]:80801/a.mp4')).toBe(false);
  });

  it('sets what the player sent and removes the rest', () => {
    const rule = buildReplayRule(5, A, headers, 'h');
    expect(rule.action.requestHeaders).toEqual([
      { header: 'Referer', operation: 'set', value: 'https://example.com/watch' },
      { header: 'Origin', operation: 'remove' },
      { header: 'Cookie', operation: 'set', value: 'a=1' },
    ]);
  });

  it('escapes regex metacharacters', () => {
    expect(escapeRegExp('a.b+c')).toBe(String.raw`a\.b\+c`);
  });
});

describe('HeaderReplay', () => {
  it('records ownership and adds one rule per origin', async () => {
    const s = setup();
    await s.replay.apply('j1', { [A]: headers, 'https://b.example': headers });
    expect(s.rules().map((r) => r.id)).toEqual([RULE_ID_MIN, RULE_ID_MIN + 1]);
    expect(s.owners()['j1']?.ruleIds).toEqual([RULE_ID_MIN, RULE_ID_MIN + 1]);
  });

  it('removes rules and ownership, and tolerates a second call', async () => {
    const s = setup();
    await s.replay.apply('j1', { [A]: headers });
    await s.replay.remove('j1');
    await s.replay.remove('j1');
    expect(s.rules()).toEqual([]);
    expect(s.owners()).toEqual({});
  });

  it('gives two jobs on one origin their own rules; removing one keeps the other', async () => {
    const s = setup();
    await s.replay.apply('j1', { [A]: headers });
    await s.replay.apply('j2', { [A]: headers });
    expect(s.rules()).toHaveLength(2);
    await s.replay.remove('j1');
    expect(s.rules().map((r) => r.id)).toEqual([RULE_ID_MIN + 1]);
  });

  it('refuses a different header set for an origin another job uses', async () => {
    const s = setup();
    await s.replay.apply('j1', { [A]: headers });
    await expect(s.replay.apply('j2', { [A]: { ...headers, cookie: 'b=2' } })).rejects.toThrow(
      HeaderConflictError,
    );
    expect(s.rules()).toHaveLength(1);
    expect(s.owners()['j2']).toBeUndefined();
  });

  it('undoes ownership when the browser rejects the rules', async () => {
    let owners: Record<string, ReplayRecord> = {};
    const replay = new HeaderReplay(
      {
        getSessionRules: async () => [],
        updateSessionRules: async ({ addRules }) => {
          if (addRules) throw new Error('rejected');
        },
      },
      { read: async () => owners, update: async (fn) => void (owners = fn(owners)) },
      'h',
    );
    await expect(replay.apply('j1', { [A]: headers })).rejects.toThrow('rejected');
    expect(owners['j1']).toBeUndefined();
  });

  it('treats an empty header set as different from one with a cookie', async () => {
    const s = setup();
    await s.replay.apply('j1', { [A]: headers });
    await expect(s.replay.apply('j2', { [A]: {} })).rejects.toThrow(HeaderConflictError);
    await s.replay.remove('j1');
    await s.replay.apply('j2', { [A]: {} });
    await expect(s.replay.apply('j3', { [A]: headers })).rejects.toThrow(HeaderConflictError);
  });

  it('keeps ownership when removing the rules fails, so a retry can finish', async () => {
    let owners: Record<string, ReplayRecord> = {};
    let fail = false;
    const replay = new HeaderReplay(
      {
        getSessionRules: async () => [],
        updateSessionRules: async ({ removeRuleIds }) => {
          if (fail && removeRuleIds) throw new Error('dnr down');
        },
      },
      { read: async () => owners, update: async (fn) => void (owners = fn(owners)) },
      'h',
    );
    await replay.apply('j1', { [A]: headers });
    fail = true;
    await expect(replay.remove('j1')).rejects.toThrow('dnr down');
    expect(owners['j1']).toBeDefined();
    fail = false;
    await replay.remove('j1');
    expect(owners['j1']).toBeUndefined();
  });

  it('sweeps rules in the reserved range that no job owns', async () => {
    const s = setup();
    await s.replay.apply('j1', { [A]: headers });
    await s.replay.apply('j2', { [A]: headers });
    // j2's job record is gone (a crash), but its rule is still installed.
    delete s.owners()['j2'];
    expect(await s.replay.sweep()).toBe(1);
    expect(s.rules().map((r) => r.id)).toEqual([RULE_ID_MIN]);
  });

  it('never touches rules outside the reserved range', async () => {
    const s = setup();
    s.rules().push({ id: 7 });
    expect(await s.replay.sweep()).toBe(0);
  });
});
