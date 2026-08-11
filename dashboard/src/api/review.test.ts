import { afterEach, describe, expect, it, vi } from 'vitest';
import * as reviewApi from './review';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
  } as unknown as Response;
}

describe('review API client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('getVersions calls the right path and returns parsed JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ stepId: 's1', versions: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await reviewApi.getVersions('proj 1', 's1');

    expect(fetchMock).toHaveBeenCalledWith('/api/projects/proj%201/steps/s1/versions', expect.objectContaining({ method: 'GET' }));
    expect(result).toEqual({ stepId: 's1', versions: [] });
  });

  it('saveVersion POSTs content as JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ stepId: 's1', version: 2, step: {} }));
    vi.stubGlobal('fetch', fetchMock);

    await reviewApi.saveVersion('p1', 's1', 'new body', 'typo fix');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/p1/steps/s1/versions',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ content: 'new body', note: 'typo fix' }),
      }),
    );
  });

  it('getDiff encodes from/to as query params', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ stepId: 's1', from: 1, to: 3, diff: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await reviewApi.getDiff('p1', 's1', 1, 3);

    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p1/steps/s1/diff?from=1&to=3', expect.any(Object));
  });

  it('throws the server error message on a non-ok JSON response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'Step is "completed", not awaiting_review' }, false, 400));
    vi.stubGlobal('fetch', fetchMock);

    await expect(reviewApi.approveStep('p1', 's1')).rejects.toThrow('Step is "completed", not awaiting_review');
  });

  it('throws a generic HTTP error when the response is not JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      headers: new Headers({ 'content-type': 'text/plain' }),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    await expect(reviewApi.getImpact('p1', 's1')).rejects.toThrow('HTTP 500 Internal Server Error');
  });
});
