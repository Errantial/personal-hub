// AbortSignal.any is absent from older Android WebViews. Keep caller
// cancellation and the request deadline without requiring that static API.
export function requestSignal(parent?: AbortSignal, timeoutMs = 8000) {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason);
  if (parent?.aborted) abort();
  else parent?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new DOMException('Request timed out.', 'TimeoutError'));
  }, timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', abort);
    },
  };
}
