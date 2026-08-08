import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, readFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { DocVersionService } from './doc-versions.js';

describe('DocVersionService', () => {
  let projectDir: string;
  let service: DocVersionService;
  const STEP_ID = '550e8400-e29b-41d4-a716-446655440000';

  beforeEach(async () => {
    projectDir = join(tmpdir(), `doc-versions-test-${Date.now()}`);
    await mkdir(projectDir, { recursive: true });
    service = new DocVersionService();
  });

  afterEach(async () => {
    if (existsSync(projectDir)) {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('appends a version and returns the version number', async () => {
    const content = 'Version 1 content';

    const v = await service.appendVersion(projectDir, STEP_ID, content);

    expect(v).toBe(1);
    const versionFile = join(projectDir, '.versions', STEP_ID, 'v1.md');
    expect(existsSync(versionFile)).toBe(true);
    const stored = await readFile(versionFile, 'utf-8');
    expect(stored).toBe(content);
  });

  it('increments version numbers correctly', async () => {
    const v1 = await service.appendVersion(projectDir, STEP_ID, 'V1');
    const v2 = await service.appendVersion(projectDir, STEP_ID, 'V2');
    const v3 = await service.appendVersion(projectDir, STEP_ID, 'V3');

    expect(v1).toBe(1);
    expect(v2).toBe(2);
    expect(v3).toBe(3);
  });

  it('stores version metadata in index', async () => {
    const v = await service.appendVersion(projectDir, STEP_ID, 'Test content', 'agent', 'Test note');
    const versions = await service.getVersions(projectDir, STEP_ID);

    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      v: 1,
      author: 'agent',
      note: 'Test note',
    });
    expect(versions[0].ts).toBeDefined();
    expect(versions[0].sha256).toBeDefined();
  });

  it('handles lazy migration from pre-existing file', async () => {
    const canonicalPath = join(projectDir, `${STEP_ID}-chapter-one.md`);
    const existingContent = 'Pre-fork content';

    // Create a pre-existing step file
    await mkdir(projectDir, { recursive: true });
    await writeFile(canonicalPath, existingContent, 'utf-8');

    // Request versions with canonicalPath — should trigger lazy migration
    const versions = await service.getVersions(projectDir, STEP_ID, canonicalPath);

    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      v: 1,
      author: 'agent',
      note: 'Seeded from pre-existing step file',
    });

    const v1Content = await service.getVersionContent(projectDir, STEP_ID, 1);
    expect(v1Content).toBe(existingContent);
  });

  it('restores an old version by creating a new version', async () => {
    const v1 = await service.appendVersion(projectDir, STEP_ID, 'Version 1');
    const v2 = await service.appendVersion(projectDir, STEP_ID, 'Version 2');
    const v3 = await service.restoreVersion(projectDir, STEP_ID, 1);

    expect(v3).toBe(3);

    const versions = await service.getVersions(projectDir, STEP_ID);
    expect(versions).toHaveLength(3);

    const restoredContent = await service.getVersionContent(projectDir, STEP_ID, 3);
    expect(restoredContent).toBe('Version 1');

    // Verify metadata indicates it was a restore
    expect(versions[2]).toMatchObject({
      author: 'agent-patch',
      note: 'Restored from v1',
      parentV: 2,
    });
  });

  it('retrieves specific version content', async () => {
    await service.appendVersion(projectDir, STEP_ID, 'Content A');
    await service.appendVersion(projectDir, STEP_ID, 'Content B');
    await service.appendVersion(projectDir, STEP_ID, 'Content C');

    const v1 = await service.getVersionContent(projectDir, STEP_ID, 1);
    const v2 = await service.getVersionContent(projectDir, STEP_ID, 2);
    const v3 = await service.getVersionContent(projectDir, STEP_ID, 3);

    expect(v1).toBe('Content A');
    expect(v2).toBe('Content B');
    expect(v3).toBe('Content C');
  });

  it('returns null for non-existent version', async () => {
    await service.appendVersion(projectDir, STEP_ID, 'Content');
    const nonExistent = await service.getVersionContent(projectDir, STEP_ID, 999);

    expect(nonExistent).toBeNull();
  });

  it('tracks current version correctly', async () => {
    let current = await service.getCurrentVersion(projectDir, STEP_ID);
    expect(current).toBe(0);

    await service.appendVersion(projectDir, STEP_ID, 'V1');
    current = await service.getCurrentVersion(projectDir, STEP_ID);
    expect(current).toBe(1);

    await service.appendVersion(projectDir, STEP_ID, 'V2');
    current = await service.getCurrentVersion(projectDir, STEP_ID);
    expect(current).toBe(2);
  });

  it('computes SHA256 hashes correctly', async () => {
    await service.appendVersion(projectDir, STEP_ID, 'Content A');
    await service.appendVersion(projectDir, STEP_ID, 'Content B');
    await service.appendVersion(projectDir, STEP_ID, 'Content A'); // Same as v1

    const versions = await service.getVersions(projectDir, STEP_ID);

    expect(versions[0].sha256).toBe(versions[2].sha256); // Same content, same hash
    expect(versions[0].sha256).not.toBe(versions[1].sha256); // Different content, different hash
  });

  it('version history is immutable', async () => {
    const v1 = await service.appendVersion(projectDir, STEP_ID, 'Original');
    const v1Content = await service.getVersionContent(projectDir, STEP_ID, 1);

    // Append new versions
    await service.appendVersion(projectDir, STEP_ID, 'V2');
    await service.appendVersion(projectDir, STEP_ID, 'V3');

    // Original version should remain unchanged
    const v1ContentAfter = await service.getVersionContent(projectDir, STEP_ID, 1);
    expect(v1ContentAfter).toBe(v1Content);
    expect(v1ContentAfter).toBe('Original');
  });

  it('survives a regenerate (version history persists)', async () => {
    // Simulate first generation
    await service.appendVersion(projectDir, STEP_ID, 'First generation');

    // Simulate a regenerate (new version appended)
    const v2 = await service.appendVersion(projectDir, STEP_ID, 'Regenerated version');

    // History should still be intact
    const versions = await service.getVersions(projectDir, STEP_ID);
    expect(versions).toHaveLength(2);
    expect(versions[0]).toMatchObject({ v: 1, author: 'agent' });
    expect(versions[1]).toMatchObject({ v: 2, author: 'agent' });
  });
});
