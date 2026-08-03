// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { DiffView } from './DiffView';

afterEach(cleanup);

describe('DiffView', () => {
  it('renders equal, added, and removed lines with distinct markers', () => {
    render(
      <DiffView
        from={1}
        to={2}
        diff={[
          { op: 'equal', line: 'Chapter One' },
          { op: 'remove', line: 'She walked in.' },
          { op: 'add', line: 'She strode in, unannounced.' },
        ]}
      />,
    );

    expect(screen.getByText('Diff v1 → v2')).toBeTruthy();
    expect(screen.getAllByTestId('diff-line-equal')).toHaveLength(1);
    expect(screen.getAllByTestId('diff-line-remove')).toHaveLength(1);
    expect(screen.getAllByTestId('diff-line-add')).toHaveLength(1);
    expect(screen.getByText(/She strode in, unannounced\./)).toBeTruthy();
  });

  it('renders nothing extra for an empty diff', () => {
    render(<DiffView from={1} to={1} diff={[]} />);
    expect(screen.queryByTestId('diff-line-add')).toBeNull();
    expect(screen.queryByTestId('diff-line-remove')).toBeNull();
  });
});
