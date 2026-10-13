import { useCallback, useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import { Temporal } from '@hub/contracts';
import { RequestError, requestJson } from './api';
import { offlineChanged, offlineStatus } from './offline';
import { operationTracker } from './operations';

/** Transport failures (offline, timeout) have no useful browser message. */
const messageOf = (failure: unknown, fallback: string) =>
  failure instanceof Error &&
  !(failure instanceof TypeError || failure instanceof DOMException)
    ? failure.message
    : fallback;

/**
 * Loads data with abort on unmount and a generation guard, so a slow older
 * response never overwrites a newer one. Offline cached fallbacks come from
 * requestJson. Returned reload() resolves with the new data, or undefined on
 * failure (the error is kept in state).
 */
export function useResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
  options: { failure: string; refreshMs?: number; key?: string },
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
    // key: reload when the inputs of `load` change (e.g. a date range).
  }, [options.failure, options.key]);

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
  const [code, setCode] = useState('');

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
      setCode('');
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
        setCode(caught instanceof RequestError ? caught.code : '');
        return undefined;
      } finally {
        setPending(false);
      }
    },
    [tracker],
  );

  /** Clears the last error and any version conflict (after a deliberate reload). */
  const reset = useCallback(() => {
    setError('');
    setConflict(false);
    setCode('');
  }, []);

  /** code: the server error code of the last failure, or '' (e.g. offline). */
  return { run, pending, error, conflict, code, setError, reset };
}

/** Browser connectivity, updated on online/offline events. */
export function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}

export type OfflineStatus = Awaited<ReturnType<typeof offlineStatus>>;

/** Task outbox state (queued, conflicted, locked) for inline row status. */
export function useOfflineStatus() {
  const [status, setStatus] = useState<OfflineStatus | null>(null);
  useEffect(() => {
    const refresh = () => {
      void offlineStatus().then(setStatus, () => undefined);
    };
    refresh();
    window.addEventListener(offlineChanged, refresh);
    return () => window.removeEventListener(offlineChanged, refresh);
  }, []);
  return status;
}

/** Today's local date (YYYY-MM-DD). Updates once at local midnight and when
 *  the app regains focus, never on a timer that repaints the screen. */
export function useToday(timeZone: string) {
  const [today, setToday] = useState(() =>
    Temporal.Now.plainDateISO(timeZone).toString(),
  );
  useEffect(() => {
    const check = () =>
      setToday(Temporal.Now.plainDateISO(timeZone).toString());
    const next = Temporal.PlainDate.from(today)
      .add({ days: 1 })
      .toZonedDateTime(timeZone);
    const timer = setTimeout(
      check,
      Math.max(1, next.epochMilliseconds - Date.now()),
    );
    window.addEventListener('focus', check);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', check);
    };
  }, [today, timeZone]);
  return today;
}
