import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  canvasBrowserConnectionSchema,
  canvasBrowserCourseSchema,
  canvasBrowserItemSchema,
  canvasBrowserTokenResponseSchema,
  coursesSchema,
} from '@hub/contracts';
import type {
  CanvasBrowserConnection as Connection,
  CanvasBrowserCourse,
  CanvasBrowserItem,
  Course,
} from '@hub/contracts';
import { requestJson } from '../lib/api';
import { formatInstant } from '../lib/format';
import { Help } from './Help';
import { StatusChip } from './StatusChip';

const base = '/api/v1/connections/canvas/browser';
type Editing =
  | { kind: 'course'; item: CanvasBrowserCourse }
  | { kind: 'item'; item: CanvasBrowserItem };

const healthLabels: Record<Connection['healthStatus'], string> = {
  'never-synced': 'Never synced',
  syncing: 'Syncing',
  current: 'Current',
  stale: 'Stale',
  partial: 'Partial',
  'sign-in-required': 'Sign in required',
  revoked: 'Revoked',
  error: 'Error',
};

export function CanvasBrowserConnection() {
  const [data, setData] = useState<Connection | null>(null);
  const [classes, setClasses] = useState<Course[]>([]);
  const [token, setToken] = useState('');
  const [sourceDraft, setSourceDraft] = useState<{
    version: number;
    sensitivity: string;
    dirty: boolean;
  } | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [notes, setNotes] = useState('');
  const [label, setLabel] = useState('unlabeled');
  const [selected, setSelected] = useState(false);
  const [courseId, setCourseId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const pending = useRef<{ key: string; id: string } | null>(null);

  async function load(signal?: AbortSignal) {
    const [connection, local] = await Promise.all([
      requestJson(
        base,
        canvasBrowserConnectionSchema,
        signal ? { signal } : {},
      ),
      requestJson('/api/v1/courses', coursesSchema, signal ? { signal } : {}),
    ]);
    if (!signal?.aborted) {
      setData(connection);
      setClasses(local.courses);
      setSourceDraft((previous) =>
        previous?.dirty
          ? previous
          : {
              version: connection.version,
              sensitivity: connection.sensitivity,
              dirty: false,
            },
      );
    }
    return connection;
  }

  useEffect(() => {
    const abort = new AbortController();
    const refresh = () => {
      void load(abort.signal).catch(() => {
        if (!abort.signal.aborted)
          setError(
            'Canvas browser status unavailable. Reload to check freshness.',
          );
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
        cause instanceof Error
          ? cause.message
          : 'Canvas browser request failed.',
      );
    } finally {
      setBusy(false);
    }
  }

  function operation(key: string) {
    if (pending.current?.key !== key)
      pending.current = { key, id: crypto.randomUUID() };
    return pending.current.id;
  }

  function edit(value: Editing) {
    setEditing(value);
    setNotes(value.item.notes);
    setLabel(value.item.sensitivity);
    if (value.kind === 'course') {
      setSelected(value.item.selected);
      setCourseId(value.item.courseId ?? '');
    }
  }

  if (!data)
    return (
      <section aria-label="Canvas browser connection" className="panel">
        <h3>Canvas browser</h3>
        <p role="status">Loading Canvas browser status…</p>
        {error && <p role="alert">{error}</p>}
      </section>
    );
  const source = sourceDraft ?? {
    version: data.version,
    sensitivity: data.sensitivity,
    dirty: false,
  };

  const attention = [
    'stale',
    'partial',
    'sign-in-required',
    'revoked',
    'error',
  ].includes(data.healthStatus);

  return (
    <section aria-label="Canvas browser connection" className="panel">
      <h3>
        Canvas browser{' '}
        <StatusChip tone={attention ? 'attention' : 'neutral'}>
          {healthLabels[data.healthStatus]}
        </StatusChip>
      </h3>
      <Help label="Canvas browser collector">
        This read-only local collector uses a dedicated browser profile and your
        normal interactive Canvas sign-in. It imports only course identity,
        assignment/quiz identity, title, exact due timestamp or no date, source
        URL and coverage. It does not import grades, submissions, descriptions,
        files, screenshots or browser sessions. Partial course observations
        never remove unseen records.
      </Help>
      <p className="meta">
        Last contact:{' '}
        {data.lastContactAt ? formatInstant(data.lastContactAt) : 'Never'}
        {' · '}Complete through:{' '}
        {data.lastCompleteAt ? formatInstant(data.lastCompleteAt) : 'Never'}
      </p>
      {data.lastErrorCode && (
        <p role="status">
          Latest collector result: {data.lastErrorCode}
          {data.healthStatus === 'sign-in-required' &&
            ' · Open the dedicated Canvas browser profile and sign in normally.'}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {status && <p role="status">{status}</p>}

      {token ? (
        <div
          className="editor-form"
          aria-label="Canvas browser collector token"
        >
          <label>
            Collector token
            <input
              readOnly
              value={token}
              aria-label="Canvas browser collector token"
            />
          </label>
          <p>Save this token now. It cannot be shown again.</p>
          <button type="button" onClick={() => setToken('')}>
            I saved it
          </button>
        </div>
      ) : (
        <div className="item-actions">
          <button
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                const key = `token:${data.version}`;
                const result = await requestJson(
                  `${base}/token`,
                  canvasBrowserTokenResponseSchema,
                  {
                    method: 'POST',
                    body: {
                      operationId: operation(key),
                      expectedVersion: data.version,
                    },
                  },
                );
                pending.current = null;
                setToken(result.token);
                setData(result.connection);
                setSourceDraft((previous) =>
                  previous?.dirty
                    ? previous
                    : {
                        version: result.connection.version,
                        sensitivity: result.connection.sensitivity,
                        dirty: false,
                      },
                );
                setStatus(
                  data.configured
                    ? 'Replacement collector token created. Update the local connector before its next run.'
                    : 'Collector token created.',
                );
              })
            }
          >
            {data.configured
              ? 'Replace collector token'
              : 'Create collector token'}
          </button>
          {data.configured && (
            <button
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  const key = `revoke:${data.version}`;
                  const result = await requestJson(
                    `${base}/revoke`,
                    canvasBrowserConnectionSchema,
                    {
                      method: 'POST',
                      body: {
                        operationId: operation(key),
                        expectedVersion: data.version,
                      },
                    },
                  );
                  pending.current = null;
                  setData(result);
                  setSourceDraft((previous) =>
                    previous?.dirty
                      ? previous
                      : {
                          version: result.version,
                          sensitivity: result.sensitivity,
                          dirty: false,
                        },
                  );
                  setStatus(
                    'Canvas browser collector revoked. Retained records stay available.',
                  );
                })
              }
            >
              Revoke collector
            </button>
          )}
        </div>
      )}

      <form
        className="editor-form"
        aria-label="Canvas browser source settings"
        onSubmit={(event) => {
          event.preventDefault();
          void perform(async () => {
            const key = `source:${source.version}:${source.sensitivity}`;
            const result = await requestJson(
              base,
              canvasBrowserConnectionSchema,
              {
                method: 'PUT',
                body: {
                  operationId: operation(key),
                  expectedVersion: source.version,
                  sensitivity: source.sensitivity,
                },
              },
            );
            pending.current = null;
            setData(result);
            setSourceDraft({
              version: result.version,
              sensitivity: result.sensitivity,
              dirty: false,
            });
            setStatus('Canvas browser source label saved.');
          });
        }}
      >
        <label>
          Imported Canvas label
          <select
            value={source.sensitivity}
            onChange={(event) =>
              setSourceDraft({
                ...source,
                sensitivity: event.target.value,
                dirty: true,
              })
            }
          >
            {['unlabeled', 'personal', 'restricted'].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <button disabled={busy || source.sensitivity === data.sensitivity}>
          Save source label
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            setSourceDraft({
              version: data.version,
              sensitivity: source.sensitivity,
              dirty: source.sensitivity !== data.sensitivity,
            })
          }
        >
          Reload source version
        </button>
      </form>

      <h4>Discovered courses</h4>
      {!data.courses.length && (
        <p>
          No browser courses discovered yet. Run the local collector once after
          saving its token; then explicitly select the courses to collect.
        </p>
      )}
      {data.courses.map((course) => {
        const latest = data.courses.find((value) => value.id === course.id);
        return (
          <section
            key={course.id}
            className="canvas-item"
            aria-label={`Canvas browser course ${course.name}`}
          >
            <h4>{course.name}</h4>
            <p>
              {course.selected ? 'Selected' : 'Not selected'} ·{' '}
              {course.availability}
              {' · '}
              {course.effectiveSensitivity}
            </p>
            <p className="meta">
              Coverage: {course.lastObservationStatus ?? 'Never observed'} ·
              Complete:{' '}
              {course.lastCompleteAt
                ? formatInstant(course.lastCompleteAt)
                : 'Never'}
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
              onClick={() => edit({ kind: 'course', item: course })}
            >
              Edit browser course
            </button>
            {editing?.kind === 'course' && editing.item.id === course.id && (
              <form
                className="editor-form"
                aria-label="Canvas browser course editor"
                onSubmit={(event) => {
                  event.preventDefault();
                  void perform(async () => {
                    const body = {
                      expectedVersion: editing.item.version,
                      selected,
                      courseId: courseId || null,
                      notes,
                      sensitivity: label,
                    };
                    const key = `course:${editing.item.id}:${JSON.stringify(body)}`;
                    await requestJson(
                      `${base}/courses/${editing.item.id}`,
                      z.object({
                        course: canvasBrowserCourseSchema,
                        sourceVersion: z.number().int().positive(),
                      }),
                      {
                        method: 'PUT',
                        body: { operationId: operation(key), ...body },
                      },
                    );
                    pending.current = null;
                    setEditing(null);
                    await load();
                    setStatus('Canvas browser course saved.');
                  });
                }}
              >
                <label>
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={(event) => setSelected(event.target.checked)}
                  />{' '}
                  Collect this course
                </label>
                <label>
                  Linked class
                  <select
                    value={courseId}
                    onChange={(event) => setCourseId(event.target.value)}
                  >
                    <option value="">No class</option>
                    {course.courseId &&
                      !classes.some((item) => item.id === course.courseId) && (
                        <option value={course.courseId}>
                          {course.courseName ?? 'Class'} · Archived class
                        </option>
                      )}
                    {classes.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Personal notes
                  <textarea
                    value={notes}
                    onChange={(event) => setNotes(event.target.value)}
                    maxLength={10000}
                    rows={2}
                  />
                </label>
                <label>
                  Content label
                  <select
                    value={label}
                    onChange={(event) => setLabel(event.target.value)}
                  >
                    {['unlabeled', 'personal', 'restricted'].map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                </label>
                <div className="item-actions">
                  <button disabled={busy}>Save browser course</button>
                  <button
                    type="button"
                    disabled={!latest || busy}
                    onClick={() => {
                      if (latest) setEditing({ kind: 'course', item: latest });
                    }}
                  >
                    Reload course version
                  </button>
                  <button type="button" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </div>
              </form>
            )}
            {data.items
              .filter((item) => item.browserCourseId === course.id)
              .map((item) => {
                const latestItem = data.items.find(
                  (value) => value.id === item.id,
                );
                return (
                  <section
                    key={item.id}
                    aria-label={`Canvas browser ${item.resourceKind} ${item.title}`}
                  >
                    <h5>{item.title}</h5>
                    <p>
                      {item.resourceKind} ·{' '}
                      {item.dueAt
                        ? `Due ${formatInstant(item.dueAt)}`
                        : 'No due date'}{' '}
                      ·{' '}
                      {item.availability === 'missing'
                        ? 'Not in latest complete browser observation'
                        : 'Available'}{' '}
                      · {item.effectiveSensitivity}
                    </p>
                    {item.notes && <p className="canvas-text">{item.notes}</p>}
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() => edit({ kind: 'item', item })}
                    >
                      Edit browser item notes
                    </button>
                    {editing?.kind === 'item' &&
                      editing.item.id === item.id && (
                        <form
                          className="editor-form"
                          aria-label="Canvas browser item editor"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void perform(async () => {
                              const body = {
                                expectedVersion: editing.item.version,
                                notes,
                                sensitivity: label,
                              };
                              const key = `item:${editing.item.id}:${JSON.stringify(body)}`;
                              await requestJson(
                                `${base}/items/${editing.item.id}`,
                                z.object({ item: canvasBrowserItemSchema }),
                                {
                                  method: 'PUT',
                                  body: {
                                    operationId: operation(key),
                                    ...body,
                                  },
                                },
                              );
                              pending.current = null;
                              setEditing(null);
                              await load();
                              setStatus('Canvas browser item notes saved.');
                            });
                          }}
                        >
                          <label>
                            Personal notes
                            <textarea
                              value={notes}
                              onChange={(event) => setNotes(event.target.value)}
                              maxLength={10000}
                              rows={2}
                            />
                          </label>
                          <label>
                            Content label
                            <select
                              value={label}
                              onChange={(event) => setLabel(event.target.value)}
                            >
                              {['unlabeled', 'personal', 'restricted'].map(
                                (value) => (
                                  <option key={value}>{value}</option>
                                ),
                              )}
                            </select>
                          </label>
                          <div className="item-actions">
                            <button disabled={busy}>Save browser item</button>
                            <button
                              type="button"
                              disabled={!latestItem || busy}
                              onClick={() => {
                                if (latestItem)
                                  setEditing({
                                    kind: 'item',
                                    item: latestItem,
                                  });
                              }}
                            >
                              Reload item version
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditing(null)}
                            >
                              Cancel
                            </button>
                          </div>
                        </form>
                      )}
                  </section>
                );
              })}
          </section>
        );
      })}
    </section>
  );
}
