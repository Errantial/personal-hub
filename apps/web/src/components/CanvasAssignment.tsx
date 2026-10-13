import type { CanvasLmsAssignment, CanvasLmsCourse } from '@hub/contracts';
import { formatInstant } from '../lib/format';
export function CanvasAssignment({
  item,
  course,
}: {
  item: CanvasLmsAssignment;
  course: CanvasLmsCourse;
}) {
  return (
    <article
      className="canvas-item"
      aria-label={`Canvas assignment ${item.providerData.title}`}
    >
      <strong>{item.providerData.title}</strong>
      <p>
        {item.providerData.dueAt
          ? `Due ${formatInstant(item.providerData.dueAt)}`
          : 'Deadline unknown'}{' '}
        ·{' '}
        {item.availability === 'missing'
          ? 'Not in latest API snapshot'
          : item.availability}{' '}
        · {item.effectiveSensitivity}
      </p>
      <details>
        <summary>Assignment details</summary>
        {item.attachmentDerived && (
          <p>Linked file-derived source · Excluded from AI</p>
        )}
        <p>Possible points: {item.providerData.pointsPossible ?? 'Unknown'}</p>
        <p>
          Published:{' '}
          {item.providerData.published === null
            ? 'Unknown'
            : item.providerData.published
              ? 'Yes'
              : 'No'}{' '}
          · Locked:{' '}
          {item.providerData.locked === null
            ? 'Unknown'
            : item.providerData.locked
              ? 'Yes'
              : 'No'}
        </p>
      </details>
      {item.notes && (
        <details>
          <summary>Personal notes</summary>
          <p className="canvas-text">{item.notes}</p>
        </details>
      )}
      <a
        className="link-button"
        href={`https://canvas.colorado.edu/courses/${course.providerId}/assignments/${item.providerId}`}
        target="_blank"
        rel="noreferrer"
      >
        Open in Canvas
      </a>
    </article>
  );
}
