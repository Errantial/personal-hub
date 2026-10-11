import { expect, it } from 'vitest';
import { operationTracker } from '../src/lib/operations';

const ids = () => {
  let next = 0;
  return () => `op-${++next}`;
};

it('reuses the operation ID when an unchanged request is retried', () => {
  const tracker = operationTracker(ids());
  const first = tracker.prepare('PUT', '/api/v1/tasks/a', { title: 'A' });
  const retry = tracker.prepare('PUT', '/api/v1/tasks/a', { title: 'A' });
  expect(first).toEqual({ title: 'A', operationId: 'op-1' });
  expect(retry.operationId).toBe('op-1');
});

it('uses a new operation ID when the payload, path or method changes', () => {
  const tracker = operationTracker(ids());
  tracker.prepare('PUT', '/api/v1/tasks/a', { title: 'A' });
  expect(
    tracker.prepare('PUT', '/api/v1/tasks/a', { title: 'B' }).operationId,
  ).toBe('op-2');
  expect(
    tracker.prepare('DELETE', '/api/v1/tasks/a', { title: 'B' }).operationId,
  ).toBe('op-3');
  expect(
    tracker.prepare('DELETE', '/api/v1/tasks/b', { title: 'B' }).operationId,
  ).toBe('op-4');
});

it('starts a new operation after the previous one settles', () => {
  const tracker = operationTracker(ids());
  tracker.prepare('POST', '/api/v1/reminders', { title: 'A' });
  tracker.settle();
  expect(
    tracker.prepare('POST', '/api/v1/reminders', { title: 'A' }).operationId,
  ).toBe('op-2');
});

it('never lets a caller-supplied operationId override the tracked one', () => {
  const tracker = operationTracker(ids());
  expect(
    tracker.prepare('POST', '/api/v1/reminders', { operationId: 'forged' })
      .operationId,
  ).toBe('op-1');
});
