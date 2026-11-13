/**
 * Runs one native-info read at a time and ignores stale or timed-out results.
 * Kept outside React so the generation/timeout behavior is unit-testable.
 */
export function createNativeInfoLoader<T>(options: {
  read: () => Promise<T | null>;
  timeoutMs: number;
  onChecking: () => void;
  onValue: (value: T | null) => void;
  onError: () => void;
  schedule?: (
    callback: () => void,
    ms: number,
  ) => ReturnType<typeof setTimeout>;
  clear?: (handle: ReturnType<typeof setTimeout>) => void;
}) {
  const schedule = options.schedule ?? setTimeout;
  const clear = options.clear ?? clearTimeout;
  let generation = 0;
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const load = () => {
    const request = ++generation;
    let settled = false;
    if (timer) clear(timer);
    options.onChecking();
    const timeout = new Promise<never>((_, reject) => {
      timer = schedule(
        () => reject(new Error('Native app information timed out.')),
        options.timeoutMs,
      );
    });
    void Promise.race([options.read(), timeout]).then(
      (value) => {
        if (!active || request !== generation || settled) return;
        settled = true;
        if (timer) clear(timer);
        timer = undefined;
        options.onValue(value);
      },
      () => {
        if (!active || request !== generation || settled) return;
        settled = true;
        if (timer) clear(timer);
        timer = undefined;
        options.onError();
      },
    );
  };

  return {
    load,
    dispose() {
      active = false;
      if (timer) clear(timer);
      timer = undefined;
    },
  };
}
