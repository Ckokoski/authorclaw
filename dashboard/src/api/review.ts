/**
 * Fetch client for the M1.5 review API (gateway/src/api/routes/review.ts).
 * Plain relative-path fetch, same convention as the legacy dashboard's
 * `api()` helper in dashboard/dist/index.html — this app is unauthenticated
 * and same-origin by design, so no base URL or auth header is needed.
 */

export type VersionAuthor = 'agent' | 'user' | 'agent-patch';

export interface VersionEntry {
  v: number;
  author: VersionAuthor;
  ts: number;
  note?: string;
  parentV?: number;
  sha256: string;
}

export type DiffOp = { op: 'equal' | 'add' | 'remove'; line: string };

export interface DirtyMarker {
  causeStepId: string;
  causeVersionFrom: number;
  causeVersionTo: number;
  severity?: 'high' | 'low' | 'none';
  markedAt: string;
}

export interface ImpactResponse {
  stepId: string;
  downstreamStepIds: string[];
  dirty: { stepId: string; label: string; marker?: DirtyMarker }[];
}

export interface ReviseResult {
  success: boolean;
  response?: string;
  version?: number;
  error?: string;
  detail?: unknown;
}

class ApiError extends Error {}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const contentType = res.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');

  if (!res.ok) {
    if (isJson) {
      const data = await res.json();
      throw new ApiError(data.error || `HTTP ${res.status}`);
    }
    throw new ApiError(`HTTP ${res.status} ${res.statusText}`);
  }
  if (!isJson) throw new ApiError('Server returned non-JSON response');
  return res.json();
}

function stepPath(projectId: string, stepId: string, suffix = ''): string {
  return `/api/projects/${encodeURIComponent(projectId)}/steps/${encodeURIComponent(stepId)}${suffix}`;
}

export function getVersions(projectId: string, stepId: string): Promise<{ stepId: string; versions: VersionEntry[] }> {
  return request('GET', stepPath(projectId, stepId, '/versions'));
}

export function getVersionContent(
  projectId: string,
  stepId: string,
  v: number,
): Promise<{ stepId: string; v: number; content: string }> {
  return request('GET', stepPath(projectId, stepId, `/versions/${v}`));
}

export function getDiff(
  projectId: string,
  stepId: string,
  from: number,
  to: number,
): Promise<{ stepId: string; from: number; to: number; diff: DiffOp[] }> {
  return request('GET', stepPath(projectId, stepId, `/diff?from=${from}&to=${to}`));
}

export function saveVersion(
  projectId: string,
  stepId: string,
  content: string,
  note?: string,
): Promise<{ stepId: string; version: number; step: unknown }> {
  return request('POST', stepPath(projectId, stepId, '/versions'), { content, note });
}

export function approveStep(projectId: string, stepId: string): Promise<{ step: unknown; project: unknown }> {
  return request('POST', stepPath(projectId, stepId, '/approve'));
}

export function reviseStep(projectId: string, stepId: string, comments: string, notes: string): Promise<ReviseResult> {
  return request('POST', stepPath(projectId, stepId, '/revise'), { comments, notes });
}

export function getImpact(projectId: string, stepId: string): Promise<ImpactResponse> {
  return request('GET', stepPath(projectId, stepId, '/impact'));
}
