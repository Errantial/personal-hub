import { useEffect, useRef, useState } from 'react';
import {
  canvasReconciliationListSchema,
  canvasReconciliationResponseSchema,
  canvasBrowserReconciliationResponseSchema,
  canvasAssignmentUrl,
} from '@hub/contracts';
import type { z } from 'zod';
import { requestJson } from '../lib/api';
import { Help } from './Help';
type Records = z.infer<typeof canvasReconciliationListSchema>;
const base = '/api/v1/connections/canvas/reconciliation';
export function CanvasReconciliation() {
  const [data, setData] = useState<Records | null>(null);
  const [draft, setDraft] = useState<{
    itemId: string;
    assignmentId: string;
    records: Records;
  } | null>(null);
  const [browserDraft, setBrowserDraft] = useState<{
    browserItemId: string;
    itemId: string;
    records: Records;
  } | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef<{ key: string; id: string } | null>(null);
  async function load(signal?: AbortSignal) {
    const records = await requestJson(
      base,
      canvasReconciliationListSchema,
      signal ? { signal } : {},
    );
    if (!signal?.aborted) setData(records);
    return records;
  }
  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal).catch(() => {
      if (!abort.signal.aborted) setError('Reconciliation unavailable.');
    });
    return () => abort.abort();
  }, []);
  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    setStatus('');
    try {
      await action();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Reconciliation failed.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function save(remove: boolean) {
    if (!draft) return;
    const item = draft.records.items.find((row) => row.id === draft.itemId)!;
    const old = draft.records.links.find((row) => row.itemId === item.id);
    const assignment = remove
      ? undefined
      : draft.records.assignments.find((row) => row.id === draft.assignmentId);
    const course = draft.records.courses.find(
      (row) => row.id === assignment?.canvasCourseId,
    );
    if (!remove && (!assignment || !course))
      throw new Error('Select an assignment.');
    const body = {
      expectedVersion: old?.version ?? null,
      expectedItemVersion: item.version,
      assignmentId: assignment?.id ?? null,
      expectedAssignmentVersion: assignment?.version ?? null,
      expectedCourseVersion: course?.version ?? null,
    };
    const key = JSON.stringify({ itemId: item.id, body });
    if (pending.current?.key !== key)
      pending.current = { key, id: crypto.randomUUID() };
    await requestJson(
      `${base}/${item.id}`,
      canvasReconciliationResponseSchema,
      { method: 'PUT', body: { ...body, operationId: pending.current.id } },
    );
    pending.current = null;
    setDraft(null);
    await load();
    setStatus(remove ? 'Link removed.' : 'Link confirmed.');
  }
  async function saveBrowser(remove: boolean) {
    if (!browserDraft) return;
    const browserItem = browserDraft.records.browserItems.find(
      (row) => row.id === browserDraft.browserItemId,
    )!;
    const old = browserDraft.records.browserLinks.find(
      (row) => row.browserItemId === browserItem.id,
    );
    const item = remove
      ? undefined
      : browserDraft.records.items.find(
          (row) => row.id === browserDraft.itemId,
        );
    if (!remove && !item) throw new Error('Select a calendar-feed item.');
    const body = {
      expectedVersion: old?.version ?? null,
      expectedBrowserItemVersion: browserItem.version,
      itemId: item?.id ?? null,
      expectedItemVersion: item?.version ?? null,
    };
    const key = JSON.stringify({ browserItemId: browserItem.id, body });
    if (pending.current?.key !== key)
      pending.current = { key, id: crypto.randomUUID() };
    await requestJson(
      `${base}/browser/${browserItem.id}`,
      canvasBrowserReconciliationResponseSchema,
      { method: 'PUT', body: { ...body, operationId: pending.current.id } },
    );
    pending.current = null;
    setBrowserDraft(null);
    await load();
    setStatus(remove ? 'Browser link removed.' : 'Browser link confirmed.');
  }
  const courses = new Map(data?.courses.map((row) => [row.id, row]));
  const assignments = new Map(data?.assignments.map((row) => [row.id, row]));
  const links = new Map(
    data?.links.filter((row) => !row.deletedAt).map((row) => [row.itemId, row]),
  );
  const byUrl = new Map<string, Records['assignments']>();
  for (const assignment of data?.assignments ?? []) {
    const course = courses.get(assignment.canvasCourseId);
    if (course) {
      const url = canvasAssignmentUrl(course.providerId, assignment.providerId);
      byUrl.set(url, [...(byUrl.get(url) ?? []), assignment]);
    }
  }
  const comparisons =
    data?.items.filter(
      (item) =>
        links.has(item.id) || byUrl.has(item.providerData.sourceUrl ?? ''),
    ) ?? [];
  const browserLinks = new Map(
    data?.browserLinks
      .filter((row) => !row.deletedAt)
      .map((row) => [row.browserItemId, row]),
  );
  const feedItems = new Map(data?.items.map((row) => [row.id, row]));
  const feedByUrl = new Map<string, Records['items']>();
  for (const item of data?.items ?? []) {
    const url = item.providerData.sourceUrl;
    if (url && item.availability === 'available')
      feedByUrl.set(url, [...(feedByUrl.get(url) ?? []), item]);
  }
  return (
    <section
      className="panel canvas-connection"
      aria-label="Canvas reconciliation"
    >
      <h3>Canvas reconciliation</h3>
      <Help label="Canvas reconciliation">
        Confirm matching assignment URLs to associate feed and API records.
        Titles, dates, notes and class links stay separate. Differences remain
        visible; no deadline wins automatically. Linked sources share labels and
        uploaded-file provenance. Removing a link retains a tombstone and
        captured planner provenance. Changes require a connection.
      </Help>
      <button
        disabled={busy}
        onClick={() =>
          void perform(async () => {
            await load();
          })
        }
      >
        Reload comparisons
      </button>
      {error && <p role="alert">{error}</p>}
      {status && <p role="status">{status}</p>}
      {data && (
        <>
          {comparisons.map((item) => {
            const link = links.get(item.id);
            const linked = assignments.get(link?.assignmentId ?? '');
            const candidates =
              byUrl.get(item.providerData.sourceUrl ?? '') ?? [];
            const candidate = linked ?? candidates[0];
            const course = courses.get(candidate?.canvasCourseId ?? '');
            const matches =
              course &&
              candidate &&
              item.providerData.sourceUrl ===
                canvasAssignmentUrl(course.providerId, candidate.providerId);
            const feedTime =
              item.providerData.startDate ?? item.providerData.startsAt;
            const editing = draft?.itemId === item.id;
            return (
              <article
                className="canvas-item"
                aria-label={`Compare ${item.providerData.title}`}
                key={item.id}
              >
                <strong>{item.providerData.title}</strong>
                <p>
                  {link ? 'Linked' : 'Unlinked'} · {item.availability} ·{' '}
                  {item.effectiveSensitivity}
                </p>
                {link && !matches && (
                  <p role="status">Assignment URL changed. Review this link.</p>
                )}
                <details>
                  <summary>Compare sources</summary>
                  <p>
                    Feed: {item.providerData.title} ·{' '}
                    {feedTime ?? 'Deadline unknown'} · {item.inputKind}
                  </p>
                  <p>
                    API:{' '}
                    {candidate?.providerData.title ?? 'Assignment unavailable'}{' '}
                    · {candidate?.providerData.dueAt ?? 'Deadline unknown'} ·{' '}
                    {candidate?.availability ?? 'Unknown'}
                  </p>
                  {feedTime !== candidate?.providerData.dueAt && (
                    <p>Dates differ.</p>
                  )}
                  {item.providerData.title !==
                    candidate?.providerData.title && <p>Titles differ.</p>}
                </details>
                {!editing && (
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() =>
                      setDraft({
                        itemId: item.id,
                        assignmentId: candidate?.id ?? '',
                        records: data,
                      })
                    }
                  >
                    {link ? 'Review link' : 'Link assignment'}
                  </button>
                )}
                {editing && (
                  <form
                    className="editor-form"
                    aria-label="Canvas reconciliation"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void perform(() => save(false));
                    }}
                  >
                    <label>
                      API assignment
                      <select
                        aria-label="Reconciliation assignment"
                        value={draft.assignmentId}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            assignmentId: event.target.value,
                          })
                        }
                      >
                        <option value="">Select assignment</option>
                        {candidates.map((row) => (
                          <option key={row.id} value={row.id}>
                            {row.providerData.title}
                          </option>
                        ))}
                        {linked &&
                          !candidates.some((row) => row.id === linked.id) && (
                            <option value={linked.id}>
                              {linked.providerData.title} · URL changed
                            </option>
                          )}
                      </select>
                    </label>
                    <div className="item-actions">
                      <button disabled={busy || !draft.assignmentId}>
                        Confirm link
                      </button>
                      {link && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void perform(() => save(true))}
                        >
                          Remove link
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void perform(async () => {
                            const records = await load();
                            setDraft((previous) =>
                              previous ? { ...previous, records } : null,
                            );
                          })
                        }
                      >
                        Reload link versions
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setDraft(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                )}
              </article>
            );
          })}
          {!comparisons.length && <p>No matching assignment URLs.</p>}

          <h4>Browser and calendar feed</h4>
          <Help label="Browser and calendar feed reconciliation">
            Browser and calendar-feed facts stay separate. Confirm an exact
            canonical Canvas URL before associating them. Titles and dates may
            disagree and neither source wins automatically. A browser item with
            no calendar-feed match remains a retained browser record; absence
            from the feed is never deletion evidence.
          </Help>
          {data.browserItems.map((browserItem) => {
            const link = browserLinks.get(browserItem.id);
            const linked = feedItems.get(link?.itemId ?? '');
            const candidates = feedByUrl.get(browserItem.canonicalUrl) ?? [];
            const candidate = linked ?? candidates[0];
            const matches =
              candidate?.providerData.sourceUrl === browserItem.canonicalUrl;
            const feedTime =
              candidate?.providerData.startDate ??
              candidate?.providerData.startsAt;
            const editing = browserDraft?.browserItemId === browserItem.id;
            return (
              <article
                className="canvas-item"
                aria-label={`Compare browser ${browserItem.title}`}
                key={browserItem.id}
              >
                <strong>{browserItem.title}</strong>
                <p>
                  {link ? 'Linked' : 'Unlinked'} · {browserItem.resourceKind} ·{' '}
                  {browserItem.availability} ·{' '}
                  {browserItem.effectiveSensitivity}
                </p>
                {!link && !candidate && (
                  <p role="status">
                    No calendar-feed item with this URL. Browser record remains
                    independent.
                  </p>
                )}
                {link && !matches && (
                  <p role="status">
                    Canonical URL changed. Review this browser/feed link.
                  </p>
                )}
                <details>
                  <summary>Compare browser and feed</summary>
                  <p>
                    Browser: {browserItem.title} ·{' '}
                    {browserItem.dueAt ?? 'Deadline unknown'} ·{' '}
                    {browserItem.availability}
                  </p>
                  <p>
                    Feed: {candidate?.providerData.title ?? 'No matching item'}{' '}
                    · {feedTime ?? 'Deadline unknown'} ·{' '}
                    {candidate?.availability ?? 'Not observed'}
                  </p>
                  {candidate && browserItem.dueAt !== feedTime && (
                    <p>Dates differ.</p>
                  )}
                  {candidate &&
                    browserItem.title !== candidate.providerData.title && (
                      <p>Titles differ.</p>
                    )}
                </details>
                {!editing && (link || candidate) && (
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() =>
                      setBrowserDraft({
                        browserItemId: browserItem.id,
                        itemId: candidate?.id ?? '',
                        records: data,
                      })
                    }
                  >
                    {link ? 'Review browser link' : 'Link browser item'}
                  </button>
                )}
                {editing && (
                  <form
                    className="editor-form"
                    aria-label="Canvas browser reconciliation"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void perform(() => saveBrowser(false));
                    }}
                  >
                    <label>
                      Calendar-feed item
                      <select
                        aria-label="Browser reconciliation feed item"
                        value={browserDraft.itemId}
                        onChange={(event) =>
                          setBrowserDraft({
                            ...browserDraft,
                            itemId: event.target.value,
                          })
                        }
                      >
                        <option value="">Select feed item</option>
                        {candidates.map((row) => (
                          <option key={row.id} value={row.id}>
                            {row.providerData.title}
                          </option>
                        ))}
                        {linked &&
                          !candidates.some((row) => row.id === linked.id) && (
                            <option value={linked.id}>
                              {linked.providerData.title} · URL changed or
                              unavailable
                            </option>
                          )}
                      </select>
                    </label>
                    <div className="item-actions">
                      <button
                        disabled={
                          busy ||
                          !browserDraft.itemId ||
                          !candidates.some(
                            (row) => row.id === browserDraft.itemId,
                          )
                        }
                      >
                        Confirm browser link
                      </button>
                      {link && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void perform(() => saveBrowser(true))}
                        >
                          Remove browser link
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void perform(async () => {
                            const records = await load();
                            setBrowserDraft((previous) =>
                              previous ? { ...previous, records } : null,
                            );
                          })
                        }
                      >
                        Reload browser link versions
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setBrowserDraft(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                )}
              </article>
            );
          })}
          {!data.browserItems.length && (
            <p>No Canvas browser items have been collected yet.</p>
          )}
        </>
      )}
    </section>
  );
}
