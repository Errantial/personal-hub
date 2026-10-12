import type { CanvasItem } from '@hub/contracts';

export function CanvasEntry({
  item,
  timeZone,
  showDate = false,
}: {
  item: CanvasItem;
  timeZone: string;
  showDate?: boolean;
}) {
  const data = item.providerData;
  const format = (instant: string) =>
    new Date(instant).toLocaleString(
      undefined,
      showDate
        ? { timeZone }
        : { timeZone, hour: 'numeric', minute: '2-digit' },
    );
  const point = !data.endsAt || data.endsAt === data.startsAt;
  return (
    <article
      className={`calendar-event canvas-agenda-entry ${item.availability !== 'available' ? 'cancelled' : ''}`}
      aria-label={`Canvas entry ${data.title}`}
    >
      <strong>{data.title}</strong>
      <small>
        {data.allDay
          ? `${showDate ? `${data.startDate} · ` : ''}All day`
          : data.startsAt
            ? `${point ? 'Deadline · ' : ''}${format(data.startsAt)}${!point && data.endsAt ? ` – ${format(data.endsAt)}` : ''}`
            : 'No date'}
      </small>
      <small>
        Canvas · Read only ·{' '}
        {item.availability === 'missing'
          ? 'Not in latest feed'
          : item.availability}{' '}
        · {item.effectiveSensitivity}
      </small>
      {item.courseId && (
        <small>
          {item.courseName ?? 'Class'}
          {item.courseDeleted ? ' · Archived class' : ''}
        </small>
      )}
      {item.notes && (
        <details>
          <summary>Personal notes</summary>
          <p className="canvas-text">{item.notes}</p>
        </details>
      )}
      {data.sourceUrl && (
        <a
          className="link-button"
          href={data.sourceUrl}
          target="_blank"
          rel="noreferrer"
        >
          Open in Canvas
        </a>
      )}
    </article>
  );
}
