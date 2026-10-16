import { formatInstant } from '../lib/format';
/** Per-read loading, error, cache time and reload control. */
export function ReadState({
  resource,
  label,
  showReload = true,
}: {
  resource: {
    loading: boolean;
    error: string;
    data: { cachedAt: string | null } | undefined;
    reload: () => Promise<unknown>;
  };
  label: string;
  showReload?: boolean;
}) {
  return (
    <>
      {resource.loading && !resource.data && <p role="status">Loading…</p>}
      {resource.error && <p role="alert">{resource.error}</p>}
      {resource.data?.cachedAt && (
        <p className="meta">
          Cached {label}: {formatInstant(resource.data.cachedAt)}
        </p>
      )}
      {showReload && (
        <button
          type="button"
          className="text-button"
          disabled={resource.loading}
          onClick={() => {
            void resource.reload();
          }}
        >
          {resource.error ? 'Retry' : 'Reload'} {label}
        </button>
      )}
    </>
  );
}
