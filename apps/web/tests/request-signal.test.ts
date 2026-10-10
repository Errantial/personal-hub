import { afterEach, expect, it, vi } from 'vitest';
import { requestSignal } from '../src/lib/request-signal';

afterEach(() => vi.useRealTimers());
it('preserves cancellation and its reason without AbortSignal.any', () => {
  const parent = new AbortController();
  const request = requestSignal(parent.signal);
  parent.abort(new DOMException('Cancelled', 'AbortError'));
  expect(request.signal.aborted).toBe(true);
  expect(request.signal.reason).toBe(parent.signal.reason);
  request.dispose();
  const alreadyCancelled = requestSignal(parent.signal);
  expect(alreadyCancelled.signal.aborted).toBe(true);
  alreadyCancelled.dispose();
});
it('enforces a deadline and removes timers/listeners after completion', () => {
  vi.useFakeTimers();
  const request = requestSignal(undefined, 8000);
  vi.advanceTimersByTime(8000);
  expect(request.signal.reason.name).toBe('TimeoutError');
  request.dispose();
  const parent = new AbortController();
  const completed = requestSignal(parent.signal);
  completed.dispose();
  parent.abort();
  vi.advanceTimersByTime(8000);
  expect(completed.signal.aborted).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
