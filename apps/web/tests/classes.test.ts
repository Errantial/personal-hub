import { expect, it } from 'vitest';
import type { CalendarRecord } from '@hub/contracts';
import {
  assessmentLabel,
  averageProgress,
  minutesLabel,
  priorityLabel,
  scoreLabel,
  splitStudyBlocks,
  workBatchBody,
} from '../src/lib/classes';

const block = (extra: Partial<CalendarRecord> = {}): CalendarRecord => ({
  id: '00000000-0000-4000-8000-000000000001',
  title: 'Study',
  notes: '',
  startsAt: '2027-03-08T15:00:00.000Z',
  endsAt: '2027-03-08T16:00:00.000Z',
  timeZone: 'America/New_York',
  sensitivity: 'unlabeled',
  allDay: false,
  startDate: null,
  endDate: null,
  recurrence: null,
  courseId: 'c1',
  topicId: null,
  studyStatus: 'planned',
  version: 1,
  createdAt: '2027-03-01T00:00:00.000Z',
  updatedAt: '2027-03-01T00:00:00.000Z',
  deletedAt: null,
  academicLabels: [],
  canvasSource: null,
  academicSource: null,
  ...extra,
});

it('says "Not assessed" until progress or confidence is entered', () => {
  expect(assessmentLabel({ progress: 0, confidence: 'unknown' })).toBe(
    'Not assessed',
  );
  expect(assessmentLabel({ progress: 40, confidence: 'low' })).toBe(
    '40% complete · confidence: low',
  );
  // An explicit 0% with a stated confidence is an assessment.
  expect(assessmentLabel({ progress: 0, confidence: 'low' })).toBe(
    '0% complete · confidence: low',
  );
});

it('averages only assessed topics and is null without any', () => {
  expect(averageProgress([])).toBeNull();
  expect(averageProgress([{ progress: 0, confidence: 'unknown' }])).toBeNull();
  expect(
    averageProgress([
      { progress: 0, confidence: 'unknown' },
      { progress: 40, confidence: 'low' },
      { progress: 61, confidence: 'high' },
    ]),
  ).toBe(51);
});

it('splits study blocks by class into upcoming and earlier', () => {
  const now = new Date('2027-03-10T00:00:00.000Z');
  const soon = block({
    id: 'a',
    startsAt: '2027-03-12T15:00:00.000Z',
    endsAt: '2027-03-12T16:00:00.000Z',
  });
  const later = block({
    id: 'b',
    startsAt: '2027-03-20T15:00:00.000Z',
    endsAt: '2027-03-20T16:00:00.000Z',
  });
  const past = block({ id: 'c' });
  const older = block({
    id: 'd',
    startsAt: '2027-03-01T15:00:00.000Z',
    endsAt: '2027-03-01T16:00:00.000Z',
  });
  const repeating = block({
    id: 'e',
    startsAt: '2027-03-01T15:00:00.000Z',
    endsAt: '2027-03-01T16:00:00.000Z',
    recurrence: { frequency: 'daily', interval: 1, count: null, until: null },
  });
  const result = splitStudyBlocks(
    [
      later,
      older,
      soon,
      past,
      repeating,
      block({ id: 'x', courseId: 'other' }),
      block({ id: 'y', deletedAt: '2027-03-05T00:00:00.000Z' }),
    ],
    'c1',
    now,
  );
  expect(result.upcoming.map((item) => item.id)).toEqual(['e', 'a', 'b']);
  expect(result.earlier.map((item) => item.id)).toEqual(['c', 'd']);
});

it('labels academic estimates, priorities and scores', () => {
  expect(minutesLabel(null)).toBe('No estimate');
  expect(minutesLabel(0)).toBe('0 min');
  expect(minutesLabel(120)).toBe('2 h');
  expect(minutesLabel(150)).toBe('2 h 30 min');
  expect(priorityLabel(5)).toBe('5 (highest)');
  expect(priorityLabel(1)).toBe('1 (lowest)');
  expect(priorityLabel(3)).toBe('3');
  expect(scoreLabel({ earned: 18, possible: 20 })).toBe('18 / 20 (90%)');
});

it('builds academic batch bodies with class versions and explicit clears', () => {
  const selection = new Map([
    ['b', 2],
    ['a', 5],
  ]);
  expect(workBatchBody(selection, 7, { kind: 'delete' })).toEqual({
    items: [
      { id: 'b', expectedVersion: 2, expectedCourseVersion: 7 },
      { id: 'a', expectedVersion: 5, expectedCourseVersion: 7 },
    ],
    action: { kind: 'delete' },
  });
  const action = (change: Parameters<typeof workBatchBody>[2]) =>
    workBatchBody(selection, 7, change).action;
  expect(action({ kind: 'status', status: 'submitted' })).toEqual({
    kind: 'update',
    changes: { status: 'submitted' },
  });
  expect(action({ kind: 'priority', priority: 5 })).toEqual({
    kind: 'update',
    changes: { priority: 5 },
  });
  expect(action({ kind: 'due', dueDate: null })).toEqual({
    kind: 'update',
    changes: { dueDate: null },
  });
  expect(action({ kind: 'estimate', estimatedMinutes: 0 })).toEqual({
    kind: 'update',
    changes: { estimatedMinutes: 0 },
  });
});
