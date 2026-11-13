import { afterEach, expect, it, vi } from 'vitest';
import { createNativeInfoLoader } from '../src/lib/native-info';

afterEach(() => {
  vi.useRealTimers();
});

it('times out a hung native-info read and reports an error', async () => {
  vi.useFakeTimers();
  const onError = vi.fn();
  const onValue = vi.fn();
  const loader = createNativeInfoLoader({
    read: () => new Promise(() => undefined),
    timeoutMs: 5000,
    onChecking: vi.fn(),
    onValue,
    onError,
  });
  loader.load();
  await vi.advanceTimersByTimeAsync(5000);
  expect(onError).toHaveBeenCalledTimes(1);
  expect(onValue).not.toHaveBeenCalled();
  loader.dispose();
});

it('ignores a stale read after a newer refresh', async () => {
  vi.useFakeTimers();
  const resolvers: ((value: string | null) => void)[] = [];
  const onChecking = vi.fn();
  const onValue = vi.fn();
  const loader = createNativeInfoLoader({
    read: () =>
      new Promise<string | null>((resolve) => {
        resolvers.push(resolve);
      }),
    timeoutMs: 5000,
    onChecking,
    onValue,
    onError: vi.fn(),
  });
  loader.load();
  loader.load();
  expect(onChecking).toHaveBeenCalledTimes(2);
  resolvers[0]?.('stale');
  await Promise.resolve();
  await Promise.resolve();
  expect(onValue).not.toHaveBeenCalled();
  resolvers[1]?.('fresh');
  await Promise.resolve();
  await Promise.resolve();
  expect(onValue).toHaveBeenCalledWith('fresh');
  loader.dispose();
});
