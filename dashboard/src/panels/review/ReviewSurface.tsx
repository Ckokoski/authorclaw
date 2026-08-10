import { useEffect, useMemo, useState } from 'preact/hooks';
import * as reviewApi from '../../api/review';
import type { DiffOp, ImpactResponse, VersionEntry } from '../../api/review';
import { DiffView } from './DiffView';

export interface ReviewSurfaceProps {
  projectId: string;
  stepId: string;
  stepLabel?: string;
  onClose: () => void;
}

type LoadState = 'loading' | 'ready' | 'error';
type Message = { kind: 'error' | 'success'; text: string };

function formatTs(ts: number): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

/**
 * Full-screen gated-document review surface (ALP-1564 / M2.2). One
 * component, mounted by whichever entry point opens it (Reviews queue panel
 * or a Book View step row — both land in M2.5). Talks to the M1.5 review API
 * (gateway/src/api/routes/review.ts) exclusively; carries no knowledge of
 * how it was opened beyond the projectId/stepId it's given.
 */
export function ReviewSurface({ projectId, stepId, stepLabel, onClose }: ReviewSurfaceProps) {
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [versions, setVersions] = useState<VersionEntry[]>([]);
  const [impact, setImpact] = useState<ImpactResponse | null>(null);
  const [editedContent, setEditedContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [loadedVersion, setLoadedVersion] = useState<number | null>(null);

  const [diffFrom, setDiffFrom] = useState<number | null>(null);
  const [diffTo, setDiffTo] = useState<number | null>(null);
  const [diffOps, setDiffOps] = useState<DiffOp[] | null>(null);

  const [revisePanelOpen, setRevisePanelOpen] = useState(false);
  const [reviseComments, setReviseComments] = useState('');
  const [reviseNotes, setReviseNotes] = useState('');

  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);

  const hasUnsavedEdits = editedContent !== savedContent;

  async function loadAll() {
    setLoadState('loading');
    setMessage(null);
    try {
      const [versionsRes, impactRes] = await Promise.all([
        reviewApi.getVersions(projectId, stepId),
        reviewApi.getImpact(projectId, stepId),
      ]);
      setVersions(versionsRes.versions);
      setImpact(impactRes);

      const latest = versionsRes.versions[versionsRes.versions.length - 1];
      if (latest) {
        const contentRes = await reviewApi.getVersionContent(projectId, stepId, latest.v);
        setEditedContent(contentRes.content);
        setSavedContent(contentRes.content);
        setLoadedVersion(latest.v);
        if (versionsRes.versions.length >= 2) {
          setDiffFrom(versionsRes.versions[versionsRes.versions.length - 2].v);
          setDiffTo(latest.v);
        }
      }
      setLoadState('ready');
    } catch (err) {
      setLoadState('error');
      setMessage({ kind: 'error', text: (err as Error).message });
    }
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, stepId]);

  async function handleLoadVersion(v: number) {
    if (hasUnsavedEdits && !window.confirm(`Discard unsaved edits and load v${v} into the editor?`)) return;
    setBusy('load');
    setMessage(null);
    try {
      const res = await reviewApi.getVersionContent(projectId, stepId, v);
      setEditedContent(res.content);
      setSavedContent(res.content);
      setLoadedVersion(v);
      setDiffOps(null);
    } catch (err) {
      setMessage({ kind: 'error', text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function handleSave() {
    setBusy('save');
    setMessage(null);
    try {
      const res = await reviewApi.saveVersion(projectId, stepId, editedContent);
      setSavedContent(editedContent);
      setLoadedVersion(res.version);
      setMessage({ kind: 'success', text: `Saved as v${res.version}.` });
      const versionsRes = await reviewApi.getVersions(projectId, stepId);
      setVersions(versionsRes.versions);
      setDiffTo(res.version);
    } catch (err) {
      setMessage({ kind: 'error', text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function handleApprove() {
    setBusy('approve');
    setMessage(null);
    try {
      await reviewApi.approveStep(projectId, stepId);
      setMessage({ kind: 'success', text: 'Approved.' });
    } catch (err) {
      setMessage({ kind: 'error', text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function handleRevise() {
    if (!reviseComments.trim() && !reviseNotes.trim()) {
      setMessage({ kind: 'error', text: 'Add a comment or a note before asking the agent to revise.' });
      return;
    }
    setBusy('revise');
    setMessage(null);
    try {
      const result = await reviewApi.reviseStep(projectId, stepId, reviseComments, reviseNotes);
      if (result.success) {
        setRevisePanelOpen(false);
        setReviseComments('');
        setReviseNotes('');
        // loadAll() clears any existing message as it starts, so the success
        // message must be set after it resolves, not before.
        await loadAll();
        setMessage({ kind: 'success', text: `Agent revised the document (v${result.version}).` });
      } else {
        setMessage({ kind: 'error', text: result.error || 'Revision failed.' });
      }
    } catch (err) {
      setMessage({ kind: 'error', text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function handleDiff() {
    if (diffFrom == null || diffTo == null) return;
    setBusy('diff');
    setMessage(null);
    try {
      const res = await reviewApi.getDiff(projectId, stepId, diffFrom, diffTo);
      setDiffOps(res.diff);
    } catch (err) {
      setMessage({ kind: 'error', text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  const dirtyDownstreamCount = impact?.dirty.length ?? 0;
  const downstreamCount = impact?.downstreamStepIds.length ?? 0;

  const overlayStyle = useMemo(
    () => ({
      position: 'fixed' as const,
      inset: 0,
      zIndex: 1000,
      display: 'flex',
      flexDirection: 'column' as const,
      background: 'var(--bg)',
      color: 'var(--text)',
    }),
    [],
  );

  return (
    <div data-testid="review-surface" style={overlayStyle}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0.75em 1em',
          borderBottom: '1px solid var(--bg-secondary)',
        }}
      >
        <div>
          <strong>Review: {stepLabel || stepId}</strong>
          {loadedVersion != null && (
            <span style={{ color: 'var(--text-secondary)', marginLeft: '0.75em' }}>
              viewing v{loadedVersion}
              {hasUnsavedEdits ? ' (unsaved edits)' : ''}
            </span>
          )}
        </div>
        <button type="button" onClick={onClose} data-testid="review-close">
          Close
        </button>
      </header>

      {message && (
        <div
          role="status"
          data-testid="review-message"
          style={{
            padding: '0.5em 1em',
            color: message.kind === 'error' ? '#f87171' : '#4ade80',
          }}
        >
          {message.text}
        </div>
      )}

      {loadState === 'loading' && <div style={{ padding: '1em' }}>Loading…</div>}
      {loadState === 'error' && (
        <div style={{ padding: '1em' }}>
          Failed to load this step.{' '}
          <button type="button" onClick={loadAll}>
            Retry
          </button>
        </div>
      )}

      {loadState === 'ready' && (
        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          <main style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '1em', minWidth: 0 }}>
            {diffOps ? (
              <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                <DiffView from={diffFrom!} to={diffTo!} diff={diffOps} />
                <button type="button" style={{ marginTop: '0.5em', alignSelf: 'flex-start' }} onClick={() => setDiffOps(null)}>
                  Back to editor
                </button>
              </div>
            ) : (
              <textarea
                data-testid="review-editor"
                value={editedContent}
                onInput={(e) => setEditedContent((e.target as HTMLTextAreaElement).value)}
                style={{
                  flex: 1,
                  width: '100%',
                  resize: 'none',
                  fontFamily: 'monospace',
                  fontSize: '0.95em',
                  background: 'var(--bg-secondary)',
                  color: 'var(--text)',
                  border: '1px solid var(--muted)',
                  borderRadius: '4px',
                  padding: '0.75em',
                }}
              />
            )}
          </main>

          <aside
            style={{
              width: '300px',
              flexShrink: 0,
              borderLeft: '1px solid var(--bg-secondary)',
              padding: '1em',
              overflowY: 'auto',
            }}
          >
            <section>
              <h4 style={{ margin: '0 0 0.5em' }}>Downstream impact</h4>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.9em' }}>
                {downstreamCount} step{downstreamCount === 1 ? '' : 's'} downstream
                {dirtyDownstreamCount > 0 ? `, ${dirtyDownstreamCount} marked dirty` : ''}.
              </p>
              {impact?.dirty.map((d) => (
                <div key={d.stepId} style={{ fontSize: '0.85em', marginBottom: '0.25em' }}>
                  <span style={{ color: '#f59e0b' }}>●</span> {d.label}
                  {d.marker?.severity ? ` (${d.marker.severity})` : ''}
                </div>
              ))}
            </section>

            <section style={{ marginTop: '1.5em' }}>
              <h4 style={{ margin: '0 0 0.5em' }}>Versions</h4>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} data-testid="version-list">
                {[...versions].reverse().map((v) => (
                  <li
                    key={v.v}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '0.35em 0',
                      borderBottom: '1px solid var(--bg-secondary)',
                      fontSize: '0.85em',
                    }}
                  >
                    <span>
                      v{v.v} · {v.author} · {formatTs(v.ts)}
                    </span>
                    <button type="button" disabled={busy != null} onClick={() => handleLoadVersion(v.v)}>
                      Load
                    </button>
                  </li>
                ))}
              </ul>
            </section>

            <section style={{ marginTop: '1.5em' }}>
              <h4 style={{ margin: '0 0 0.5em' }}>Diff versions</h4>
              <div style={{ display: 'flex', gap: '0.5em', alignItems: 'center' }}>
                <select
                  aria-label="Diff from version"
                  data-testid="diff-from-select"
                  value={diffFrom ?? ''}
                  onChange={(e) => setDiffFrom(Number((e.target as HTMLSelectElement).value) || null)}
                >
                  <option value="">from</option>
                  {versions.map((v) => (
                    <option key={v.v} value={v.v}>
                      v{v.v}
                    </option>
                  ))}
                </select>
                <span>↔</span>
                <select
                  aria-label="Diff to version"
                  data-testid="diff-to-select"
                  value={diffTo ?? ''}
                  onChange={(e) => setDiffTo(Number((e.target as HTMLSelectElement).value) || null)}
                >
                  <option value="">to</option>
                  {versions.map((v) => (
                    <option key={v.v} value={v.v}>
                      v{v.v}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                style={{ marginTop: '0.5em' }}
                disabled={diffFrom == null || diffTo == null || busy != null}
                onClick={handleDiff}
                data-testid="review-diff"
              >
                Diff v{diffFrom ?? '?'} ↔ v{diffTo ?? '?'}
              </button>
            </section>
          </aside>
        </div>
      )}

      {loadState === 'ready' && (
        <footer
          style={{
            borderTop: '1px solid var(--bg-secondary)',
            padding: '0.75em 1em',
            display: 'flex',
            gap: '0.5em',
            alignItems: 'flex-start',
            flexWrap: 'wrap',
          }}
        >
          <button type="button" disabled={!hasUnsavedEdits || busy != null} onClick={handleSave} data-testid="review-save">
            {busy === 'save' ? 'Saving…' : 'Save edits'}
          </button>
          <button type="button" disabled={busy != null} onClick={handleApprove} data-testid="review-approve">
            {busy === 'approve' ? 'Approving…' : 'Approve'}
          </button>
          <button
            type="button"
            disabled={busy != null}
            onClick={() => setRevisePanelOpen((v) => !v)}
            data-testid="review-revise-toggle"
          >
            Ask agent to revise
          </button>

          {revisePanelOpen && (
            <div style={{ flexBasis: '100%', marginTop: '0.5em', display: 'flex', flexDirection: 'column', gap: '0.4em' }}>
              <textarea
                data-testid="revise-comments"
                placeholder="Editorial comments for the agent…"
                value={reviseComments}
                onInput={(e) => setReviseComments((e.target as HTMLTextAreaElement).value)}
                style={{ width: '100%', minHeight: '4em' }}
              />
              <textarea
                data-testid="revise-notes"
                placeholder="Freeform notes (optional)…"
                value={reviseNotes}
                onInput={(e) => setReviseNotes((e.target as HTMLTextAreaElement).value)}
                style={{ width: '100%', minHeight: '3em' }}
              />
              <button type="button" disabled={busy != null} onClick={handleRevise} data-testid="revise-submit">
                {busy === 'revise' ? 'Revising…' : 'Send to agent'}
              </button>
            </div>
          )}
        </footer>
      )}
    </div>
  );
}
