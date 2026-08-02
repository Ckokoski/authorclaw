/**
 * Document Versioning Service for AuthorAgent
 *
 * Immutable version history for step outputs. Storage structure:
 * - workspace/projects/<slug>/.versions/<stepId>/
 *   - v1.md, v2.md, ... (immutable version files)
 *   - index.json (metadata: entries with v, author, ts, note, parentV, sha256)
 * - workspace/projects/<slug>/<stepId>-<label>.md (canonical/current pointer)
 *
 * Migration is lazy: first time a pre-existing step's history is requested,
 * seed v1 from the current .md file without downtime.
 *
 * Versioning is immutable. Restoring an old version creates a NEW version
 * with that content — it never rewrites history.
 */

import { mkdir, writeFile, readFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';
import { logger } from './logger.js';

const log = logger.child('[doc-versions]');

interface VersionEntry {
  v: number;
  author: 'agent' | 'user' | 'agent-patch';
  ts: number;
  note?: string;
  parentV?: number;
  sha256: string;
}

interface VersionIndex {
  entries: VersionEntry[];
  currentV: number;
}

export class DocVersionService {
  /**
   * Append a new version for a step. Returns the version number.
   * Author: 'agent' for AI-generated, 'user' for manual edits, 'agent-patch' for auto-corrections.
   */
  async appendVersion(
    stepFilePath: string,
    content: string,
    author: 'agent' | 'user' | 'agent-patch' = 'agent',
    note?: string
  ): Promise<number> {
    try {
      const versionDir = this.getVersionDir(stepFilePath);
      const indexPath = join(versionDir, 'index.json');

      // Ensure version directory exists
      await mkdir(versionDir, { recursive: true });

      // Read or create the index
      let index: VersionIndex;
      if (existsSync(indexPath)) {
        const indexData = await readFile(indexPath, 'utf-8');
        index = JSON.parse(indexData);
      } else {
        // Check if this is a pre-existing step (needs lazy migration)
        if (existsSync(stepFilePath)) {
          await this.seedV1FromExisting(stepFilePath, versionDir, indexPath);
          const indexData = await readFile(indexPath, 'utf-8');
          index = JSON.parse(indexData);
        } else {
          index = { entries: [], currentV: 0 };
        }
      }

      // Compute next version number and SHA256
      const nextV = index.currentV + 1;
      const sha = this.hashContent(content);
      const parentV = index.currentV > 0 ? index.currentV : undefined;

      // Write the version file
      const versionFile = join(versionDir, `v${nextV}.md`);
      await writeFile(versionFile, content, 'utf-8');

      // Update index
      const entry: VersionEntry = {
        v: nextV,
        author,
        ts: Date.now(),
        ...(note && { note }),
        ...(parentV && { parentV }),
        sha256: sha,
      };
      index.entries.push(entry);
      index.currentV = nextV;

      await writeFile(indexPath, JSON.stringify(index, null, 2), 'utf-8');

      log.debug(`Appended v${nextV} for ${stepFilePath} (author: ${author})`);
      return nextV;
    } catch (err) {
      log.error(`Failed to append version for ${stepFilePath}:`, err);
      throw err;
    }
  }

  /**
   * Get the list of all versions for a step.
   */
  async getVersions(stepFilePath: string): Promise<VersionEntry[]> {
    try {
      const indexPath = join(this.getVersionDir(stepFilePath), 'index.json');

      if (!existsSync(indexPath)) {
        // Lazy migration: check if the step file exists and seed v1
        if (existsSync(stepFilePath)) {
          const versionDir = this.getVersionDir(stepFilePath);
          await this.seedV1FromExisting(stepFilePath, versionDir, indexPath);
        } else {
          return [];
        }
      }

      const indexData = await readFile(indexPath, 'utf-8');
      const index: VersionIndex = JSON.parse(indexData);
      return index.entries;
    } catch (err) {
      log.error(`Failed to get versions for ${stepFilePath}:`, err);
      return [];
    }
  }

  /**
   * Restore an old version by creating a NEW version with that content.
   * Never mutates history.
   */
  async restoreVersion(stepFilePath: string, versionNumber: number): Promise<number> {
    try {
      const versionDir = this.getVersionDir(stepFilePath);
      const sourceFile = join(versionDir, `v${versionNumber}.md`);

      if (!existsSync(sourceFile)) {
        throw new Error(`Version ${versionNumber} not found`);
      }

      const content = await readFile(sourceFile, 'utf-8');
      const newV = await this.appendVersion(
        stepFilePath,
        content,
        'agent-patch',
        `Restored from v${versionNumber}`
      );

      return newV;
    } catch (err) {
      log.error(`Failed to restore version for ${stepFilePath}:`, err);
      throw err;
    }
  }

  /**
   * Get the content of a specific version.
   */
  async getVersionContent(stepFilePath: string, versionNumber: number): Promise<string | null> {
    try {
      const versionFile = join(this.getVersionDir(stepFilePath), `v${versionNumber}.md`);
      if (!existsSync(versionFile)) return null;
      return await readFile(versionFile, 'utf-8');
    } catch (err) {
      log.error(`Failed to read version ${versionNumber} for ${stepFilePath}:`, err);
      return null;
    }
  }

  /**
   * Get the current version number for a step.
   */
  async getCurrentVersion(stepFilePath: string): Promise<number> {
    try {
      const indexPath = join(this.getVersionDir(stepFilePath), 'index.json');

      if (!existsSync(indexPath)) {
        if (existsSync(stepFilePath)) {
          const versionDir = this.getVersionDir(stepFilePath);
          await this.seedV1FromExisting(stepFilePath, versionDir, indexPath);
        } else {
          return 0;
        }
      }

      const indexData = await readFile(indexPath, 'utf-8');
      const index: VersionIndex = JSON.parse(indexData);
      return index.currentV;
    } catch (err) {
      log.error(`Failed to get current version for ${stepFilePath}:`, err);
      return 0;
    }
  }

  /**
   * Private: seed v1 from an existing step file (lazy migration).
   * Called the first time history is requested for a pre-existing step.
   */
  private async seedV1FromExisting(
    stepFilePath: string,
    versionDir: string,
    indexPath: string
  ): Promise<void> {
    try {
      // Read the existing step file
      const content = await readFile(stepFilePath, 'utf-8');
      const sha = this.hashContent(content);

      // Write it as v1
      await mkdir(versionDir, { recursive: true });
      await writeFile(join(versionDir, 'v1.md'), content, 'utf-8');

      // Create the index
      const index: VersionIndex = {
        entries: [
          {
            v: 1,
            author: 'agent',
            ts: Date.now(),
            note: 'Seeded from pre-existing step file',
            sha256: sha,
          },
        ],
        currentV: 1,
      };

      await writeFile(indexPath, JSON.stringify(index, null, 2), 'utf-8');
      log.debug(`Seeded v1 from existing ${stepFilePath}`);
    } catch (err) {
      log.error(`Failed to seed v1 from ${stepFilePath}:`, err);
      throw err;
    }
  }

  /**
   * Private: compute SHA256 hash of content for integrity checking.
   */
  private hashContent(content: string): string {
    return createHash('sha256').update(content, 'utf-8').digest('hex');
  }

  /**
   * Private: compute the version directory path for a step file.
   * step-file: workspace/projects/<slug>/<stepId>-<label>.md
   * version-dir: workspace/projects/<slug>/.versions/<stepId>/
   *
   * stepId extraction: the format is always "${activeStep.id}-${label}". The stepId
   * part is either:
   *   - A full UUID like "550e8400-e29b-41d4-a716-446655440000" (4 dashes, 5 parts)
   *   - A short ID like "abc123" (no dashes, 1 part)
   *
   * Heuristic: if the first dash-separated part is 8 hex characters, treat it as
   * a UUID and extract the first 5 parts (the full UUID). Otherwise, take just
   * the first part (the short ID).
   */
  private getVersionDir(stepFilePath: string): string {
    const dir = dirname(stepFilePath);
    const fileName = stepFilePath.replace(/\\/g, '/').split('/').pop() || 'unknown';
    // Remove .md extension
    const nameWithoutExt = fileName.replace(/\.md$/, '');
    const parts = nameWithoutExt.split('-');

    let stepId: string;
    if (parts.length === 1) {
      // No dashes — the whole thing is the ID
      stepId = nameWithoutExt;
    } else if (/^[0-9a-f]{8}$/.test(parts[0])) {
      // First part looks like UUID segment (8 hex chars) — extract full UUID (5 parts)
      stepId = parts.slice(0, Math.min(5, parts.length)).join('-');
    } else {
      // Short ID without UUID format — take just the first part
      stepId = parts[0];
    }

    return join(dir, '.versions', stepId);
  }
}

export const docVersionService = new DocVersionService();
