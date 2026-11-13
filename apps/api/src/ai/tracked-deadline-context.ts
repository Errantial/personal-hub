import { Temporal, sensitivitySchema } from '@hub/contracts';
import type { TrackedDeadline, TrackedDeadlineDue } from '@hub/contracts';
import { z } from 'zod';
import type { QueryExecutor } from '../db/database.js';
import {
  readTrackedDeadline,
  readTrackedDeadlines,
} from '../connections/canvas-deadlines.js';
import { sourceDigest } from './live-manifest.js';
import type { LiveHistorySource, LiveSource } from './live-manifest.js';

type Sensitivity = z.infer<typeof sensitivitySchema>;
type NetworkKind = 'calendar-feed' | 'assignment-api';

export type TrackedDeadlineDependency = {
  kind: NetworkKind;
  id: string;
  version: number;
};

export type TrackedDeadlineProjected = {
  ref: string;
  title: string;
  due: { kind: 'timed'; at: string } | { kind: 'date'; date: string };
  priority: 'low' | 'normal' | 'high';
  completed: boolean;
};

export type TrackedDeadlineContextItem = {
  id: string;
  version: number;
  labels: Sensitivity[];
  dependencies: TrackedDeadlineDependency[];
  ref: string;
  projected: TrackedDeadlineProjected;
  snapshot: {
    title: string;
    due: TrackedDeadlineDue;
    priority: 'low' | 'normal' | 'high';
  };
};

export type TrackedDeadlineContext = {
  items: TrackedDeadlineContextItem[];
  withheld: number;
};

const networkKinds = new Set<NetworkKind>(['calendar-feed', 'assignment-api']);

const sameDue = (left: TrackedDeadlineDue, right: TrackedDeadlineDue) =>
  JSON.stringify(left) === JSON.stringify(right);

const labelsOf = (deadline: TrackedDeadline): Sensitivity[] => [
  ...new Set<Sensitivity>([
    ...deadline.labels,
    sensitivitySchema.parse(deadline.effectiveSensitivity),
  ]),
];

const dependenciesOf = (
  deadline: TrackedDeadline,
): TrackedDeadlineDependency[] =>
  deadline.sources
    .filter(
      (source) =>
        source.identityMatches &&
        source.availability === 'available' &&
        networkKinds.has(source.kind as NetworkKind),
    )
    .map((source) => ({
      kind: source.kind as NetworkKind,
      id: source.sourceId,
      version: source.currentVersion,
    }))
    .sort(
      (left, right) =>
        left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id),
    );

function networkCanProject(
  deadline: TrackedDeadline,
  dependencies: TrackedDeadlineDependency[],
) {
  if (!dependencies.length) return false;
  const dependencyIds = new Set(dependencies.map((value) => value.id));
  const sources = deadline.sources.filter((source) =>
    dependencyIds.has(source.sourceId),
  );
  if (
    deadline.titleOverride === null &&
    !sources.some((source) => source.title === deadline.title)
  )
    return false;
  if (
    deadline.dueOverride.kind === 'provider' &&
    !sources.some((source) => sameDue(source.due, deadline.due))
  )
    return false;
  return true;
}

const localDate = (
  deadline: TrackedDeadline,
  timeZone: string,
): string | null => {
  if (deadline.due.kind === 'date') return deadline.due.dueDate;
  if (deadline.due.kind === 'unknown') return null;
  return Temporal.Instant.from(deadline.due.dueAt)
    .toZonedDateTimeISO(timeZone)
    .toPlainDate()
    .toString();
};

export function projectTrackedDeadline(
  deadline: TrackedDeadline,
  ref: string,
  timeZone: string,
): TrackedDeadlineProjected | null {
  if (deadline.due.kind === 'unknown') return null;
  return {
    ref,
    title: deadline.title,
    due:
      deadline.due.kind === 'date'
        ? { kind: 'date', date: deadline.due.dueDate }
        : {
            kind: 'timed',
            at: Temporal.Instant.from(deadline.due.dueAt)
              .toZonedDateTimeISO(timeZone)
              .toPlainDateTime()
              .toString({ smallestUnit: 'minute' }),
          },
    priority: deadline.priority,
    completed: deadline.completedAt !== null,
  };
}

function eligibleItem(
  deadline: TrackedDeadline,
  allowed: Sensitivity[],
  timeZone: string,
  ref: string,
  options: { allowCompleted?: boolean } = {},
): TrackedDeadlineContextItem | null {
  if (deadline.sourceConflict) return null;
  if (deadline.completedAt && !options.allowCompleted) return null;
  const labels = labelsOf(deadline);
  if (labels.some((label) => !allowed.includes(label))) return null;
  const dependencies = dependenciesOf(deadline);
  if (!networkCanProject(deadline, dependencies)) return null;
  const projected = projectTrackedDeadline(deadline, ref, timeZone);
  if (!projected) return null;
  return {
    id: deadline.id,
    version: deadline.version,
    labels,
    dependencies,
    ref,
    projected,
    snapshot: {
      title: deadline.title,
      due: deadline.due,
      priority: deadline.priority,
    },
  };
}

/**
 * Automatic deadline-watch context only. Open concrete deadlines overdue or
 * due within the next seven local days are considered, then capped at 50.
 */
export async function trackedDeadlineContext(
  tx: QueryExecutor,
  owner: string,
  allowed: Sensitivity[],
  timeZone: string,
  now = Temporal.Now.instant(),
  options: { includeCompleted?: boolean } = {},
): Promise<TrackedDeadlineContext> {
  const today = now.toZonedDateTimeISO(timeZone).toPlainDate();
  const last = today.add({ days: 7 }).toString();
  const completedSince = now.subtract({ hours: 24 * 30 });
  const deadlines = await readTrackedDeadlines(tx, owner);
  const open: TrackedDeadlineContextItem[] = [];
  const completed: {
    item: TrackedDeadlineContextItem;
    completedAt: string;
  }[] = [];
  let withheld = 0;
  for (const deadline of deadlines) {
    if (deadline.completedAt) {
      if (!options.includeCompleted) continue;
      if (
        Temporal.Instant.from(deadline.completedAt).epochMilliseconds <
        completedSince.epochMilliseconds
      ) {
        withheld += 1;
        continue;
      }
      const item = eligibleItem(deadline, allowed, timeZone, 'd1', {
        allowCompleted: true,
      });
      if (!item) {
        withheld += 1;
        continue;
      }
      completed.push({ item, completedAt: deadline.completedAt });
      continue;
    }
    const date = localDate(deadline, timeZone);
    if (date === null) {
      withheld += 1;
      continue;
    }
    if (date > last) continue;
    const item = eligibleItem(deadline, allowed, timeZone, 'd1');
    if (!item) {
      withheld += 1;
      continue;
    }
    open.push(item);
  }
  const byDue = (left: TrackedDeadlineContextItem) =>
    left.projected.due.kind === 'date'
      ? `${left.projected.due.date}Z`
      : left.projected.due.at;
  open.sort(
    (left, right) =>
      byDue(left).localeCompare(byDue(right)) ||
      left.id.localeCompare(right.id),
  );
  completed.sort(
    (left, right) =>
      right.completedAt.localeCompare(left.completedAt) ||
      left.item.id.localeCompare(right.item.id),
  );
  const selectedOpen = open.slice(0, 50);
  const selectedCompleted = completed.slice(0, 20).map((value) => value.item);
  withheld +=
    open.length -
    selectedOpen.length +
    (completed.length - selectedCompleted.length);
  const selected = [...selectedOpen, ...selectedCompleted].map(
    (item, index) => {
      const ref = `d${index + 1}`;
      return { ...item, ref, projected: { ...item.projected, ref } };
    },
  );
  return { items: selected, withheld };
}

export function trackedDeadlineSources(
  owner: string,
  requestId: string,
  items: TrackedDeadlineContextItem[],
): LiveSource[] {
  return items.map((item): LiveSource => ({
    projection: 'tracked-deadline-v1',
    kind: 'tracked-deadline',
    id: item.id,
    version: item.version,
    ref: item.ref,
    labels: item.labels,
    deadlineSources: item.dependencies,
    digest: sourceDigest(
      owner,
      requestId,
      'tracked-deadline-v1',
      item.id,
      item.projected,
    ),
  }));
}

/** Re-resolves one bound source for the final guard, outside the dynamic horizon. */
export async function reprojectTrackedDeadlineSource(
  tx: QueryExecutor,
  owner: string,
  requestId: string,
  source: LiveSource,
  allowed: Sensitivity[],
  timeZone: string,
): Promise<LiveSource | null> {
  let deadline: TrackedDeadline;
  try {
    deadline = await readTrackedDeadline(tx, owner, source.id);
  } catch {
    return null;
  }
  const item = eligibleItem(deadline, allowed, timeZone, source.ref, {
    allowCompleted: true,
  });
  if (!item) return null;
  return trackedDeadlineSources(owner, requestId, [item])[0] ?? null;
}

export async function trackedDeadlineHistoryEligible(
  tx: QueryExecutor,
  owner: string,
  source: LiveHistorySource,
  allowed: Sensitivity[],
) {
  if (
    source.kind !== 'tracked-deadline' ||
    source.version === undefined ||
    !source.deadlineSources?.length
  )
    return false;
  let deadline: TrackedDeadline;
  try {
    deadline = await readTrackedDeadline(tx, owner, source.id);
  } catch {
    return false;
  }
  if (deadline.version !== source.version) return false;
  const labels = labelsOf(deadline);
  if (
    labels.some((label) => !allowed.includes(label)) ||
    labels.length !== source.labels.length ||
    !labels.every((label) => source.labels.includes(label)) ||
    deadline.sourceConflict
  )
    return false;
  const dependencies = dependenciesOf(deadline);
  if (!networkCanProject(deadline, dependencies)) return false;
  return (
    dependencies.length === source.deadlineSources.length &&
    dependencies.every((dependency, index) => {
      const bound = source.deadlineSources![index];
      return (
        dependency.kind === bound?.kind &&
        dependency.id === bound.id &&
        dependency.version === bound.version
      );
    })
  );
}
