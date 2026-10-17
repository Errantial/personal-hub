import { expect, it } from 'vitest';
import {
  canonicalItemLinks,
  CollectionError,
  normalizeCourses,
  normalizeItems,
} from '../src/extract.js';

it('normalizes two course layouts without retaining unrelated page content', () => {
  expect(
    normalizeCourses([
      {
        href: '/courses/20',
        title: ' Course from dashboard ',
      },
      {
        href: 'https://canvas.colorado.edu/courses/10',
        title: 'Course from card layout',
      },
      {
        href: 'https://canvas.colorado.edu/courses/10/assignments',
        title: 'Nested link ignored',
      },
      {
        href: 'https://evil.example/courses/30',
        title: 'Foreign ignored',
      },
    ]),
  ).toEqual([
    {
      providerId: '10',
      name: 'Course from card layout',
      canonicalUrl: 'https://canvas.colorado.edu/courses/10',
    },
    {
      providerId: '20',
      name: 'Course from dashboard',
      canonicalUrl: 'https://canvas.colorado.edu/courses/20',
    },
  ]);
  expect(() =>
    normalizeCourses([
      {
        href: 'https://canvas.colorado.edu/courses/10?view=card',
        title: 'Ambiguous canonical identity',
      },
    ]),
  ).toThrow(CollectionError);
});

it('keeps assignment and quiz identities distinct and takes only machine-readable due times', () => {
  expect(
    normalizeItems('10', [
      {
        href: '/courses/10/assignments/7',
        title: 'Assignment',
        dueAt: '2026-11-01T18:00:00Z',
        hasDueLabel: true,
      },
      {
        href: '/courses/10/quizzes/7',
        title: 'Quiz',
        dueAt: null,
        hasDueLabel: false,
      },
    ]),
  ).toEqual([
    {
      resourceKind: 'assignment',
      providerId: '7',
      canonicalUrl: 'https://canvas.colorado.edu/courses/10/assignments/7',
      title: 'Assignment',
      dueAt: '2026-11-01T18:00:00.000Z',
    },
    {
      resourceKind: 'quiz',
      providerId: '7',
      canonicalUrl: 'https://canvas.colorado.edu/courses/10/quizzes/7',
      title: 'Quiz',
      dueAt: null,
    },
  ]);
});

it('fails closed on ambiguous due labels, cross-course links and duplicate identities', () => {
  expect(() =>
    normalizeItems('10', [
      {
        href: '/courses/10/assignments/7',
        title: 'Missing machine due time',
        dueAt: null,
        hasDueLabel: true,
      },
    ]),
  ).toThrow(CollectionError);
  expect(() =>
    normalizeItems('10', [
      {
        href: '/courses/10/assignments/8',
        title: 'Ambiguous local due time',
        dueAt: '2026-11-01T18:00:00',
        hasDueLabel: true,
      },
    ]),
  ).toThrow(CollectionError);
  expect(() =>
    normalizeItems('10', [
      {
        href: '/courses/11/assignments/7',
        title: 'Wrong course',
        dueAt: null,
        hasDueLabel: false,
      },
    ]),
  ).toThrow(CollectionError);
  expect(() =>
    normalizeItems('10', [
      {
        href: '/courses/10/assignments/7',
        title: 'First',
        dueAt: null,
        hasDueLabel: false,
      },
      {
        href: '/courses/10/assignments/7',
        title: 'Second',
        dueAt: null,
        hasDueLabel: false,
      },
    ]),
  ).toThrow(CollectionError);
});

it('builds an exact canonical item-link coverage set and rejects decorated item links', () => {
  expect(
    canonicalItemLinks('10', [
      '/courses/10/assignments/7',
      '/courses/10/quizzes/8',
      '/courses/11/assignments/9',
      'https://evil.example/courses/10/assignments/10',
    ]),
  ).toEqual([
    'https://canvas.colorado.edu/courses/10/assignments/7',
    'https://canvas.colorado.edu/courses/10/quizzes/8',
  ]);
  expect(() =>
    canonicalItemLinks('10', ['/courses/10/assignments/7?module_item_id=1']),
  ).toThrow(CollectionError);
});
