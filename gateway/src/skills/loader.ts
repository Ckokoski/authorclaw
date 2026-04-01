/**
 * AuthorClaw Skill Loader
 * Discovers, validates, and loads skills from the skills directory
 */

import { readFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { PermissionManager } from '../security/permissions.js';

export interface Skill {
  name: string;
  description: string;
  category: 'core' | 'author' | 'marketing' | 'premium';
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

export class SkillLoader {
  private skillsDir: string;
  private permissions: PermissionManager;
  private skills: Map<string, Skill> = new Map();

  constructor(skillsDir: string, permissions: PermissionManager) {
    this.skillsDir = skillsDir;
    this.permissions = permissions;
  }

  async loadAll(): Promise<void> {
    this.skills.clear();
    for (const category of ['core', 'author', 'marketing', 'premium'] as const) {
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

  private parseSkill(content: string, name: string, category: 'core' | 'author' | 'marketing' | 'premium'): Skill | null {
    // Parse YAML frontmatter
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) return null;

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

    return { name, description, category, triggers, permissions, content };
  }

  matchSkills(input: string): string[] {
    const matched: string[] = [];
    const lower = input.toLowerCase();

    for (const [, skill] of this.skills) {
      for (const trigger of skill.triggers) {
        if (lower.includes(trigger.toLowerCase())) {
          matched.push(skill.content);
          break;
        }
      }
    }

    return matched;
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
