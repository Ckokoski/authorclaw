import { useEffect, useState } from 'preact/hooks';
import { emit, on } from '../bridge';
import { ReviewSurface } from './review/ReviewSurface';

export interface ReviewOpenDetail {
  projectId: string;
  stepId: string;
  stepLabel?: string;
}

/**
 * Root for the gated-review panel (ALP-1553/ALP-1564). Renders nothing by
 * default, so dist/index.html stays pixel-for-pixel identical to the legacy
 * dashboard until a review is actually opened.
 *
 * Entry points (Reviews queue panel, Book View step row — both M2.5, not yet
 * wired) open a review by dispatching the bridge event below from legacy
 * vanilla JS:
 *
 *   window.dispatchEvent(new CustomEvent('authoragent:review-open', {
 *     detail: { projectId, stepId, stepLabel }
 *   }));
 */
export function ReviewPanel() {
  const [lastPanel, setLastPanel] = useState<string | null>(null);
  const [openReview, setOpenReview] = useState<ReviewOpenDetail | null>(null);

  useEffect(() => on<string>('panel-change', setLastPanel), []);
  useEffect(() => on<ReviewOpenDetail>('review-open', setOpenReview), []);

  if (!openReview) {
    return <div data-testid="review-panel-mounted" data-last-panel={lastPanel ?? ''} style={{ display: 'none' }} />;
  }

  return (
    <ReviewSurface
      projectId={openReview.projectId}
      stepId={openReview.stepId}
      stepLabel={openReview.stepLabel}
      onClose={() => {
        setOpenReview(null);
        emit('review-close');
      }}
    />
  );
}
