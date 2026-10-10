/* Operation identity for idempotent writes. A retry of an unchanged request
   (for example after a lost response) reuses its operation ID so the server
   returns the original receipt; any change to method, path or payload starts
   a new operation. See docs/ui-agent-ledger.md. */
export function operationTracker(
  create: () => string = () => crypto.randomUUID(),
) {
  let pending: { key: string; id: string } | null = null;
  return {
    prepare(method: string, path: string, body: Record<string, unknown>) {
      const key = JSON.stringify({ method, path, body });
      if (pending?.key !== key) pending = { key, id: create() };
      return { ...body, operationId: pending.id };
    },
    /** Call after a confirmed response so the next request is a new operation. */
    settle() {
      pending = null;
    },
  };
}
