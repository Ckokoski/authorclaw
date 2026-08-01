import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { SkillLoader } from './loader.js';
import { PermissionManager } from '../security/permissions.js';

/** Write a fixture SKILL.md at skills/<category>/<name>/SKILL.md. */
async function writeSkillFixture(
  skillsDir: string,
  category: string,
  name: string,
  opts: { description: string; triggers: string[]; permissions?: string[]; body?: string },
): Promise<void> {
  const dir = join(skillsDir, category, name);
  await mkdir(dir, { recursive: true });
  const triggerLines = opts.triggers.map(t => `  - "${t}"`).join('\n');
  const permLines = (opts.permissions || []).map(p => `  - "${p}"`).join('\n');
  const frontmatter = [
    '---',
    `name: ${name}`,
    `description: ${opts.description}`,
    'author: test',
    'version: 1.0.0',
    'triggers:',
    triggerLines,
    'permissions:',
    permLines,
    '---',
  ].join('\n');
  const content = `${frontmatter}\n\n${opts.body || `# ${name}\n\nBody content for ${name}.`}\n`;
  await writeFile(join(dir, 'SKILL.md'), content, 'utf-8');
}

describe('SkillLoader.loadAll + parsing', () => {
  let skillsDir: string;
  let loader: SkillLoader;

  beforeEach(async () => {
    skillsDir = await mkdtemp(join(tmpdir(), 'authoragent-skills-test-'));
    loader = new SkillLoader(skillsDir, new PermissionManager('standard'));
  });

  afterEach(async () => {
    await rm(skillsDir, { recursive: true, force: true });
  });

  it('loads zero skills from an empty skills dir', async () => {
    await loader.loadAll();
    expect(loader.getLoadedCount()).toBe(0);
  });

  it('loads a well-formed skill from the core category', async () => {
    await writeSkillFixture(skillsDir, 'core', 'test-skill', {
      description: 'A test skill for unit tests.',
      triggers: ['test skill', 'run tests'],
      permissions: ['memory_read'],
    });
    await loader.loadAll();
    expect(loader.getLoadedCount()).toBe(1);
    const skill = loader.getSkillByName('test-skill');
    expect(skill).toBeDefined();
    expect(skill!.description).toBe('A test skill for unit tests.');
    expect(skill!.triggers).toEqual(['test skill', 'run tests']);
    expect(skill!.permissions).toEqual(['memory_read']);
    expect(skill!.category).toBe('core');
  });

  it('loads skills across all 5 recognized categories, including "ops"', async () => {
    await writeSkillFixture(skillsDir, 'core', 'core-skill', { description: 'd', triggers: ['t1'] });
    await writeSkillFixture(skillsDir, 'author', 'author-skill', { description: 'd', triggers: ['t2'] });
    await writeSkillFixture(skillsDir, 'marketing', 'mkt-skill', { description: 'd', triggers: ['t3'] });
    await writeSkillFixture(skillsDir, 'premium', 'prem-skill', { description: 'd', triggers: ['t4'] });
    await writeSkillFixture(skillsDir, 'ops', 'ops-skill', { description: 'd', triggers: ['t5'] });
    await loader.loadAll();
    expect(loader.getLoadedCount()).toBe(5);
    expect(loader.getSkillByName('ops-skill')?.category).toBe('ops');
  });

  it('skips a directory whose name starts with "{"', async () => {
    await writeSkillFixture(skillsDir, 'core', '{template}', { description: 'd', triggers: ['t'] });
    await loader.loadAll();
    expect(loader.getLoadedCount()).toBe(0);
  });

  it('skips a skill directory with no SKILL.md', async () => {
    await mkdir(join(skillsDir, 'core', 'empty-dir'), { recursive: true });
    await loader.loadAll();
    expect(loader.getLoadedCount()).toBe(0);
  });

  it('returns null (skips) for a SKILL.md with no YAML frontmatter', async () => {
    const dir = join(skillsDir, 'core', 'no-frontmatter');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), '# Just a heading\n\nNo frontmatter here.', 'utf-8');
    await loader.loadAll();
    expect(loader.getLoadedCount()).toBe(0);
  });

  it('reloading clears previously loaded skills', async () => {
    await writeSkillFixture(skillsDir, 'core', 'skill-one', { description: 'd', triggers: ['t'] });
    await loader.loadAll();
    expect(loader.getLoadedCount()).toBe(1);

    // Remove the skill dir and reload — should now be empty.
    await rm(join(skillsDir, 'core', 'skill-one'), { recursive: true, force: true });
    await loader.loadAll();
    expect(loader.getLoadedCount()).toBe(0);
  });

  it('getSkillCatalog returns lightweight entries without full content', async () => {
    await writeSkillFixture(skillsDir, 'premium', 'premium-skill', {
      description: 'Premium desc',
      triggers: ['premium trigger'],
    });
    await loader.loadAll();
    const catalog = loader.getSkillCatalog();
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toEqual({
      name: 'premium-skill',
      description: 'Premium desc',
      category: 'premium',
      triggers: ['premium trigger'],
      premium: true,
    });
  });

  it('getPremiumSkillCount and getAuthorSkillCount count correctly', async () => {
    await writeSkillFixture(skillsDir, 'premium', 'p1', { description: 'd', triggers: ['t'] });
    await writeSkillFixture(skillsDir, 'premium', 'p2', { description: 'd', triggers: ['t'] });
    await writeSkillFixture(skillsDir, 'author', 'a1', { description: 'd', triggers: ['t'] });
    await loader.loadAll();
    expect(loader.getPremiumSkillCount()).toBe(2);
    expect(loader.getAuthorSkillCount()).toBe(1);
  });

  it('getSkillsByCategory groups skills by category', async () => {
    await writeSkillFixture(skillsDir, 'core', 'c1', { description: 'd', triggers: ['t'] });
    await writeSkillFixture(skillsDir, 'core', 'c2', { description: 'd', triggers: ['t'] });
    await writeSkillFixture(skillsDir, 'marketing', 'm1', { description: 'd', triggers: ['t'] });
    await loader.loadAll();
    const grouped = loader.getSkillsByCategory();
    expect(grouped.core).toHaveLength(2);
    expect(grouped.marketing).toHaveLength(1);
  });
});

describe('SkillLoader.registerSynthetic', () => {
  let skillsDir: string;
  let loader: SkillLoader;

  beforeEach(async () => {
    skillsDir = await mkdtemp(join(tmpdir(), 'authoragent-skills-test-'));
    loader = new SkillLoader(skillsDir, new PermissionManager('standard'));
    await loader.loadAll();
  });

  afterEach(async () => {
    await rm(skillsDir, { recursive: true, force: true });
  });

  it('registers a valid synthetic skill and reports it added', () => {
    const added = loader.registerSynthetic([
      { name: 'synthetic-1', description: 'desc', triggers: ['trig'] },
    ]);
    expect(added).toBe(1);
    expect(loader.getSkillByName('synthetic-1')?.category).toBe('author');
  });

  it('skips synthetic entries missing required fields', () => {
    const added = loader.registerSynthetic([
      { name: '', description: 'desc', triggers: ['trig'] },
      { name: 'no-desc', description: '', triggers: ['trig'] },
      { name: 'no-triggers', description: 'desc', triggers: [] },
    ] as any);
    expect(added).toBe(0);
  });

  it('does not override an already-loaded skill of the same name', async () => {
    await writeSkillFixture(skillsDir, 'core', 'shared-name', {
      description: 'original',
      triggers: ['orig-trigger'],
    });
    await loader.loadAll();
    const added = loader.registerSynthetic([
      { name: 'shared-name', description: 'synthetic version', triggers: ['synthetic-trigger'] },
    ]);
    expect(added).toBe(0);
    expect(loader.getSkillByName('shared-name')?.description).toBe('original');
  });

  it('defaults synthetic permissions to ["memory_read"] when not provided', () => {
    loader.registerSynthetic([{ name: 'synth-perm', description: 'd', triggers: ['t'] }]);
    expect(loader.getSkillByName('synth-perm')?.permissions).toEqual(['memory_read']);
  });
});

describe('SkillLoader.matchSkills — ranking, cap, budget', () => {
  let skillsDir: string;
  let loader: SkillLoader;

  beforeEach(async () => {
    skillsDir = await mkdtemp(join(tmpdir(), 'authoragent-skills-test-'));
    loader = new SkillLoader(skillsDir, new PermissionManager('standard'));
  });

  afterEach(async () => {
    await rm(skillsDir, { recursive: true, force: true });
  });

  it('returns an empty array when no skills match', async () => {
    await writeSkillFixture(skillsDir, 'core', 'unrelated', { description: 'd', triggers: ['xyzzy'] });
    await loader.loadAll();
    expect(loader.matchSkills('completely different input')).toEqual([]);
  });

  it('matches a skill whose trigger is a word-bounded substring of the input', async () => {
    await writeSkillFixture(skillsDir, 'core', 'outline-skill', {
      description: 'Build an outline',
      triggers: ['outline'],
    });
    await loader.loadAll();
    const results = loader.matchSkills('please write an outline for my book');
    expect(results).toHaveLength(1);
    expect(results[0]).toContain('outline-skill');
  });

  it('ranks an exact word-boundary match above a substring-only match', async () => {
    // "cover" as a whole word should win over "coverage" containing "cover"
    // as a substring but not word-bounded in some input... construct so both
    // skills match the SAME input, one via word-boundary and one via pure substring.
    await writeSkillFixture(skillsDir, 'core', 'word-bounded', {
      description: 'Word bounded match',
      triggers: ['cover'],
    });
    await writeSkillFixture(skillsDir, 'core', 'substring-only', {
      description: 'Substring only match',
      triggers: ['overed'], // matches inside "covered" as a substring but ISN'T itself word-bounded there
    });
    await loader.loadAll();
    // Input contains "covered" — "cover" is NOT word-bounded here (followed by 'e', not a boundary),
    // but "overed" IS word-bounded (preceded by 'c'... wait 'c' is a word char so it's NOT bounded either).
    // Simplify: use an input where one trigger matches as a whole word and another only as a substring.
    const results = loader.matchSkills('please cover this topic, overedge cases too');
    // "cover" matches word-bounded ("please cover this" -> cover surrounded by spaces).
    // "overed" matches only as a substring inside "overedge" (no word boundary after 'd').
    expect(results[0]).toContain('word-bounded');
  });

  it('gives higher score to multiple trigger hits on the same skill', async () => {
    await writeSkillFixture(skillsDir, 'core', 'multi-hit', {
      description: 'Multiple triggers',
      triggers: ['alpha', 'beta'],
    });
    await writeSkillFixture(skillsDir, 'core', 'single-hit', {
      description: 'Single trigger',
      triggers: ['alpha'],
    });
    await loader.loadAll();
    const results = loader.matchSkills('alpha and beta both appear here');
    expect(results[0]).toContain('multi-hit');
  });

  it('caps results at MAX_MATCHED_SKILLS (5) even when more skills match', async () => {
    for (let i = 0; i < 7; i++) {
      await writeSkillFixture(skillsDir, 'core', `skill-${i}`, {
        description: `Skill ${i}`,
        triggers: [`trigger${i}`],
      });
    }
    await loader.loadAll();
    const input = 'trigger0 trigger1 trigger2 trigger3 trigger4 trigger5 trigger6';
    const results = loader.matchSkills(input);
    expect(results.length).toBeLessThanOrEqual(5);
    expect(results).toHaveLength(5);
  });

  it('matching is case-insensitive', async () => {
    await writeSkillFixture(skillsDir, 'core', 'case-test', {
      description: 'Case test',
      triggers: ['UPPERCASE TRIGGER'],
    });
    await loader.loadAll();
    const results = loader.matchSkills('this has an uppercase trigger in it');
    expect(results).toHaveLength(1);
  });

  it('always includes the header (name + description) for a matched skill regardless of budget', async () => {
    // Fill the budget with one huge skill, then match a second smaller skill too —
    // both should get at least a header, per the "header always included" comment.
    await writeSkillFixture(skillsDir, 'core', 'huge-skill', {
      description: 'Huge skill',
      triggers: ['huge'],
      body: 'x'.repeat(9000),
    });
    await writeSkillFixture(skillsDir, 'core', 'small-skill', {
      description: 'Small skill',
      triggers: ['small'],
      body: 'small body',
    });
    await loader.loadAll();
    const results = loader.matchSkills('huge and small both appear');
    expect(results.length).toBe(2);
    for (const r of results) {
      expect(r).toMatch(/^## Skill: /);
    }
  });

  it('truncates a skill body that would exceed the ~15000-char budget and appends [truncated]', async () => {
    await writeSkillFixture(skillsDir, 'core', 'giant-skill', {
      description: 'Giant skill body',
      triggers: ['giant'],
      body: 'y'.repeat(18000),
    });
    await loader.loadAll();
    const results = loader.matchSkills('giant');
    expect(results).toHaveLength(1);
    expect(results[0]).toContain('[truncated]');
  });

  it('does not truncate a skill body that fits within budget', async () => {
    await writeSkillFixture(skillsDir, 'core', 'small-fit', {
      description: 'Small fit',
      triggers: ['smallfit'],
      body: 'short body content',
    });
    await loader.loadAll();
    const results = loader.matchSkills('smallfit please');
    expect(results[0]).not.toContain('[truncated]');
    expect(results[0]).toContain('short body content');
  });

  it('omits body entirely (description-only) once the budget is fully exhausted by prior matches', async () => {
    // Two large skills that both match, ranked so the first consumes nearly
    // the entire ~15000 char budget, leaving <=200 chars remaining for the
    // second (triggering the "budget exhausted" branch rather than a
    // truncated slice).
    await writeSkillFixture(skillsDir, 'core', 'first-huge', {
      description: 'First huge, matches twice for higher score',
      triggers: ['sharedterm', 'firsthuge'],
      body: 'z'.repeat(14900),
    });
    await writeSkillFixture(skillsDir, 'core', 'second-huge', {
      description: 'Second huge',
      triggers: ['sharedterm'],
      body: 'w'.repeat(14900),
    });
    await loader.loadAll();
    const results = loader.matchSkills('sharedterm firsthuge appears in this input');
    expect(results).toHaveLength(2);
    // First result should include a truncated or full body; second should be header-only
    // (no body content chars from 'w'.repeat at all) since budget is exhausted.
    const second = results.find(r => r.includes('second-huge'));
    expect(second).toBeDefined();
    expect(second).not.toContain('w'.repeat(50));
  });
});

describe('SkillLoader — usage logging', () => {
  let skillsDir: string;
  let loader: SkillLoader;

  beforeEach(async () => {
    skillsDir = await mkdtemp(join(tmpdir(), 'authoragent-usage-test-'));
    // No workspaceDir → in-memory-only usage (no disk writes to assert on).
    loader = new SkillLoader(skillsDir, new PermissionManager('standard'));
  });

  afterEach(async () => {
    await rm(skillsDir, { recursive: true, force: true });
  });

  it('starts with empty usage stats', () => {
    expect(loader.getUsageStats()).toEqual({});
  });

  it('recordUsage increments the count and sets lastUsedIso', () => {
    loader.recordUsage(['skill-a', 'skill-b']);
    loader.recordUsage(['skill-a']);
    const stats = loader.getUsageStats();
    expect(stats['skill-a'].count).toBe(2);
    expect(stats['skill-b'].count).toBe(1);
    expect(typeof stats['skill-a'].lastUsedIso).toBe('string');
    expect(Date.parse(stats['skill-a'].lastUsedIso!)).not.toBeNaN();
  });

  it('recordUsage ignores empty input and never throws', () => {
    expect(() => loader.recordUsage([])).not.toThrow();
    expect(() => loader.recordUsage(['', ''] as any)).not.toThrow();
    expect(() => loader.recordUsage(null as any)).not.toThrow();
    // Empty names should not create phantom entries.
    expect(Object.keys(loader.getUsageStats())).toHaveLength(0);
  });

  it('matchSkills records a usage tick for each selected skill', async () => {
    await writeSkillFixture(skillsDir, 'core', 'matched-skill', {
      description: 'Matched',
      triggers: ['sparkletrigger'],
    });
    await writeSkillFixture(skillsDir, 'core', 'unmatched-skill', {
      description: 'Unmatched',
      triggers: ['nevermatched'],
    });
    await loader.loadAll();
    loader.matchSkills('please use the sparkletrigger now');
    const stats = loader.getUsageStats();
    expect(stats['matched-skill']?.count).toBe(1);
    expect(stats['unmatched-skill']).toBeUndefined();
  });

  it('the match path does not throw even if usage persistence fails', async () => {
    await writeSkillFixture(skillsDir, 'core', 'boom-skill', {
      description: 'Boom',
      triggers: ['boomtrigger'],
    });
    await loader.loadAll();
    // Force the internal persist scheduler to blow up; matchSkills must still
    // return results and not surface the error (recordUsage is try/catch'd).
    (loader as any).scheduleUsagePersist = () => { throw new Error('disk on fire'); };
    let results: string[] = [];
    expect(() => { results = loader.matchSkills('boomtrigger please'); }).not.toThrow();
    expect(results).toHaveLength(1);
    // Usage was still tallied in memory before the (simulated) persist failure.
    expect(loader.getUsageStats()['boom-skill']?.count).toBe(1);
  });
});
