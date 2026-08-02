import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, readFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { DocVersionService } from './doc-versions.js';

describe('DocVersionService', () => {
  let tempDir: string;
  let service: DocVersionService;
  const TEST_STEP_ID = '550e8400-e29b-41d4-a716-446655440000';

  beforeEach(async () => {
    tempDir = join(tmpdir(), `doc-versions-test-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
    service = new DocVersionService();
  });

  afterEach(async () => {
    if (existsSync(tempDir)) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('appends a version and returns the version number', async () => {
    const stepFilePath = join(tempDir, 'abc123-step-label.md');
    const content = 'Version 1 content';

    const v = await service.appendVersion(stepFilePath, content);

    expect(v).toBe(1);
    const versionFile = join(tempDir, '.versions', 'abc123', 'v1.md');
    expect(existsSync(versionFile)).toBe(true);
    const stored = await readFile(versionFile, 'utf-8');
    expect(stored).toBe(content);
  });

  it('increments version numbers correctly', async () => {
    const stepFilePath = join(tempDir, 'abc123-step-label.md');

    const v1 = await service.appendVersion(stepFilePath, 'V1');
    const v2 = await service.appendVersion(stepFilePath, 'V2');
    const v3 = await service.appendVersion(stepFilePath, 'V3');

    expect(v1).toBe(1);
    expect(v2).toBe(2);
    expect(v3).toBe(3);
  });

  it('stores version metadata in index', async () => {
    const stepFilePath = join(tempDir, 'abc123-step-label.md');

    const v = await service.appendVersion(stepFilePath, 'Test content', 'agent', 'Test note');
    const versions = await service.getVersions(stepFilePath);

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
    const stepFilePath = join(tempDir, 'xyz789-existing-step.md');
    const existingContent = 'Pre-fork content';

    // Create a pre-existing step file
    await writeFile(stepFilePath, existingContent, 'utf-8');

    // Request versions — should trigger lazy migration
    const versions = await service.getVersions(stepFilePath);

    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      v: 1,
      author: 'agent',
      note: 'Seeded from pre-existing step file',
    });

    const v1Content = await service.getVersionContent(stepFilePath, 1);
    expect(v1Content).toBe(existingContent);
  });

  it('restores an old version by creating a new version', async () => {
    const stepFilePath = join(tempDir, 'def456-restore-test.md');

    const v1 = await service.appendVersion(stepFilePath, 'Version 1');
    const v2 = await service.appendVersion(stepFilePath, 'Version 2');
    const v3 = await service.restoreVersion(stepFilePath, 1);

    expect(v3).toBe(3);

    const versions = await service.getVersions(stepFilePath);
    expect(versions).toHaveLength(3);

    const restoredContent = await service.getVersionContent(stepFilePath, 3);
    expect(restoredContent).toBe('Version 1');

    // Verify metadata indicates it was a restore
    expect(versions[2]).toMatchObject({
      author: 'agent-patch',
      note: 'Restored from v1',
      parentV: 2,
    });
  });

  it('retrieves specific version content', async () => {
    const stepFilePath = join(tempDir, 'ghi789-retrieve-test.md');

    await service.appendVersion(stepFilePath, 'Content A');
    await service.appendVersion(stepFilePath, 'Content B');
    await service.appendVersion(stepFilePath, 'Content C');

    const v1 = await service.getVersionContent(stepFilePath, 1);
    const v2 = await service.getVersionContent(stepFilePath, 2);
    const v3 = await service.getVersionContent(stepFilePath, 3);

    expect(v1).toBe('Content A');
    expect(v2).toBe('Content B');
    expect(v3).toBe('Content C');
  });

  it('returns null for non-existent version', async () => {
    const stepFilePath = join(tempDir, 'jkl012-nonexist-test.md');

    await service.appendVersion(stepFilePath, 'Content');
    const nonExistent = await service.getVersionContent(stepFilePath, 999);

    expect(nonExistent).toBeNull();
  });

  it('tracks current version correctly', async () => {
    const stepFilePath = join(tempDir, 'mno345-current-test.md');

    let current = await service.getCurrentVersion(stepFilePath);
    expect(current).toBe(0);

    await service.appendVersion(stepFilePath, 'V1');
    current = await service.getCurrentVersion(stepFilePath);
    expect(current).toBe(1);

    await service.appendVersion(stepFilePath, 'V2');
    current = await service.getCurrentVersion(stepFilePath);
    expect(current).toBe(2);
  });

  it('computes SHA256 hashes correctly', async () => {
    const stepFilePath = join(tempDir, 'pqr678-hash-test.md');

    await service.appendVersion(stepFilePath, 'Content A');
    await service.appendVersion(stepFilePath, 'Content B');
    await service.appendVersion(stepFilePath, 'Content A'); // Same as v1

    const versions = await service.getVersions(stepFilePath);

    expect(versions[0].sha256).toBe(versions[2].sha256); // Same content, same hash
    expect(versions[0].sha256).not.toBe(versions[1].sha256); // Different content, different hash
  });

  it('version history is immutable', async () => {
    const stepFilePath = join(tempDir, 'stu901-immutable-test.md');

    const v1 = await service.appendVersion(stepFilePath, 'Original');
    const v1Content = await service.getVersionContent(stepFilePath, 1);

    // Append new versions
    await service.appendVersion(stepFilePath, 'V2');
    await service.appendVersion(stepFilePath, 'V3');

    // Original version should remain unchanged
    const v1ContentAfter = await service.getVersionContent(stepFilePath, 1);
    expect(v1ContentAfter).toBe(v1Content);
    expect(v1ContentAfter).toBe('Original');
  });

  it('survives a regenerate (version history persists)', async () => {
    const stepFilePath = join(tempDir, 'vwx234-regenerate-test.md');

    // Simulate first generation
    await service.appendVersion(stepFilePath, 'First generation');

    // Simulate a regenerate (new version appended)
    const v2 = await service.appendVersion(stepFilePath, 'Regenerated version');

    // History should still be intact
    const versions = await service.getVersions(stepFilePath);
    expect(versions).toHaveLength(2);
    expect(versions[0]).toMatchObject({ v: 1, author: 'agent' });
    expect(versions[1]).toMatchObject({ v: 2, author: 'agent' });
  });
});
