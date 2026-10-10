import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  canvasLmsConnectionSchema,
  canvasLmsCourseSchema,
  canvasLmsAssignmentSchema,
  canvasJobResponseSchema,
  coursesSchema,
} from '@hub/contracts';
import type {
  CanvasLmsConnection as Connection,
  CanvasLmsCourse,
  CanvasLmsAssignment,
  Course,
} from '@hub/contracts';
import { requestJson } from '../lib/api';
import { Help } from './Help';
import { CanvasAssignment } from './CanvasAssignment';
const base = '/api/v1/connections/canvas/lms';
type Editing =
  | { kind: 'courses'; item: CanvasLmsCourse }
  | { kind: 'assignments'; item: CanvasLmsAssignment };
export function CanvasLmsConnection() {
  const [data, setData] = useState<Connection | null>(null);
  const [courses, setCourses] = useState<Course[]>([]);
  const [settings, setSettings] = useState<{
    version: number;
    enabled: boolean;
    sensitivity: string;
  } | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [notes, setNotes] = useState('');
  const [label, setLabel] = useState('unlabeled');
  const [courseId, setCourseId] = useState('');
  const pending = useRef<{ key: string; id: string } | null>(null);
  async function load(signal?: AbortSignal) {
    const [records, classes] = await Promise.all([
      requestJson(base, canvasLmsConnectionSchema, signal ? { signal } : {}),
      requestJson('/api/v1/courses', coursesSchema, signal ? { signal } : {}),
    ]);
    if (!signal?.aborted) {
      setData(records);
      setCourses(classes.courses);
      setSettings((previous) => previous ?? records);
    }
    return records;
  }
  useEffect(() => {
    const abort = new AbortController();
    const refresh = () => {
      void load(abort.signal).catch(() => {
        if (!abort.signal.aborted)
          setError('Canvas API unavailable. Reload to check freshness.');
      });
    };
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, []);
  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    setStatus('');
    try {
      await action();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Canvas API request failed.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function change(
    path: string,
    method: string,
    body: Record<string, unknown>,
  ) {
    const key = JSON.stringify({ path, method, body });
    if (pending.current?.key !== key)
      pending.current = { key, id: crypto.randomUUID() };
    const options = {
      method,
      body: { ...body, operationId: pending.current.id },
    };
    if (path.endsWith('/sync'))
      await requestJson(path, canvasJobResponseSchema, options);
    else if (path.includes('/courses/'))
      await requestJson(
        path,
        z.object({ course: canvasLmsCourseSchema }),
        options,
      );
    else if (path.includes('/assignments/'))
      await requestJson(
        path,
        z.object({ assignment: canvasLmsAssignmentSchema }),
        options,
      );
    else await requestJson(path, z.object({ ok: z.literal(true) }), options);
    pending.current = null;
  }
  function edit(value: Editing) {
    setEditing(value);
    setNotes(value.item.notes);
    setLabel(value.item.sensitivity);
    setCourseId(value.kind === 'courses' ? (value.item.courseId ?? '') : '');
  }
  function editor() {
    if (!editing) return null;
    const course = editing.kind === 'courses' ? editing.item : null;
    const latest =
      editing.kind === 'courses'
        ? data?.courses.find((row) => row.id === editing.item.id)
        : data?.assignments.find((row) => row.id === editing.item.id);
    return (
      <form
        aria-label="Canvas API notes"
        className="editor-form"
        onSubmit={(event) => {
          event.preventDefault();
          void perform(async () => {
            await change(`${base}/${editing.kind}/${editing.item.id}`, 'PUT', {
              notes,
              sensitivity: label,
              expectedVersion: editing.item.version,
              ...(course ? { courseId: courseId || null } : {}),
            });
            setEditing(null);
            await load();
            setStatus('Canvas API notes saved.');
          });
        }}
      >
        <label>
          Personal notes
          <textarea
            aria-label="API personal notes"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            maxLength={10000}
            rows={2}
          />
        </label>
        <label>
          Content label
          <select
            aria-label="API content label"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          >
            {['unlabeled', 'personal', 'restricted'].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        {course && (
          <label>
            Linked class
            <select
              aria-label="API linked class"
              value={courseId}
              onChange={(event) => setCourseId(event.target.value)}
            >
              <option value="">No class</option>
              {course.courseId &&
                !courses.some((item) => item.id === course.courseId) && (
                  <option value={course.courseId}>
                    {course.courseName ?? 'Class'} · Archived class
                  </option>
                )}
              {courses.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="item-actions">
          <button disabled={busy}>Save API notes</button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (latest)
                setEditing(
                  editing.kind === 'courses'
                    ? {
                        kind: 'courses',
                        item: canvasLmsCourseSchema.parse(latest),
                      }
                    : {
                        kind: 'assignments',
                        item: canvasLmsAssignmentSchema.parse(latest),
                      },
                );
            }}
          >
            Reload API record version
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setEditing(null)}
          >
            Cancel
          </button>
        </div>
      </form>
    );
  }
  return (
    <section className="panel" aria-label="Canvas API connection">
      <h3>Canvas API</h3>
      <Help label="Canvas API">
        Read-only courses and assignments. Configure the API token on the server
        for personal testing; multi-user access requires OAuth. API records
        remain separate from calendar-feed entries. Link courses to existing
        classes; refreshes preserve notes, links and manual progress. Possible
        points are not earned grades. Descriptions, submissions and attachments
        are not imported. Reloading settings or a record version retains your
        edited fields.
      </Help>
      {error && <p role="alert">{error}</p>}
      {status && <p role="status">{status}</p>}
      {data && settings && (
        <>
          <p>
            {data.configured ? 'API token configured' : 'API not configured'} ·
            Read only
          </p>
          <form
            className="editor-form"
            onSubmit={(event) => {
              event.preventDefault();
              void perform(async () => {
                await change(base, 'PUT', {
                  enabled: settings.enabled,
                  sensitivity: settings.sensitivity,
                  expectedVersion: settings.version,
                });
                const result = await load();
                setSettings(result);
                setStatus('Canvas API settings saved.');
              });
            }}
          >
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={settings.enabled}
                onChange={(event) =>
                  setSettings({ ...settings, enabled: event.target.checked })
                }
                disabled={!data.configured || busy}
              />
              API auto refresh
            </label>
            <label>
              API source label
              <select
                aria-label="API source label"
                value={settings.sensitivity}
                onChange={(event) =>
                  setSettings({ ...settings, sensitivity: event.target.value })
                }
              >
                {['unlabeled', 'personal', 'restricted'].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <button disabled={busy}>Save API settings</button>
          </form>
          <div className="item-actions">
            <button
              disabled={!data.configured || busy}
              onClick={() => {
                void perform(async () => {
                  await change(`${base}/sync`, 'POST', {});
                  await load();
                  setStatus('API refresh queued.');
                });
              }}
            >
              Sync Canvas API
            </button>
            <button
              disabled={busy}
              onClick={() => {
                void perform(async () => {
                  const result = await load();
                  setSettings((previous) =>
                    previous
                      ? { ...previous, version: result.version }
                      : result,
                  );
                });
              }}
            >
              Reload Canvas API
            </button>
          </div>
          <p className="meta">
            Last API import:{' '}
            {data.lastImportedAt
              ? new Date(data.lastImportedAt).toLocaleString()
              : 'Never'}
          </p>
          {data.jobs[0] && (
            <p>
              Latest API refresh: {data.jobs[0].status}
              {data.jobs[0].errorCode ? ` · ${data.jobs[0].errorCode}` : ''}
            </p>
          )}
          {data.courses.map((course) => (
            <section
              className="canvas-item"
              aria-label={`Canvas API course ${course.providerData.name}`}
              key={course.id}
            >
              <h4>{course.providerData.name}</h4>
              <p>
                {course.providerData.code} · {course.providerData.term} ·{' '}
                {course.availability === 'missing'
                  ? 'Not in latest API snapshot'
                  : course.availability}{' '}
                · {course.effectiveSensitivity}
              </p>
              {course.courseId && (
                <p>
                  {course.courseName ?? 'Class'}
                  {course.courseDeleted ? ' · Archived class' : ''}
                </p>
              )}
              {course.notes && <p className="canvas-text">{course.notes}</p>}
              <button
                className="text-button"
                disabled={busy}
                onClick={() => edit({ kind: 'courses', item: course })}
              >
                Edit API course notes
              </button>
              {editing?.kind === 'courses' &&
                editing.item.id === course.id &&
                editor()}
              {data.assignments
                .filter((item) => item.canvasCourseId === course.id)
                .map((item) => (
                  <section
                    aria-label={`Canvas API assignment ${item.providerData.title}`}
                    key={item.id}
                  >
                    <CanvasAssignment item={item} course={course} />
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() => edit({ kind: 'assignments', item })}
                    >
                      Edit API assignment notes
                    </button>
                    {editing?.kind === 'assignments' &&
                      editing.item.id === item.id &&
                      editor()}
                  </section>
                ))}
            </section>
          ))}
          {!data.courses.length && <p>No imported API courses.</p>}
        </>
      )}
    </section>
  );
}
