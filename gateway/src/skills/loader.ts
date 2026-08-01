/**
 * AuthorAgent Skill Loader
 * Discovers, validates, and loads skills from the skills directory
 */

import { readFile, readdir, writeFile, mkdir, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { PermissionManager } from '../security/permissions.js';

export interface Skill {
  name: string;
  description: string;
  category: 'core' | 'author' | 'marketing' | 'premium' | 'ops';
  triggers: string[];
  permissions: string[];
  content: string;
}

export interface SkillCatalogEntry {
  name: string;
  description: string;
  category: string;
  triggers: string[];
  premium: boolean;
}

/** Per-skill usage tally: how many times matched + when last matched. */
export interface SkillUsageStat {
  count: number;
  lastUsedIso: string | null;
}

export class SkillLoader {
  private skillsDir: string;
  private permissions: PermissionManager;
  private skills: Map<string, Skill> = new Map();

  // ── Usage logging (Skill Curator, Hermes-pattern) ──
  // In-memory tally of which skills matchSkills() actually selected, mirrored
  // to a lightweight JSON under workspace/data/skill-usage.json via a debounced
  // atomic write (same shape as ContextEngine.debouncedPersist). The whole path
  // is best-effort — a failure to persist NEVER propagates into the match path.
  private usage: Map<string, SkillUsageStat> = new Map();
  private usagePath: string | null = null;
  private usageWriteTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param workspaceDir Optional. When provided, skill usage is persisted to
   *   `<workspaceDir>/data/skill-usage.json`. Tests / callers that omit it get
   *   in-memory-only usage tracking (no disk writes), matching how AIRouter
   *   makes its persistence store optional on the workspace dir.
   */
  constructor(skillsDir: string, permissions: PermissionManager, workspaceDir?: string) {
    this.skillsDir = skillsDir;
    this.permissions = permissions;
    this.usagePath = workspaceDir ? join(workspaceDir, 'data', 'skill-usage.json') : null;
    this.loadUsage();
  }

  /**
   * Load persisted usage counters from disk (best-effort, synchronous-free).
   * A missing / corrupt file simply starts the tally fresh — never throws.
   */
  private loadUsage(): void {
    if (!this.usagePath || !existsSync(this.usagePath)) return;
    try {
      // Fire-and-forget async read; usage stats are advisory, so a late load is
      // fine and we never want to block construction on disk I/O.
      readFile(this.usagePath, 'utf-8')
        .then((raw) => {
          const parsed = JSON.parse(raw);
          const rows = parsed?.skills && typeof parsed.skills === 'object' ? parsed.skills : {};
          for (const [name, stat] of Object.entries(rows)) {
            const s = stat as any;
            if (typeof s?.count === 'number') {
              this.usage.set(name, {
                count: s.count,
                lastUsedIso: typeof s.lastUsedIso === 'string' ? s.lastUsedIso : null,
              });
            }
          }
        })
        .catch(() => { /* advisory data — ignore */ });
    } catch { /* ignore */ }
  }

  /**
   * Record a usage tick for each named skill. Called by matchSkills() for the
   * skills it selected. Cheap + non-throwing: increments an in-memory counter
   * and schedules a debounced persist. Any failure is swallowed so usage
   * logging can never break message handling.
   */
  recordUsage(names: string[]): void {
    try {
      if (!Array.isArray(names) || names.length === 0) return;
      const nowIso = new Date().toISOString();
      for (const name of names) {
        if (!name) continue;
        const prev = this.usage.get(name);
        this.usage.set(name, { count: (prev?.count ?? 0) + 1, lastUsedIso: nowIso });
      }
      this.scheduleUsagePersist();
    } catch { /* never throw into the match path */ }
  }

  /**
   * Return a snapshot of usage stats keyed by skill name. Skills that have
   * never matched are absent (the curator treats absence as zero usage).
   */
  getUsageStats(): Record<string, SkillUsageStat> {
    const out: Record<string, SkillUsageStat> = {};
    for (const [name, stat] of this.usage) {
      out[name] = { count: stat.count, lastUsedIso: stat.lastUsedIso };
    }
    return out;
  }

  /** Debounced atomic write of the usage tally (tmp + rename), like context-engine. */
  private scheduleUsagePersist(): void {
    if (!this.usagePath || this.usageWriteTimer) return;
    this.usageWriteTimer = setTimeout(() => {
      this.usageWriteTimer = null;
      this.persistUsage().catch(() => { /* advisory — ignore */ });
    }, 2000);
  }

  private async persistUsage(): Promise<void> {
    if (!this.usagePath) return;
    try {
      await mkdir(join(this.usagePath, '..'), { recursive: true });
      const payload = { updatedAt: new Date().toISOString(), skills: this.getUsageStats() };
      const tmp = this.usagePath + '.tmp';
      await writeFile(tmp, JSON.stringify(payload, null, 2));
      await rename(tmp, this.usagePath);
    } catch { /* best-effort; usage data is advisory */ }
  }

  async loadAll(): Promise<void> {
    this.skills.clear();
    // Note: 'ops' was previously missing from this list, so Wave 2's ops
    // skills (decision-maker, task-planner, orchestrator-mgmt) and Wave 3's
    // browser-automation never actually loaded. Now included.
    for (const category of ['core', 'author', 'marketing', 'premium', 'ops'] as const) {
      const categoryDir = join(this.skillsDir, category);
      if (!existsSync(categoryDir)) continue;

      const entries = await readdir(categoryDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (entry.name.startsWith('{')) continue;

          const skillPath = join(categoryDir, entry.name, 'SKILL.md');
          if (existsSync(skillPath)) {
            try {
              const content = await readFile(skillPath, 'utf-8');
              const skill = this.parseSkill(content, entry.name, category);
              if (skill) {
                this.skills.set(skill.name, skill);
                if (category === 'premium') {
                  console.log(`  ★ Premium skill loaded: ${skill.name}`);
                }
              }
            } catch (error) {
              console.error(`  ⚠ Failed to load skill: ${entry.name}`, error);
            }
          }
        }
      }
    }
  }

  /**
   * Register synthetic skills generated at runtime — e.g., from Author OS tools.
   * No SKILL.md file is required; the data is provided directly.
   * Synthetic skills get category 'author' and are merged into the catalog.
   */
  registerSynthetic(skills: Array<{
    name: string;
    description: string;
    triggers: string[];
    permissions?: string[];
  }>): number {
    let added = 0;
    for (const s of skills) {
      if (!s.name || !s.description || !Array.isArray(s.triggers) || s.triggers.length === 0) continue;
      // Don't override an explicitly-authored SKILL.md of the same name.
      if (this.skills.has(s.name)) continue;
      this.skills.set(s.name, {
        name: s.name,
        description: s.description,
        category: 'author',
        triggers: s.triggers,
        permissions: s.permissions || ['memory_read'],
        content: `# ${s.name}\n\n${s.description}\n\n_(Auto-generated from Author OS tools.)_`,
      });
      added++;
    }
    return added;
  }

  /** Skills already warned about — dedupe so each skill warns once per process. */
  private warnedSkills: Set<string> = new Set();

  /**
   * Lightweight frontmatter validation. Warns (once per skill) about
   * missing/malformed fields; never throws — the skill still loads with
   * whatever could be parsed.
   */
  private validateFrontmatter(
    skillName: string,
    frontmatter: string,
    parsed: { description: string; triggers: string[]; permissions: string[] },
  ): void {
    if (this.warnedSkills.has(skillName)) return;
    const problems: string[] = [];
    for (const field of ['name', 'description', 'author', 'version', 'triggers', 'permissions']) {
      if (!new RegExp(`^${field}:`, 'm').test(frontmatter)) problems.push(`missing "${field}"`);
    }
    if (!parsed.description) problems.push('empty description');
    if (parsed.triggers.length === 0) problems.push('no triggers parsed');
    if (problems.length > 0) {
      this.warnedSkills.add(skillName);
      console.warn(`  ⚠ Skill "${skillName}" frontmatter issues: ${problems.join(', ')}`);
    }
  }

  private parseSkill(content: string, name: string, category: 'core' | 'author' | 'marketing' | 'premium' | 'ops'): Skill | null {
    // Parse YAML frontmatter
    // Note: tolerate CRLF line endings (\r\n) — a checkout with git's Windows
    // default `core.autocrlf=true` produces \r\n-terminated SKILL.md files,
    // and a bare \n-only regex here silently fails to match every skill.
    const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!frontmatterMatch) {
      if (!this.warnedSkills.has(name)) {
        this.warnedSkills.add(name);
        console.warn(`  ⚠ Skill "${name}" has no YAML frontmatter — skipped`);
      }
      return null;
    }

    const frontmatter = frontmatterMatch[1];
    const triggers: string[] = [];
    const permissions: string[] = [];
    let description = '';
    let currentSection = '';

    for (const line of frontmatter.split('\n')) {
      const trimmed = line.trim();

      // Track which YAML key we're under
      if (trimmed.match(/^\w/)) {
        if (trimmed.startsWith('description:')) {
          description = trimmed.replace('description:', '').trim();
          currentSection = 'description';
        } else if (trimmed.startsWith('triggers:')) {
          currentSection = 'triggers';
        } else if (trimmed.startsWith('permissions:')) {
          currentSection = 'permissions';
        } else {
          currentSection = '';
        }
        continue;
      }

      // Parse list items under the current section
      if (trimmed.startsWith('- ')) {
        const value = trimmed.replace(/^- ["']?|["']$/g, '').trim();
        if (currentSection === 'triggers') {
          triggers.push(value);
        } else if (currentSection === 'permissions') {
          permissions.push(value);
        }
      }
    }

    this.validateFrontmatter(name, frontmatter, { description, triggers, permissions });
    return { name, description, category, triggers, permissions, content };
  }

  /**
   * Match skills against user input, ranked by match quality, capped at the
   * top MAX_MATCHED_SKILLS, with a total injected-content budget so skill
   * bodies can't bloat the system prompt unbounded.
   *
   * Returns an array of prompt-ready strings (backward-compatible shape:
   * callers join these into the system prompt).
   */
  matchSkills(input: string): string[] {
    // Raised from 3/8,000 now that the claude-cli provider carries far less
    // dead weight per call (~28,800 tokens of Claude Code's own agentic
    // scaffolding removed — see router.ts's buildClaudeCliArgs) and
    // MemoryService.getRelevant() is bounded (was unbounded up to 50,000
    // chars, now capped at 8,000). This budget is what actually reaches the
    // model as craft guidance — the loader was previously logging
    // "body truncated" / "body omitted — prompt budget exhausted" under the
    // old cap, meaning skill content was losing to prompt bloat.
    const MAX_MATCHED_SKILLS = 5;
    const CONTENT_BUDGET_CHARS = 15000;

    const lower = input.toLowerCase();
    const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // ── Score every skill ──
    const scored: Array<{ skill: Skill; score: number }> = [];
    for (const [, skill] of this.skills) {
      let score = 0;
      let hits = 0;
      for (const trigger of skill.triggers) {
        const t = trigger.toLowerCase().trim();
        if (!t || !lower.includes(t)) continue;
        hits++;
        // Exact word/phrase match (bounded by non-word chars) beats substring.
        const wordBounded = new RegExp(`(^|[^a-z0-9])${escapeRe(t)}([^a-z0-9]|$)`).test(lower);
        // Longer trigger matches are more specific → score higher.
        score += (wordBounded ? 10 : 4) + Math.min(t.length, 30) / 3;
      }
      if (hits > 0) {
        // Multiple trigger hits → stronger signal.
        score += (hits - 1) * 5;
        scored.push({ skill, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, MAX_MATCHED_SKILLS);

    // ── Usage logging ── record a tick for every skill we selected. Guarded
    // internally so a persistence failure can never throw into this hot path.
    this.recordUsage(top.map(({ skill }) => skill.name));

    // ── Assemble within budget ──
    const results: string[] = [];
    let used = 0;
    for (const { skill } of top) {
      // Description header is always included, regardless of budget.
      const header = `## Skill: ${skill.name}\n${skill.description}\n`;
      used += header.length;

      const remaining = CONTENT_BUDGET_CHARS - used;
      if (skill.content.length <= remaining) {
        results.push(header + '\n' + skill.content);
        used += skill.content.length;
      } else if (remaining > 200) {
        const cut = skill.content.length - remaining;
        results.push(header + '\n' + skill.content.slice(0, remaining) + '\n[truncated]');
        used = CONTENT_BUDGET_CHARS;
        console.log(`  ⚠ Skill "${skill.name}" body truncated by ${cut} chars to fit ${CONTENT_BUDGET_CHARS}-char prompt budget`);
      } else {
        // Budget exhausted — description only.
        results.push(header);
        console.log(`  ⚠ Skill "${skill.name}" body omitted (${skill.content.length} chars) — prompt budget exhausted`);
      }
    }

    return results;
  }

  getLoadedCount(): number {
    return this.skills.size;
  }

  getAuthorSkillCount(): number {
    return Array.from(this.skills.values()).filter(s => s.category === 'author').length;
  }

  getPremiumSkillCount(): number {
    return Array.from(this.skills.values()).filter(s => s.category === 'premium').length;
  }

  getPremiumSkills(): Array<{ name: string; description: string }> {
    return Array.from(this.skills.values())
      .filter(s => s.category === 'premium')
      .map(s => ({ name: s.name, description: s.description }));
  }

  /**
   * Return a lightweight catalog of all loaded skills (for AI task planning).
   * Includes name, description, triggers, category — but NOT the full content.
   */
  getSkillCatalog(): SkillCatalogEntry[] {
    return Array.from(this.skills.values()).map(s => ({
      name: s.name,
      description: s.description,
      category: s.category,
      triggers: s.triggers,
      premium: s.category === 'premium',
    }));
  }

  /**
   * Get a specific skill by name (returns full content for injection into prompt).
   */
  getSkillByName(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  /**
   * Get skills grouped by category for dashboard display.
   */
  getSkillsByCategory(): Record<string, Array<{ name: string; description: string }>> {
    const grouped: Record<string, Array<{ name: string; description: string }>> = {};
    for (const skill of this.skills.values()) {
      if (!grouped[skill.category]) grouped[skill.category] = [];
      grouped[skill.category].push({ name: skill.name, description: skill.description });
    }
    return grouped;
  }
}
