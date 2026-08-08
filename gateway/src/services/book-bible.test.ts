import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { ContextEngine, type ProjectContext } from './context-engine.js';
import { BookBibleService, type ProjectEngineLike, type ProjectLike } from './book-bible.js';

let workspaceDir: string;
let contextEngine: ContextEngine;
let service: BookBibleService;

function seedContext(ctx: ProjectContext) {
  const contextDir = join(workspaceDir, 'context');
  mkdirSync(contextDir, { recursive: true });
  writeFileSync(join(contextDir, `${ctx.projectId}.json`), JSON.stringify(ctx, null, 2), 'utf-8');
}

function project(overrides: Partial<ProjectLike> & { id: string; title: string }): ProjectLike {
  return { steps: [], ...overrides };
}

function fakeEngine(projects: ProjectLike[]): ProjectEngineLike {
  return {
    getProject: (id: string) => projects.find(p => p.id === id),
    listProjects: () => projects,
  };
}

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), 'authoragent-book-bible-'));
  contextEngine = new ContextEngine(workspaceDir);
  service = new BookBibleService(workspaceDir);
});

afterEach(() => {
  try { rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('BookBibleService.compile — entity index -> rendered sections', () => {
  it('renders characters, timeline, locations, world rules, and items from the ContextEngine index', async () => {
    seedContext({
      projectId: 'project-1',
      updatedAt: new Date().toISOString(),
      summaries: [
        {
          chapterId: 'project-1-step-1', chapterNumber: 1, title: 'Opening',
          summary: 'Aria meets Kael at the docks.', wordCount: 3000,
          characters: ['Aria', 'Kael'], locations: ['Docks'],
          timelineMarker: 'Day 1', plotThreads: ['the missing heir'],
          endingState: 'Aria sets out to find the heir.',
        },
      ],
      entities: [
        {
          name: 'Aria', type: 'character', aliases: ['The Courier'],
          description: 'A dockside courier.', firstAppearance: 'project-1-step-1', lastSeen: 'project-1-step-1',
          attributes: { role: 'protagonist' }, changes: [{ chapterId: 'project-1-step-1', description: 'learned to pick locks' }],
        },
        {
          name: 'The Docks', type: 'location', aliases: [],
          description: 'A foggy harbor district.', firstAppearance: 'project-1-step-1', lastSeen: 'project-1-step-1',
          attributes: {}, changes: [],
        },
        {
          name: 'Magic requires blood', type: 'rule', aliases: [],
          description: 'All magic costs the caster blood.', firstAppearance: 'project-1-step-1', lastSeen: 'project-1-step-1',
          attributes: {}, changes: [],
        },
        {
          name: 'The Sealed Vault', type: 'item', aliases: [],
          description: 'An ancient vault that hums.', firstAppearance: 'project-1-step-1', lastSeen: 'project-1-step-1',
          attributes: {}, changes: [],
        },
      ],
    });

    const engine = fakeEngine([project({ id: 'project-1', title: 'The Algorithm of Wanting' })]);
    const result = await service.compile(engine, contextEngine, 'project-1');

    expect(result.counts).toEqual({
      characters: 1, locations: 1, items: 1, events: 0, rules: 1, chapters: 1, planningNotes: 0,
    });
    expect(result.content).toContain('# The Algorithm of Wanting — Book Bible');
    expect(result.content).toContain('## Characters');
    expect(result.content).toContain('### Aria (The Courier)');
    expect(result.content).toContain('A dockside courier.');
    expect(result.content).toContain('learned to pick locks');
    expect(result.content).toContain('## Timeline');
    expect(result.content).toContain('### Chapter 1 — Opening');
    expect(result.content).toContain('Day 1');
    expect(result.content).toContain('### Open Plot Threads');
    expect(result.content).toContain('the missing heir');
    expect(result.content).toContain('## Locations');
    expect(result.content).toContain('### The Docks');
    expect(result.content).toContain('## World Rules');
    expect(result.content).toContain('### Magic requires blood');
    expect(result.content).toContain('## Items & Objects');
    expect(result.content).toContain('### The Sealed Vault');
  });

  it('dedupes cross-project entities by lowercased name while merging sibling phases (ALP-1548 caveat)', async () => {
    seedContext({
      projectId: 'project-1', updatedAt: new Date().toISOString(), summaries: [],
      entities: [
        { name: 'Aria', type: 'character', aliases: [], description: 'Planning-phase description.', firstAppearance: 'project-1-step-1', lastSeen: 'project-1-step-1', attributes: {}, changes: [] },
      ],
    });
    seedContext({
      projectId: 'project-2', updatedAt: new Date().toISOString(), summaries: [],
      entities: [
        { name: 'aria', type: 'character', aliases: [], description: 'Production-phase description.', firstAppearance: 'project-2-step-1', lastSeen: 'project-2-step-1', attributes: {}, changes: [] },
        { name: 'Kael', type: 'character', aliases: [], description: 'New in production.', firstAppearance: 'project-2-step-1', lastSeen: 'project-2-step-1', attributes: {}, changes: [] },
      ],
    });

    const engine = fakeEngine([
      project({ id: 'project-1', title: 'The Algorithm of Wanting' }),
      project({ id: 'project-2', title: 'The Algorithm of Wanting' }),
    ]);
    const result = await service.compile(engine, contextEngine, 'project-2');

    expect(result.mergedProjectIds.sort()).toEqual(['project-1', 'project-2']);
    expect(result.counts.characters).toBe(2); // Aria deduped, Kael added
    expect(result.content).toContain('Planning-phase description.'); // first-seen wins
    expect(result.content).not.toContain('Production-phase description.');
    expect(result.content).toContain('### Kael');
  });
});

describe('BookBibleService.compile — empty-context path', () => {
  it('produces a valid skeleton document when no context has been recorded yet', async () => {
    const engine = fakeEngine([project({ id: 'project-9', title: 'Untouched Draft' })]);
    const result = await service.compile(engine, contextEngine, 'project-9');

    expect(result.counts).toEqual({
      characters: 0, locations: 0, items: 0, events: 0, rules: 0, chapters: 0, planningNotes: 0,
    });
    expect(result.content).toContain('# Untouched Draft — Book Bible');
    expect(result.content).toContain('_No characters tracked yet._');
    expect(result.content).toContain('_No chapter timeline recorded yet._');
    expect(result.content).toContain('_No locations tracked yet._');
    expect(result.content).toContain('_No world rules tracked yet._');
    expect(result.content).toContain('_No items tracked yet._');
    expect(result.content).toContain('_None tracked yet._'); // open plot threads
  });

  it('throws a PROJECT_NOT_FOUND-coded error for an unknown project id', async () => {
    const engine = fakeEngine([]);
    await expect(service.compile(engine, contextEngine, 'missing')).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
  });
});

describe('BookBibleService.compile — folding in authored planning step files', () => {
  it('folds character-profile, world-building, and premise step files into their sections when present', async () => {
    seedContext({ projectId: 'project-5', updatedAt: new Date().toISOString(), summaries: [], entities: [] });

    const projectDir = join(workspaceDir, 'workspace', 'projects', 'moonlit-heist');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, 'project-5-step-2-character-profiles.md'),
      '# Character profiles\n\nFull authored bios go here, richer than the extracted index.',
      'utf-8',
    );
    writeFileSync(
      join(projectDir, 'project-5-step-3-world-building-document.md'),
      '# World-building document\n\nThe city runs on stolen moonlight.',
      'utf-8',
    );
    writeFileSync(
      join(projectDir, 'project-5-step-1-develop-premise.md'),
      '# Develop premise\n\nA thief must steal back her own memories.',
      'utf-8',
    );

    const engine = fakeEngine([
      project({
        id: 'project-5',
        title: 'Moonlit Heist',
        steps: [
          { id: 'project-5-step-1', label: 'Develop premise', status: 'completed' },
          { id: 'project-5-step-2', label: 'Character profiles', status: 'completed' },
          { id: 'project-5-step-3', label: 'World-building document', status: 'completed' },
          { id: 'project-5-step-4', label: 'Chapter-by-chapter outline', status: 'pending' },
        ],
      }),
    ]);

    const result = await service.compile(engine, contextEngine, 'project-5');

    expect(result.counts.planningNotes).toBe(3);
    expect(result.content).toContain('## Premise');
    expect(result.content).toContain('A thief must steal back her own memories.');
    expect(result.content).toContain('### Authored Character Notes');
    expect(result.content).toContain('Full authored bios go here, richer than the extracted index.');
    expect(result.content).toContain('### Authored World-Building Notes');
    expect(result.content).toContain('The city runs on stolen moonlight.');
  });

  it('skips planning steps that are not completed or have no file on disk', async () => {
    seedContext({ projectId: 'project-6', updatedAt: new Date().toISOString(), summaries: [], entities: [] });

    const engine = fakeEngine([
      project({
        id: 'project-6',
        title: 'No Notes Yet',
        steps: [
          { id: 'project-6-step-1', label: 'Character profiles', status: 'pending' }, // not completed, no file either
        ],
      }),
    ]);

    const result = await service.compile(engine, contextEngine, 'project-6');
    expect(result.counts.planningNotes).toBe(0);
    expect(result.content).not.toContain('### Authored Character Notes');
  });
});
