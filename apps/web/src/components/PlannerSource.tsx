import type { PlannerSource as Source, Task } from '@hub/contracts';

type AcademicSummary = NonNullable<Task['academicSource']>;
export function PlannerSource({
  source,
}: {
  source: Source | null | undefined;
}) {
  if (!source) return null;
  return (
    <details>
      <summary>
        Canvas source
        {source.currentVersion !== source.version ||
        source.currentCourseVersion !== source.courseVersion
          ? ' · Changed'
          : ''}
        {source.currentAvailability !== 'available'
          ? ` · ${source.currentAvailability}`
          : ''}
      </summary>
      <p>
        Created from: {source.title} · Version {source.version} ·{' '}
        {source.inputKind} · {source.sensitivity}
      </p>
      <p>
        Current: {source.currentTitle} · Version {source.currentVersion} ·{' '}
        {source.currentAvailability} · {source.currentSensitivity}
      </p>
      {(source.attachmentDerived || source.currentAttachmentDerived) && (
        <p>File-derived source · Excluded from AI</p>
      )}
      <p>
        Captured time:{' '}
        {source.timing.startDate ?? source.timing.startsAt ?? 'No date'}
        {source.timing.endDate || source.timing.endsAt
          ? ` → ${source.timing.endDate ?? source.timing.endsAt}`
          : ''}
      </p>
      <p>
        Current time:{' '}
        {source.currentTiming.startDate ??
          source.currentTiming.startsAt ??
          'No date'}
        {source.currentTiming.endDate || source.currentTiming.endsAt
          ? ` → ${source.currentTiming.endDate ?? source.currentTiming.endsAt}`
          : ''}
      </p>
      {source.sourceUrl && (
        <a href={source.sourceUrl} target="_blank" rel="noreferrer">
          Open in Canvas
        </a>
      )}
    </details>
  );
}

const statusLabels = {
  planned: 'Planned',
  in_progress: 'In progress',
  submitted: 'Submitted',
  cancelled: 'Cancelled',
} as const;

/** Link from a task to the class work it was planned from. */
export function AcademicSource({
  source,
}: {
  source: AcademicSummary | null | undefined;
}) {
  if (!source) return null;
  const changed =
    source.currentWorkVersion !== source.capturedWorkVersion ||
    source.currentCourseVersion !== source.capturedCourseVersion;
  return (
    <details>
      <summary>
        Class work
        {changed ? ' · Changed' : ''}
        {source.sourceDeleted ? ' · Deleted' : ''}
        {source.courseArchived ? ' · Class archived' : ''}
      </summary>
      <p>
        Work status: {statusLabels[source.currentStatus]} · Version{' '}
        {source.capturedWorkVersion} when planned, {source.currentWorkVersion}{' '}
        now
      </p>
      <p>
        Class version {source.capturedCourseVersion} when planned,{' '}
        {source.currentCourseVersion} now
      </p>
      {source.labels.length > 0 && <p>Labels: {source.labels.join(', ')}</p>}
      <p>Completing this task does not submit the work.</p>
    </details>
  );
}
