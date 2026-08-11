import { describe, it, expect } from 'vitest';
import { basename, join, resolve, sep } from 'path';
import { resolveWithin, safeResolveWithin, sanitizeSegment, isWithin } from './paths.js';

describe('resolveWithin', () => {
  const base = resolve('workspace', 'project');

  it('joins a normal single segment inside the base', () => {
    const result = resolveWithin(base, 'file.txt');
    expect(result).toBe(join(base, 'file.txt'));
  });

  it('joins multiple normal segments inside the base', () => {
    const result = resolveWithin(base, 'sub', 'dir', 'file.txt');
    expect(result).toBe(join(base, 'sub', 'dir', 'file.txt'));
  });

  it('returns the base itself when no segments are given', () => {
    const result = resolveWithin(base);
    expect(result).toBe(base);
  });

  it('allows a segment that resolves back to exactly the base', () => {
    const result = resolveWithin(base, '.');
    expect(result).toBe(base);
  });

  it('blocks simple ../ traversal', () => {
    expect(() => resolveWithin(base, '..', 'outside.txt')).toThrow('Path escapes base directory');
  });

  it('blocks nested ../../ traversal', () => {
    expect(() => resolveWithin(base, 'a', '..', '..', 'etc', 'passwd')).toThrow('Path escapes base directory');
  });

  it('blocks traversal using forward slashes', () => {
    expect(() => resolveWithin(base, '../secrets.txt')).toThrow('Path escapes base directory');
  });

  it.runIf(process.platform === 'win32')('blocks traversal using backslashes', () => {
    expect(() => resolveWithin(base, '..\\secrets.txt')).toThrow('Path escapes base directory');
  });

  it('blocks traversal embedded in a single segment with mixed slashes', () => {
    expect(() => resolveWithin(base, 'sub/../../escape')).toThrow('Path escapes base directory');
  });

  it('blocks a sibling directory that shares a string prefix with base', () => {
    // e.g. base = /workspace/project, sibling = /workspace/project-evil
    // A naive `startsWith(base)` check (without separator) would wrongly allow this.
    const sibling = resolve(base, '..', `${basename(base)}-evil`);
    expect(() => resolveWithin(base, '..', 'project-evil', 'file.txt')).toThrow();
    // Direct absolute-path segment sanity check via resolve() semantics:
    expect(resolve(base, '..', 'project-evil')).toBe(sibling);
  });

  it('rejects null bytes in a segment', () => {
    expect(() => resolveWithin(base, 'file\x00.txt')).toThrow('Path contains null byte');
  });

  it('rejects null bytes even in a later segment', () => {
    expect(() => resolveWithin(base, 'ok', 'bad\x00')).toThrow('Path contains null byte');
  });

  it('rejects non-string segments', () => {
    // @ts-expect-error intentional bad input for runtime guard test
    expect(() => resolveWithin(base, 123)).toThrow('Path segment must be a string');
  });

  it('is case-insensitive on win32/darwin for the boundary check', () => {
    if (process.platform === 'win32' || process.platform === 'darwin') {
      const upperBase = base.toUpperCase();
      // Resolving within an upper-cased version of the base should still work
      // and stay considered "inside" per normalizeForCompare's lower-casing.
      const result = resolveWithin(upperBase, 'file.txt');
      expect(result.toLowerCase()).toBe(join(upperBase, 'file.txt').toLowerCase());
    } else {
      expect(true).toBe(true); // N/A on case-sensitive filesystems
    }
  });

  it('preserves original casing/separators of the resolved result', () => {
    const result = resolveWithin(base, 'MixedCase', 'File.TXT');
    expect(result).toBe(join(base, 'MixedCase', 'File.TXT'));
  });
});

describe('safeResolveWithin', () => {
  const base = resolve('workspace', 'project');

  it('returns the resolved path for a safe segment', () => {
    expect(safeResolveWithin(base, 'ok.txt')).toBe(join(base, 'ok.txt'));
  });

  it('returns null instead of throwing on traversal', () => {
    expect(safeResolveWithin(base, '..', 'outside.txt')).toBeNull();
  });

  it('returns null instead of throwing on null byte', () => {
    expect(safeResolveWithin(base, 'bad\x00.txt')).toBeNull();
  });
});

describe('sanitizeSegment', () => {
  it('preserves a normal filename unchanged', () => {
    expect(sanitizeSegment('chapter-one.docx')).toBe('chapter-one.docx');
  });

  it('preserves normal names with spaces', () => {
    expect(sanitizeSegment('My Manuscript Draft.txt')).toBe('My Manuscript Draft.txt');
  });

  it('strips forward slashes', () => {
    expect(sanitizeSegment('a/b/c')).toBe('a_b_c');
  });

  it('strips backslashes', () => {
    expect(sanitizeSegment('a\\b\\c')).toBe('a_b_c');
  });

  it('strips mixed slashes', () => {
    expect(sanitizeSegment('a/b\\c')).toBe('a_b_c');
  });

  it('collapses ".." runs rather than leaving them intact', () => {
    const result = sanitizeSegment('..');
    // ".." collapses to "_" via the /\.{2,}/ rule, then since it isn't
    // all dots/spaces/underscores... "_" IS all-underscore, so falls back.
    expect(result).toBe('file');
  });

  it('falls back on a dots-only name', () => {
    expect(sanitizeSegment('...')).toBe('file');
  });

  it('falls back on an empty string', () => {
    expect(sanitizeSegment('')).toBe('file');
  });

  it('falls back on whitespace-only input', () => {
    expect(sanitizeSegment('   ')).toBe('file');
  });

  it('respects a custom fallback', () => {
    expect(sanitizeSegment('', 'default-name')).toBe('default-name');
    expect(sanitizeSegment('...', 'default-name')).toBe('default-name');
  });

  it('strips null bytes and control characters', () => {
    expect(sanitizeSegment('a\x00b\x01c.txt')).toBe('abc.txt');
  });

  it('strips Windows-illegal characters', () => {
    expect(sanitizeSegment('a:b*c?d"e<f>g|h')).toBe('a_b_c_d_e_f_g_h');
  });

  it('strips leading dots (hidden file style)', () => {
    expect(sanitizeSegment('.hidden')).toBe('hidden');
  });

  it('rejects reserved Windows device name CON', () => {
    expect(sanitizeSegment('CON')).toBe('file');
  });

  it('rejects reserved Windows device name CON regardless of case', () => {
    expect(sanitizeSegment('con')).toBe('file');
    expect(sanitizeSegment('CoN')).toBe('file');
  });

  it('rejects reserved Windows device name PRN with an extension', () => {
    expect(sanitizeSegment('PRN.txt')).toBe('file');
  });

  it('rejects reserved Windows device name NUL', () => {
    expect(sanitizeSegment('NUL')).toBe('file');
    expect(sanitizeSegment('nul.txt')).toBe('file');
  });

  it('rejects reserved Windows device names COM1-9 and LPT1-9', () => {
    expect(sanitizeSegment('COM1')).toBe('file');
    expect(sanitizeSegment('lpt9.txt')).toBe('file');
  });

  it('does not reject names that merely contain a reserved word', () => {
    // "console.txt" base name before first dot is "console", not "con" — must NOT be rejected.
    expect(sanitizeSegment('console.txt')).toBe('console.txt');
  });

  it('caps length at 200 characters', () => {
    const long = 'a'.repeat(300);
    const result = sanitizeSegment(long);
    expect(result.length).toBe(200);
  });

  it('coerces non-string-ish input via String(name ?? "")', () => {
    // @ts-expect-error intentional bad input for runtime guard test
    expect(sanitizeSegment(null)).toBe('file');
    // @ts-expect-error intentional bad input for runtime guard test
    expect(sanitizeSegment(undefined)).toBe('file');
  });
});

describe('isWithin', () => {
  const base = resolve('repo-root');

  it('is true for a direct child', () => {
    expect(isWithin(base, join(base, 'books', 'workspace'))).toBe(true);
  });

  it('is true for the base itself', () => {
    expect(isWithin(base, base)).toBe(true);
  });

  it('is false for a sibling directory', () => {
    expect(isWithin(base, resolve('repo-root-sibling'))).toBe(false);
  });

  it('is false for the parent of the base', () => {
    expect(isWithin(base, resolve('.'))).toBe(false);
  });

  it('is false for a directory that merely shares a name prefix', () => {
    // "repo-root-2" starts with "repo-root" as a string but is not inside it.
    expect(isWithin(base, resolve('repo-root-2', 'sub'))).toBe(false);
  });

  it('normalizes mixed separators the same way resolveWithin does', () => {
    const target = base + '\\books\\workspace';
    expect(isWithin(base, target)).toBe(true);
  });
});
