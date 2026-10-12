import { expect, it } from 'vitest';
import type { CalendarRecord } from '@hub/contracts';
import {
  assessmentLabel,
  averageProgress,
  splitStudyBlocks,
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
