import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parseSections,
  addComment,
  listComments,
  setCommentStatus,
  reanchorComments,
  formatOpenCommentsForAgent,
  CommentValidationError,
  type SpanAnchor,
} from './comments.js';

describe('parseSections', () => {
  it('splits content into ## heading blocks', () => {
    const content = '# Step Label\n\nintro\n\n## Chapter 1\n\nfirst chapter body\n\n## Chapter 2\n\nsecond chapter body';
    const sections = parseSections(content);
    expect(sections.map((s) => s.heading)).toEqual(['Chapter 1', 'Chapter 2']);
    expect(sections[0].id).toBe('chapter-1');
    expect(sections[1].id).toBe('chapter-2');
    expect(sections[0].text).toContain('first chapter body');
    expect(sections[0].text).not.toContain('second chapter body');
  });

  it('disambiguates duplicate headings', () => {
    const content = '## Notes\n\na\n\n## Notes\n\nb';
    const sections = parseSections(content);
    expect(sections.map((s) => s.id)).toEqual(['notes', 'notes-2']);
  });
});

describe('CommentService', () => {
  let projectDir: string;
  const STEP_ID = 'step-1';
  const CONTENT_V1 =
    '# Chapter Draft\n\n## Chapter 1\n\nThe door slammed shut behind her, echoing down the empty hall.\n\n## Chapter 2\n\nMorning came quietly.';

  beforeEach(async () => {
    projectDir = join(tmpdir(), `comments-test-${Math.random().toString(36).slice(2)}`);
    await mkdir(projectDir, { recursive: true });
  });

  afterEach(async () => {
    if (existsSync(projectDir)) await rm(projectDir, { recursive: true, force: true });
  });

  it('adds a section comment', async () => {
    const comment = await addComment(projectDir, STEP_ID, CONTENT_V1, {
      type: 'section',
      sectionId: 'chapter-1',
      body: 'This chapter feels rushed.',
    });
    expect(comment.anchor).toEqual({ type: 'section', sectionId: 'chapter-1' });
    expect(comment.status).toBe('open');

    const listed = await listComments(projectDir, STEP_ID);
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(comment.id);
  });

  it('rejects a comment anchored to an unknown section', async () => {
    await expect(
      addComment(projectDir, STEP_ID, CONTENT_V1, { type: 'section', sectionId: 'nope', body: 'x' }),
    ).rejects.toThrow(CommentValidationError);
  });

  it('adds a span comment and rejects a quote not present in the section', async () => {
    const comment = await addComment(projectDir, STEP_ID, CONTENT_V1, {
      type: 'span',
      sectionId: 'chapter-1',
      quote: 'The door slammed shut',
      prefixContext: '',
      suffixContext: ' behind her',
      body: 'Too melodramatic.',
    });
    expect(comment.anchor.type).toBe('span');

    await expect(
      addComment(projectDir, STEP_ID, CONTENT_V1, {
        type: 'span',
        sectionId: 'chapter-1',
        quote: 'this text does not exist',
        prefixContext: '',
        suffixContext: '',
        body: 'x',
      }),
    ).rejects.toThrow(CommentValidationError);
  });

  it('resolves and reopens a comment', async () => {
    const comment = await addComment(projectDir, STEP_ID, CONTENT_V1, {
      type: 'section',
      sectionId: 'chapter-1',
      body: 'note',
    });
    const resolved = await setCommentStatus(projectDir, STEP_ID, comment.id, 'resolved');
    expect(resolved?.status).toBe('resolved');

    const reopened = await setCommentStatus(projectDir, STEP_ID, comment.id, 'open');
    expect(reopened?.status).toBe('open');

    expect(await setCommentStatus(projectDir, STEP_ID, 'missing-id', 'resolved')).toBeNull();
  });

  describe('reanchorComments', () => {
    it('leaves a span comment untouched when its quote survives verbatim', async () => {
      const comment = await addComment(projectDir, STEP_ID, CONTENT_V1, {
        type: 'span',
        sectionId: 'chapter-1',
        quote: 'The door slammed shut',
        prefixContext: '',
        suffixContext: ' behind her',
        body: 'note',
      });

      const newContent = CONTENT_V1.replace('echoing down the empty hall', 'echoing through the silent house');
      await reanchorComments(projectDir, STEP_ID, newContent);

      const [after] = await listComments(projectDir, STEP_ID);
      expect(after.anchor).toEqual(comment.anchor);
      expect(after.degradedFrom).toBeUndefined();
    });

    it('fuzzy-reanchors a span comment reworded within its section', async () => {
      await addComment(projectDir, STEP_ID, CONTENT_V1, {
        type: 'span',
        sectionId: 'chapter-1',
        quote: 'The door slammed shut behind her',
        prefixContext: '',
        suffixContext: ', echoing',
        body: 'note',
      });

      const newContent = CONTENT_V1.replace(
        'The door slammed shut behind her, echoing down the empty hall.',
        'The heavy door slammed shut right behind her, echoing loudly down the empty hall.',
      );
      await reanchorComments(projectDir, STEP_ID, newContent);

      const [after] = await listComments(projectDir, STEP_ID);
      const anchor = after.anchor as SpanAnchor;
      expect(anchor.type).toBe('span');
      expect(anchor.sectionId).toBe('chapter-1');
      expect(newContent).toContain(anchor.quote);
      expect(after.degradedFrom).toBeUndefined();
    });

    it('degrades a span comment to section-level when its section is fully rewritten, never dropping it', async () => {
      await addComment(projectDir, STEP_ID, CONTENT_V1, {
        type: 'span',
        sectionId: 'chapter-1',
        quote: 'The door slammed shut behind her',
        prefixContext: '',
        suffixContext: ', echoing',
        body: 'Too melodramatic — cut this line.',
      });

      const newContent = CONTENT_V1.replace(
        'The door slammed shut behind her, echoing down the empty hall.',
        'Rain tapped against the window while she waited for news that never came.',
      );
      await reanchorComments(projectDir, STEP_ID, newContent);

      const [after] = await listComments(projectDir, STEP_ID);
      expect(after.anchor).toEqual({ type: 'section', sectionId: 'chapter-1' });
      expect(after.degradedFrom?.quote).toBe('The door slammed shut behind her');
      expect(after.body).toBe('Too melodramatic — cut this line.');
    });

    it('degrades a span comment when its section heading is removed', async () => {
      await addComment(projectDir, STEP_ID, CONTENT_V1, {
        type: 'span',
        sectionId: 'chapter-1',
        quote: 'The door slammed shut behind her',
        prefixContext: '',
        suffixContext: ', echoing',
        body: 'Keep this feedback visible.',
      });

      const newContent = '# Chapter Draft\n\n## Replacement\n\nA completely new opening.\n\n## Chapter 2\n\nMorning came quietly.';
      await reanchorComments(projectDir, STEP_ID, newContent);

      const [after] = await listComments(projectDir, STEP_ID);
      expect(after.anchor).toEqual({ type: 'section', sectionId: 'chapter-1' });
      expect(after.degradedFrom?.quote).toBe('The door slammed shut behind her');
      expect(after.body).toBe('Keep this feedback visible.');
    });

    it('leaves a section comment unaffected by span-level edits elsewhere in the same section', async () => {
      const comment = await addComment(projectDir, STEP_ID, CONTENT_V1, {
        type: 'section',
        sectionId: 'chapter-1',
        body: 'Overall pacing note.',
      });

      const newContent = CONTENT_V1.replace('echoing down the empty hall', 'echoing through the silent house');
      await reanchorComments(projectDir, STEP_ID, newContent);

      const [after] = await listComments(projectDir, STEP_ID);
      expect(after.anchor).toEqual(comment.anchor);
      expect(after.updatedAt).toBe(comment.updatedAt);
    });

    it('is a no-op when there are no comments', async () => {
      await expect(reanchorComments(projectDir, STEP_ID, 'anything')).resolves.toBeUndefined();
    });
  });

  describe('formatOpenCommentsForAgent', () => {
    it('includes only open comments and describes each anchor', async () => {
      const open = await addComment(projectDir, STEP_ID, CONTENT_V1, {
        type: 'section',
        sectionId: 'chapter-1',
        body: 'Speed this up.',
      });
      const resolved = await addComment(projectDir, STEP_ID, CONTENT_V1, {
        type: 'span',
        sectionId: 'chapter-2',
        quote: 'Morning came quietly',
        prefixContext: '',
        suffixContext: '.',
        body: 'Nice line.',
      });
      await setCommentStatus(projectDir, STEP_ID, resolved.id, 'resolved');

      const comments = await listComments(projectDir, STEP_ID);
      const block = formatOpenCommentsForAgent(comments);

      expect(block).toContain('Speed this up.');
      expect(block).not.toContain('Nice line.');
      expect(open.id).toBeTruthy();
    });

    it('returns an empty string when there are no open comments', () => {
      expect(formatOpenCommentsForAgent([])).toBe('');
    });
  });
});
