// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as reviewApi from '../../api/review';
import { ReviewSurface } from './ReviewSurface';

afterEach(cleanup);

const VERSIONS = [
  { v: 1, author: 'agent' as const, ts: 1000, sha256: 'a' },
  { v: 2, author: 'user' as const, ts: 2000, sha256: 'b' },
];

function stubHappyPath() {
  vi.spyOn(reviewApi, 'getVersions').mockResolvedValue({ stepId: 's1', versions: VERSIONS });
  vi.spyOn(reviewApi, 'getImpact').mockResolvedValue({ stepId: 's1', downstreamStepIds: ['s2'], dirty: [] });
  vi.spyOn(reviewApi, 'getVersionContent').mockImplementation(async (_p, _s, v) => ({
    stepId: 's1',
    v,
    content: `content v${v}`,
  }));
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('ReviewSurface', () => {
  it('loads and displays the latest version content in an editable body', async () => {
    stubHappyPath();
    render(<ReviewSurface projectId="p1" stepId="s1" onClose={() => {}} />);

    const editor = await screen.findByTestId('review-editor');
    expect((editor as HTMLTextAreaElement).value).toBe('content v2');
    expect(screen.getByText(/viewing v2/)).toBeTruthy();
  });

  it('shows an error and a retry option when the initial load fails', async () => {
    vi.spyOn(reviewApi, 'getVersions').mockRejectedValue(new Error('network down'));
    vi.spyOn(reviewApi, 'getImpact').mockResolvedValue({ stepId: 's1', downstreamStepIds: [], dirty: [] });

    render(<ReviewSurface projectId="p1" stepId="s1" onClose={() => {}} />);

    expect(await screen.findByText('network down')).toBeTruthy();
    expect(screen.getByText('Retry')).toBeTruthy();
  });

  it('edits the body and saves a new version', async () => {
    stubHappyPath();
    const saveSpy = vi.spyOn(reviewApi, 'saveVersion').mockResolvedValue({ stepId: 's1', version: 3, step: {} });

    render(<ReviewSurface projectId="p1" stepId="s1" onClose={() => {}} />);
    const editor = await screen.findByTestId('review-editor');

    fireEvent.input(editor, { target: { value: 'edited content' } });
    expect((screen.getByTestId('review-save') as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByTestId('review-save'));

    await waitFor(() => expect(saveSpy).toHaveBeenCalledWith('p1', 's1', 'edited content'));
    expect(await screen.findByText('Saved as v3.')).toBeTruthy();
  });

  it('disables Save edits until the body actually changes', async () => {
    stubHappyPath();
    render(<ReviewSurface projectId="p1" stepId="s1" onClose={() => {}} />);
    await screen.findByTestId('review-editor');
    expect((screen.getByTestId('review-save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('diffs two selected versions and renders the diff view', async () => {
    stubHappyPath();
    const diffSpy = vi.spyOn(reviewApi, 'getDiff').mockResolvedValue({
      stepId: 's1',
      from: 1,
      to: 2,
      diff: [{ op: 'add', line: 'new line' }],
    });

    render(<ReviewSurface projectId="p1" stepId="s1" onClose={() => {}} />);
    await screen.findByTestId('review-editor');

    fireEvent.click(screen.getByTestId('review-diff'));

    await waitFor(() => expect(diffSpy).toHaveBeenCalledWith('p1', 's1', 1, 2));
    expect(await screen.findByTestId('diff-view')).toBeTruthy();
  });

  it('approves the step and surfaces the result', async () => {
    stubHappyPath();
    const approveSpy = vi.spyOn(reviewApi, 'approveStep').mockResolvedValue({ step: {}, project: {} });

    render(<ReviewSurface projectId="p1" stepId="s1" onClose={() => {}} />);
    await screen.findByTestId('review-editor');

    fireEvent.click(screen.getByTestId('review-approve'));

    await waitFor(() => expect(approveSpy).toHaveBeenCalledWith('p1', 's1'));
    expect(await screen.findByText('Approved.')).toBeTruthy();
  });

  it('surfaces a backend rejection (e.g. wrong step status) as an error message', async () => {
    stubHappyPath();
    vi.spyOn(reviewApi, 'approveStep').mockRejectedValue(new Error('Step is "completed", not awaiting_review'));

    render(<ReviewSurface projectId="p1" stepId="s1" onClose={() => {}} />);
    await screen.findByTestId('review-editor');

    fireEvent.click(screen.getByTestId('review-approve'));

    expect(await screen.findByText('Step is "completed", not awaiting_review')).toBeTruthy();
  });

  it('sends comments to the agent via Ask agent to revise and reloads on success', async () => {
    stubHappyPath();
    const reviseSpy = vi.spyOn(reviewApi, 'reviseStep').mockResolvedValue({ success: true, response: 'ok', version: 3 });

    render(<ReviewSurface projectId="p1" stepId="s1" onClose={() => {}} />);
    await screen.findByTestId('review-editor');

    fireEvent.click(screen.getByTestId('review-revise-toggle'));
    fireEvent.input(screen.getByTestId('revise-comments'), { target: { value: 'Tighten the pacing here.' } });
    fireEvent.click(screen.getByTestId('revise-submit'));

    await waitFor(() => expect(reviseSpy).toHaveBeenCalledWith('p1', 's1', 'Tighten the pacing here.', ''));
    expect(await screen.findByText('Agent revised the document (v3).')).toBeTruthy();
  });

  it('blocks Ask agent to revise submission when both comments and notes are empty', async () => {
    stubHappyPath();
    const reviseSpy = vi.spyOn(reviewApi, 'reviseStep');

    render(<ReviewSurface projectId="p1" stepId="s1" onClose={() => {}} />);
    await screen.findByTestId('review-editor');

    fireEvent.click(screen.getByTestId('review-revise-toggle'));
    fireEvent.click(screen.getByTestId('revise-submit'));

    expect(await screen.findByText(/Add a comment or a note/)).toBeTruthy();
    expect(reviseSpy).not.toHaveBeenCalled();
  });

  it('calls onClose when Close is clicked', async () => {
    stubHappyPath();
    const onClose = vi.fn();
    render(<ReviewSurface projectId="p1" stepId="s1" onClose={onClose} />);
    await screen.findByTestId('review-editor');

    fireEvent.click(screen.getByTestId('review-close'));
    expect(onClose).toHaveBeenCalled();
  });
});
