// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as reviewApi from '../api/review';
import { emit } from '../bridge';
import { ReviewPanel } from './ReviewPanel';

afterEach(cleanup);

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(reviewApi, 'getVersions').mockResolvedValue({ stepId: 's1', versions: [{ v: 1, author: 'agent', ts: 1, sha256: 'x' }] });
  vi.spyOn(reviewApi, 'getImpact').mockResolvedValue({ stepId: 's1', downstreamStepIds: [], dirty: [] });
  vi.spyOn(reviewApi, 'getVersionContent').mockResolvedValue({ stepId: 's1', v: 1, content: 'hello' });
});

describe('ReviewPanel', () => {
  it('renders hidden until a review-open bridge event arrives', () => {
    render(<ReviewPanel />);
    const marker = screen.getByTestId('review-panel-mounted');
    expect(marker).toBeTruthy();
    expect(screen.queryByTestId('review-surface')).toBeNull();
  });

  it('opens the review surface for the projectId/stepId in the bridge event', async () => {
    render(<ReviewPanel />);

    act(() => {
      emit('review-open', { projectId: 'p1', stepId: 's1', stepLabel: 'World Bible' });
    });

    expect(await screen.findByTestId('review-surface')).toBeTruthy();
    expect(screen.getByText(/Review: World Bible/)).toBeTruthy();
  });
});
