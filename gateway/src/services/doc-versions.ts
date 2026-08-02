/**
 * Document Versioning Service for AuthorAgent
 *
 * Immutable version history for step outputs. Storage structure:
 * - workspace/projects/<slug>/.versions/<stepId>/
 *   - v1.md, v2.md, ... (immutable version files)
 *   - index.json (metadata: entries with v, author, ts, note, parentV, sha256)
 * - workspace/projects/<slug>/<stepId>-<label>.md (canonical/current pointer,
 *   unchanged so compile/export-docx/epub-export/ContextEngine keep working)
 *
 * Migration is lazy: first time a pre-existing step's history is requested,
 * seed v1 from the current .md file — no batch migration, no downtime.
 *
 * Versioning is immutable. Restoring an old version creates a NEW version
 * with that content — it never rewrites history.
 *
 * Callers pass `stepId` explicitly rather than parsing it back out of the
 * canonical `<stepId>-<label>.md` filename — the label is free-text (itself
 * dash-slugified), so the split point between id and label can't be recovered
 * reliably once both are joined by dashes (e.g. step id `12-step-3` plus label
 * `write-chapter-3` collapse into one ambiguous dash-separated string).
 */

import { mkdir, writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { logger } from './logger.js';

const log = logger.child('[doc-versions]');

export type VersionAuthor = 'agent' | 'user' | 'agent-patch';

export interface VersionEntry {
  v: number;
  author: VersionAuthor;
  ts: number;
  note?: string;
  parentV?: number;
  sha256: string;
}

export class DocVersionService {
  /**
   * Append a new immutable version for a step and return its version number.
   */
  async appendVersion(
    projectDir: string,
    stepId: string,
    content: string,
    author: VersionAuthor = 'agent',
    note?: string,
  ): Promise<number> {
    const versionDir = this.getVersionDir(projectDir, stepId);
    await mkdir(versionDir, { recursive: true });

    const entries = await this.readIndex(versionDir);
    const parentV = entries.length ? entries[entries.length - 1].v : undefined;
    const v = (parentV ?? 0) + 1;

    await writeFile(join(versionDir, `v${v}.md`), content, 'utf-8');

    entries.push({
      v,
      author,
      ts: Date.now(),
      ...(note ? { note } : {}),
      ...(parentV ? { parentV } : {}),
      sha256: this.hashContent(content),
    });
    await this.writeIndex(versionDir, entries);

    log.debug(`Appended v${v} for step ${stepId} (author: ${author})`);
    return v;
  }

  /**
   * List a step's version history. `canonicalFilePath`, when passed, is the
   * flat `<stepId>-<label>.md` pointer file — used ONLY to lazily seed v1 the
   * first time history is requested for a step that predates versioning.
   */
  async getVersions(
    projectDir: string,
    stepId: string,
    canonicalFilePath?: string,
  ): Promise<VersionEntry[]> {
    const versionDir = this.getVersionDir(projectDir, stepId);
    let entries = await this.readIndex(versionDir);

    if (entries.length === 0 && canonicalFilePath && existsSync(canonicalFilePath)) {
      await this.seedV1FromExisting(projectDir, stepId, canonicalFilePath);
      entries = await this.readIndex(versionDir);
    }

    return entries;
  }

  /**
   * Restore an old version by creating a NEW version with that content.
   * Never mutates or rewrites the restored version.
   */
  async restoreVersion(projectDir: string, stepId: string, versionNumber: number): Promise<number> {
    const content = await this.getVersionContent(projectDir, stepId, versionNumber);
    if (content === null) {
      throw new Error(`Version v${versionNumber} not found for step ${stepId}`);
    }
    return this.appendVersion(projectDir, stepId, content, 'agent-patch', `Restored from v${versionNumber}`);
  }

  /** Get the content of a specific version, or null if it doesn't exist. */
  async getVersionContent(projectDir: string, stepId: string, versionNumber: number): Promise<string | null> {
    const versionFile = join(this.getVersionDir(projectDir, stepId), `v${versionNumber}.md`);
    if (!existsSync(versionFile)) return null;
    return readFile(versionFile, 'utf-8');
  }

  /** Get the current (highest) version number for a step, or 0 if none exist. */
  async getCurrentVersion(projectDir: string, stepId: string): Promise<number> {
    const entries = await this.readIndex(this.getVersionDir(projectDir, stepId));
    return entries.length ? entries[entries.length - 1].v : 0;
  }

  /** Seed v1 from an existing pre-versioning step file (lazy migration). */
  private async seedV1FromExisting(projectDir: string, stepId: string, canonicalFilePath: string): Promise<void> {
    const content = await readFile(canonicalFilePath, 'utf-8');
    await this.appendVersion(projectDir, stepId, content, 'agent', 'Seeded from pre-existing step file');
    log.debug(`Seeded v1 for step ${stepId} from ${canonicalFilePath}`);
  }

  private async readIndex(versionDir: string): Promise<VersionEntry[]> {
    const indexPath = join(versionDir, 'index.json');
    if (!existsSync(indexPath)) return [];
    try {
      return JSON.parse(await readFile(indexPath, 'utf-8'));
    } catch (err) {
      log.error(`Failed to parse ${indexPath}:`, err);
      return [];
    }
  }

  private async writeIndex(versionDir: string, entries: VersionEntry[]): Promise<void> {
    await writeFile(join(versionDir, 'index.json'), JSON.stringify(entries, null, 2), 'utf-8');
  }

  private hashContent(content: string): string {
    return createHash('sha256').update(content, 'utf-8').digest('hex');
  }

  private getVersionDir(projectDir: string, stepId: string): string {
    return join(projectDir, '.versions', stepId);
  }
}

export const docVersionService = new DocVersionService();
