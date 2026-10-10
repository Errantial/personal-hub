import type { PlannerSource as Source } from '@hub/contracts';
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
        {source.currentVersion !== source.version ? ' · Changed' : ''}
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
