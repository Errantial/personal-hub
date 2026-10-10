import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  canvasConnectionSchema,
  canvasJobResponseSchema,
  canvasItemSchema,
  coursesSchema,
} from '@hub/contracts';
import type {
  CanvasConnection as Connection,
  CanvasItem,
  Course,
} from '@hub/contracts';
import { requestJson } from '../lib/api';
import { Help } from './Help';
import { CanvasPlanning } from './CanvasPlanning';

const base = '/api/v1/connections/canvas';
export function CanvasConnection() {
  const [data, setData] = useState<Connection | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<CanvasItem | null>(null);
  const [notes, setNotes] = useState('');
  const [label, setLabel] = useState<CanvasItem['sensitivity']>('unlabeled');
  const [courses, setCourses] = useState<Course[]>([]);
  const [courseId, setCourseId] = useState('');
  const pending = useRef<{ key: string; id: string } | null>(null);
  async function load(signal?: AbortSignal) {
    const [result, classes] = await Promise.all([
      requestJson(base, canvasConnectionSchema, signal ? { signal } : {}),
      requestJson('/api/v1/courses', coursesSchema, signal ? { signal } : {}),
    ]);
    setData(result);
    setCourses(classes.courses);
    return result;
  }
  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal).catch(() => {
      if (!abort.signal.aborted) setError('Connect to load Canvas.');
    });
    const timer = setInterval(() => {
      void load(abort.signal).catch(() => {
        if (!abort.signal.aborted)
          setError(
            (old) =>
              old || 'Canvas status unavailable. Reload to check freshness.',
          );
      });
    }, 5000);
    return () => {
      clearInterval(timer);
      abort.abort();
    };
  }, []);
  async function change(
    path: string,
    method: string,
    body: Record<string, unknown>,
  ) {
    const key = JSON.stringify({ path, method, body });
    if (pending.current?.key !== key)
      pending.current = { key, id: crypto.randomUUID() };
    const input = { ...body, operationId: pending.current.id };
    if (path.endsWith('/sync') || path.endsWith('/import'))
      await requestJson(path, canvasJobResponseSchema, { method, body: input });
    else if (path.includes('/items/'))
      await requestJson(path, z.object({ item: canvasItemSchema }), {
        method,
        body: input,
      });
    else
      await requestJson(path, z.object({ ok: z.literal(true) }), {
        method,
        body: input,
      });
    pending.current = null;
  }
  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    setStatus('');
    try {
      await action();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Canvas request failed.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel canvas-connection" aria-label="Canvas connection">
      <div className="panel-heading">
        <h2>Canvas</h2>
        <span className="status-tag">
          {data?.configured
            ? data.enabled
              ? 'Auto refresh on'
              : 'Auto refresh paused'
            : 'Feed not configured'}
        </span>
      </div>
      <Help label="Canvas">
        Read-only calendar entries. Configure CANVAS_CALENDAR_FEED_URL on the
        server for 15-minute refreshes, or import an ICS file. The feed may omit
        older entries or assignment details; grades and alerts are not imported.
        Missing entries are retained. Imported content is displayed as text and
        never sent to AI.
      </Help>
      {error && <p role="alert">{error}</p>}
      {status && <p role="status">{status}</p>}
      {data && (
        <>
          <form
            className="editor-form"
            onSubmit={(event) => {
              event.preventDefault();
              const fields = new FormData(event.currentTarget);
              void perform(async () => {
                await change(base, 'PUT', {
                  expectedVersion: data.version,
                  enabled: fields.get('enabled') === 'on',
                  sensitivity: fields.get('sensitivity'),
                });
                await load();
                setStatus('Canvas settings saved.');
              });
            }}
            key={data.version}
          >
            <label className="checkbox-label">
              <input
                type="checkbox"
                name="enabled"
                defaultChecked={data.enabled}
                disabled={!data.configured || busy}
              />
              Auto refresh
            </label>
            <label>
              Source label
              <select
                name="sensitivity"
                aria-label="Source label"
                defaultValue={data.sensitivity}
                disabled={busy}
              >
                {['unlabeled', 'personal', 'restricted'].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <button className="secondary-button" disabled={busy}>
              Save Canvas settings
            </button>
          </form>
          <div className="canvas-actions">
            <button
              className="secondary-button"
              disabled={busy || !data.configured}
              onClick={() =>
                void perform(async () => {
                  await change(`${base}/sync`, 'POST', {});
                  await load();
                  setStatus('Refresh queued.');
                })
              }
            >
              Sync Canvas
            </button>
            <button
              className="text-button"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  await load();
                })
              }
            >
              Reload Canvas
            </button>
            <label>
              Import ICS
              <input
                type="file"
                accept=".ics,text/calendar"
                disabled={busy}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (!file) return;
                  void perform(async () => {
                    if (file.size > 1024 * 1024)
                      throw new Error('Calendar file exceeds 1 MiB.');
                    await change(`${base}/import`, 'POST', {
                      feed: await file.text(),
                    });
                    await load();
                    setStatus('Calendar imported.');
                  });
                }}
              />
            </label>
          </div>
          <p className="meta">
            Last import:{' '}
            {data.lastImportedAt
              ? new Date(data.lastImportedAt).toLocaleString()
              : 'Never'}
          </p>
          {data.jobs[0] && (
            <p role="status">
              Latest refresh: {data.jobs[0].status}
              {data.jobs[0].errorCode ? ` · ${data.jobs[0].errorCode}` : ''}
            </p>
          )}
          <div className="canvas-items">
            {data.items.map((item) => (
              <article className="canvas-item" key={item.id}>
                <h3>{item.providerData.title}</h3>
                <p>
                  {item.providerData.startDate ??
                    (item.providerData.startsAt
                      ? new Date(item.providerData.startsAt).toLocaleString()
                      : 'No date')}{' '}
                  ·{' '}
                  {item.availability === 'missing'
                    ? 'Not in latest feed'
                    : item.availability}{' '}
                  · {item.effectiveSensitivity}
                </p>
                {item.providerData.sourceUrl && (
                  <a
                    href={item.providerData.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open in Canvas
                  </a>
                )}
                {item.providerData.description && (
                  <details>
                    <summary>Source description</summary>
                    <p className="canvas-text">
                      {item.providerData.description}
                    </p>
                  </details>
                )}
                {item.notes && <p className="canvas-text">{item.notes}</p>}
                {item.courseId && (
                  <p>
                    {item.courseName ?? 'Class'}
                    {item.courseDeleted ? ' · Archived class' : ''}
                  </p>
                )}
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => {
                    setEditing(item);
                    setNotes(item.notes);
                    setLabel(item.sensitivity);
                    setCourseId(item.courseId ?? '');
                  }}
                >
                  Edit notes
                </button>
                <CanvasPlanning item={item} courses={courses} />
                {editing?.id === item.id && (
                  <form
                    className="editor-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void perform(async () => {
                        await change(`${base}/items/${editing.id}`, 'PUT', {
                          notes,
                          sensitivity: label,
                          expectedVersion: editing.version,
                          courseId: courseId || null,
                        });
                        setEditing(null);
                        await load();
                        setStatus('Notes saved.');
                      });
                    }}
                  >
                    <label>
                      Personal notes
                      <textarea
                        aria-label="Personal notes"
                        value={notes}
                        maxLength={10000}
                        onChange={(event) => setNotes(event.target.value)}
                      />
                    </label>
                    <label>
                      Entry label
                      <select
                        aria-label="Entry label"
                        value={label}
                        onChange={(event) =>
                          setLabel(
                            event.target.value as CanvasItem['sensitivity'],
                          )
                        }
                      >
                        {['unlabeled', 'personal', 'restricted'].map(
                          (value) => (
                            <option key={value}>{value}</option>
                          ),
                        )}
                      </select>
                    </label>
                    <label>
                      Linked class
                      <select
                        aria-label="Linked class"
                        value={courseId}
                        onChange={(event) => setCourseId(event.target.value)}
                      >
                        <option value="">No class</option>
                        {editing.courseId &&
                          !courses.some(
                            (course) => course.id === editing.courseId,
                          ) && (
                            <option value={editing.courseId}>
                              {editing.courseName ?? 'Class'} · Archived class
                            </option>
                          )}
                        {courses.map((course) => (
                          <option key={course.id} value={course.id}>
                            {course.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button className="primary-button" disabled={busy}>
                      Save notes
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      disabled={busy}
                      onClick={() => {
                        setEditing(null);
                      }}
                    >
                      Cancel notes
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      disabled={busy}
                      onClick={() =>
                        void perform(async () => {
                          const result = await load();
                          const current = result.items.find(
                            (value) => value.id === editing.id,
                          );
                          if (current) setEditing(current);
                        })
                      }
                    >
                      Reload entry version
                    </button>
                  </form>
                )}
              </article>
            ))}
            {!data.items.length && <p>No imported entries.</p>}
          </div>
          {!!data.jobs.length && (
            <details>
              <summary>Refresh history</summary>
              {data.jobs.map((job) => (
                <p key={job.id}>
                  {new Date(job.createdAt).toLocaleString()} · {job.trigger} ·{' '}
                  {job.status}
                  {job.errorCode ? ` · ${job.errorCode}` : ''}
                  {job.counts
                    ? ` · ${job.counts.added} added, ${job.counts.updated} updated, ${job.counts.missing} missing`
                    : ''}
                </p>
              ))}
            </details>
          )}
        </>
      )}
    </section>
  );
}
