import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';

import { registerReviewRoutes } from './review.js';

describe('review queue route', () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    const projects = [
      {
        id: 'book-a',
        title: 'Book A',
        steps: [
          { id: 'outline', label: 'Outline', status: 'awaiting_review', phase: 'outline' },
          {
            id: 'chapter-1',
            label: 'Chapter 1',
            status: 'completed',
            phase: 'writing',
            dirty: { causeStepId: 'outline' },
          },
          { id: 'premise', label: 'Premise', status: 'completed', phase: 'premise' },
        ],
      },
      {
        id: 'book-b',
        title: 'Book B',
        steps: [
          { id: 'bible', label: 'Bible', status: 'awaiting_review', phase: 'bible' },
        ],
      },
    ];

    const app = express();
    registerReviewRoutes({
      app,
      gateway: {
        getProjectEngine: () => ({ listProjects: () => projects }),
      },
      workspaceDir: '/unused',
    } as any);

    await new Promise<void>((resolve) => {
      server = app.listen(0, resolve);
    });
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('lists awaiting-review and dirty steps across books, excluding clean completed steps', async () => {
    const response = await fetch(`${baseUrl}/api/reviews`);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.count).toBe(3);
    expect(body.queue.map((item: { projectId: string; stepId: string }) => `${item.projectId}/${item.stepId}`)).toEqual([
      'book-a/outline',
      'book-a/chapter-1',
      'book-b/bible',
    ]);
    expect(body.queue[1].dirty).toEqual({ causeStepId: 'outline' });
  });
});
