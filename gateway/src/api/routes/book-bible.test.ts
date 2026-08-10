/**
 * Endpoint tests for POST/GET /api/projects/:id/book-bible.
 * Spins up a real (ephemeral-port) Express app around registerBookBibleRoutes
 * with a minimal fake project engine — same wiring shape as production
 * (ContextEngine + MemoryService rooted under <root>/workspace, ApiContext
 * baseDir = <root>), just in a tmp dir.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { registerBookBibleRoutes } from './book-bible.js';
import { ContextEngine } from '../../services/context-engine.js';
import { MemoryService } from '../../services/memory.js';

describe('book-bible routes', () => {
  let rootDir: string;
  let server: Server;
  let baseUrl: string;
  let projects: Map<string, any>;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), 'authoragent-book-bible-routes-'));
    const workspaceDir = join(rootDir, 'workspace');
    const contextEngine = new ContextEngine(workspaceDir);
    const memory = new MemoryService(join(workspaceDir, 'memory'), {});
    await memory.initialize();

    projects = new Map();
    projects.set('project-1', { id: 'project-1', title: 'Test Book', steps: [] });

    const gateway = {
      getProjectEngine: () => ({
        getProject: (id: string) => projects.get(id),
        listProjects: () => Array.from(projects.values()),
      }),
    };

    const app = express();
    app.use(express.json());
    registerBookBibleRoutes({
      app, gateway, services: { contextEngine, memory }, baseDir: rootDir,
    } as any);

    await new Promise<void>(resolve => {
      server = app.listen(0, () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    try { rmSync(rootDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('GET 404s before the bible has ever been compiled', async () => {
    const res = await fetch(`${baseUrl}/api/projects/project-1/book-bible`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not been compiled/i);
  });

  it('GET 404s for an unknown project', async () => {
    const res = await fetch(`${baseUrl}/api/projects/does-not-exist/book-bible`);
    expect(res.status).toBe(404);
  });

  it('POST 404s for an unknown project', async () => {
    const res = await fetch(`${baseUrl}/api/projects/does-not-exist/book-bible`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('POST compiles and persists the bible; a subsequent GET returns the same content', async () => {
    const postRes = await fetch(`${baseUrl}/api/projects/project-1/book-bible`, { method: 'POST' });
    expect(postRes.status).toBe(200);
    const postBody = await postRes.json();
    expect(postBody.success).toBe(true);
    expect(postBody.content).toContain('# Test Book — Book Bible');
    expect(postBody.mergedProjectIds).toEqual(['project-1']);

    const getRes = await fetch(`${baseUrl}/api/projects/project-1/book-bible`);
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    expect(getBody.content).toBe(postBody.content);
  });

  it('POST regenerates on a second call (idempotent recompile)', async () => {
    const first = await (await fetch(`${baseUrl}/api/projects/project-1/book-bible`, { method: 'POST' })).json();
    const second = await (await fetch(`${baseUrl}/api/projects/project-1/book-bible`, { method: 'POST' })).json();
    expect(second.success).toBe(true);
    expect(second.content).toBe(first.content);
  });
});
