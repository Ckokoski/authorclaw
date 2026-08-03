import { useEffect, useState } from 'preact/hooks';
import { on } from '../bridge';

/**
 * Placeholder root for the gated-review panel (ALP-1553). M2.1 only wires
 * up the build + mount plumbing; the actual review UI (version list, diff
 * view, approve/revise actions) lands in a later milestone.
 *
 * Renders nothing visible yet, so dist/index.html stays pixel-for-pixel
 * identical to the legacy dashboard. The hidden marker + bridge listener
 * below exist purely to prove the mount and event bridge work end to end.
 */
export function ReviewPanel() {
  const [lastPanel, setLastPanel] = useState<string | null>(null);

  useEffect(() => on<string>('panel-change', setLastPanel), []);

  return (
    <div
      data-testid="review-panel-mounted"
      data-last-panel={lastPanel ?? ''}
      style={{ display: 'none' }}
    />
  );
}
