import { useCallback, useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import { RequestError, requestJson } from './api';
import { operationTracker } from './operations';

const messageOf = (failure: unknown, fallback: string) =>
  failure instanceof Error ? failure.message : fallback;

/**
 * Loads data with abort on unmount and a generation guard, so a slow older
 * response never overwrites a newer one. Offline cached fallbacks come from
 * requestJson. Returned reload() resolves with the new data, or undefined on
 * failure (the error is kept in state).
 */
export function useResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
  options: { failure: string; refreshMs?: number },
) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const loader = useRef(load);
  loader.current = load;
  const controller = useRef<AbortController | null>(null);

  const reload = useCallback(async () => {
    const current = ++generation.current;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setLoading(true);
    try {
      const result = await loader.current(request.signal);
      if (current !== generation.current) return undefined;
      setData(result);
      setError('');
      return result;
    } catch {
      if (current === generation.current && !request.signal.aborted)
        setError(options.failure);
      return undefined;
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [options.failure]);

  useEffect(() => {
    void reload();
    const timer = options.refreshMs
      ? setInterval(() => void reload(), options.refreshMs)
      : undefined;
    return () => {
      clearInterval(timer);
      generation.current++;
      controller.current?.abort();
    };
  }, [reload, options.refreshMs]);

  return { data, error, loading, reload, setError };
}

/**
 * One idempotent write action. Each instance keeps its own operation identity,
 * so a lost-response retry of an unchanged request reuses its operation ID
 * even if other actions ran in between. pending is per action, not page-wide.
 */
export function useMutation() {
  const tracker = useRef(operationTracker()).current;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);

  const run = useCallback(
    async <T>(
      schema: z.ZodType<T>,
      method: string,
      path: string,
      body: Record<string, unknown>,
      failure = 'Could not save. Your changes are still here.',
    ): Promise<T | undefined> => {
      setPending(true);
      setError('');
      setConflict(false);
      try {
        const result = await requestJson(path, schema, {
          method,
          body: tracker.prepare(method, path, body),
        });
        tracker.settle();
        return result;
      } catch (caught) {
        setError(messageOf(caught, failure));
        setConflict(
          caught instanceof RequestError && caught.code === 'VERSION_CONFLICT',
        );
        return undefined;
      } finally {
        setPending(false);
      }
    },
    [tracker],
  );

  return { run, pending, error, conflict, setError };
}
