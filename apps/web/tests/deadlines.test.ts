import { expect, it } from 'vitest';
import type { TrackedDeadline } from '@hub/contracts';
import {
  deadlineDueDraft,
  deadlineDueOverride,
  deadlinePersonalDueDraft,
  dueFallsOn,
  safeCanvasHref,
} from '../src/lib/deadlines';

const deadline = (extra: Partial<TrackedDeadline> = {}) =>
  ({
    id: '00000000-0000-4000-8000-000000000001',
    providerKind: 'canvas',
    canonicalKey: 'canvas:canvas.colorado.edu:/courses/1/assignments/2',
    version: 1,
    completedAt: null,
    priority: 'normal',
    notes: '',
    titleOverride: null,
    dueOverride: { kind: 'provider' },
    sensitivity: 'unlabeled',
    sourceLabels: ['unlabeled'],
    createdAt: '2026-10-19T12:00:00.000Z',
    updatedAt: '2026-10-19T12:00:00.000Z',
    title: 'Imported assignment',
    due: {
      kind: 'timed',
      dueAt: '2027-11-07T06:30:00.000Z',
      timeZone: 'America/New_York',
    },
    providerDue: {
      kind: 'timed',
      dueAt: '2027-11-07T06:30:00.000Z',
      timeZone: 'America/New_York',
    },
    sourceUrl: 'https://canvas.colorado.edu/courses/1/assignments/2',
    sourceAvailability: 'available',
    sourceCoverage: ['assignment-api'],
    sourceConflict: false,
    alternateTimedDue: null,
    labels: ['unlabeled'],
    effectiveSensitivity: 'unlabeled',
    sources: [],
    ...extra,
  }) as TrackedDeadline;

it('keeps the provider due mode distinct from a Personal Hub override', () => {
  const draft = deadlineDueDraft(deadline());
  expect(draft.mode).toBe('provider');
  expect(deadlineDueOverride(draft)).toEqual({ kind: 'provider' });

  const personal = deadlinePersonalDueDraft({
    kind: 'date',
    dueDate: '2027-11-08',
  });
  expect(deadlineDueOverride(personal)).toEqual({
    kind: 'date',
    dueDate: '2027-11-08',
  });
});

it('round-trips a repeated timed override with its selected offset', () => {
  const source = deadline({
    dueOverride: {
      kind: 'timed',
      dueAt: '2027-11-07T06:30:00.000Z',
      timeZone: 'America/New_York',
    },
  });
  const draft = deadlineDueDraft(source);
  expect(draft).toMatchObject({
    mode: 'personal',
    value: {
      dueDate: '2027-11-07',
      dueTime: '01:30',
      dueTimeZone: 'America/New_York',
      dueOffset: 'later',
    },
  });
  expect(deadlineDueOverride(draft)).toEqual(source.dueOverride);
});

it('places timed deadlines by the viewing timezone while date-only values stay fixed', () => {
  const timed = {
    kind: 'timed' as const,
    dueAt: '2026-10-15T00:30:00.000Z',
    timeZone: 'UTC',
  };
  expect(dueFallsOn(timed, '2026-10-14', 'America/Denver')).toBe(true);
  expect(dueFallsOn(timed, '2026-10-15', 'America/Denver')).toBe(false);
  expect(
    dueFallsOn({ kind: 'date', dueDate: '2026-10-15' }, '2026-10-15', 'UTC'),
  ).toBe(true);
});

it('only exposes canonical Canvas assignment or quiz links', () => {
  expect(
    safeCanvasHref('https://canvas.colorado.edu/courses/12/assignments/34'),
  ).toBe('https://canvas.colorado.edu/courses/12/assignments/34');
  expect(
    safeCanvasHref('https://canvas.colorado.edu/courses/12/quizzes/34'),
  ).toBe('https://canvas.colorado.edu/courses/12/quizzes/34');
  expect(
    safeCanvasHref('https://evil.example/courses/12/assignments/34'),
  ).toBeNull();
  expect(safeCanvasHref('javascript:alert(1)')).toBeNull();
});
