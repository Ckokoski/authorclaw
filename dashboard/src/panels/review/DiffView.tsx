import type { DiffOp } from '../../api/review';

/** Renders line-level diff ops from GET .../diff. Pure and DOM-light on purpose — easy to unit test in isolation. */
export function DiffView({ from, to, diff }: { from: number; to: number; diff: DiffOp[] }) {
  return (
    <div data-testid="diff-view">
      <div style={{ color: 'var(--text-secondary)', fontSize: '0.85em', marginBottom: '0.5em' }}>
        Diff v{from} → v{to}
      </div>
      <pre
        style={{
          fontFamily: 'monospace',
          fontSize: '0.9em',
          whiteSpace: 'pre-wrap',
          background: 'var(--bg-secondary)',
          color: 'var(--text)',
          padding: '0.75em',
          borderRadius: '4px',
          margin: 0,
          maxHeight: '100%',
          overflow: 'auto',
        }}
      >
        {diff.map((op, i) => (
          <div
            key={i}
            data-testid={`diff-line-${op.op}`}
            style={{
              background: op.op === 'add' ? 'rgba(34,197,94,0.15)' : op.op === 'remove' ? 'rgba(239,68,68,0.15)' : 'transparent',
              color: op.op === 'add' ? '#4ade80' : op.op === 'remove' ? '#f87171' : 'inherit',
            }}
          >
            {op.op === 'add' ? '+ ' : op.op === 'remove' ? '- ' : '  '}
            {op.line}
          </div>
        ))}
      </pre>
    </div>
  );
}
