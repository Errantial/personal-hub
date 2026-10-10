import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  Temporal,
  wallTimeToInstant,
  taskResponseSchema,
  calendarResponseSchema,
} from '@hub/contracts';
import type { CanvasItem, Course } from '@hub/contracts';
import { requestJson, RequestError } from '../lib/api';
import { Help } from './Help';

export type CanvasPlanningItem = Pick<
  CanvasItem,
  'id' | 'version' | 'courseId' | 'availability'
> & {
  providerData: Pick<
    CanvasItem['providerData'],
    'title' | 'startDate' | 'startsAt'
  >;
};
export function CanvasPlanning({
  item,
  courses,
  apiCourseVersion,
}: {
  item: CanvasPlanningItem;
  courses: Course[];
  apiCourseVersion?: number;
}) {
  const [kind, setKind] = useState<'task' | 'study' | null>(null);
  const [source, setSource] = useState(item);
  const [courseVersion, setCourseVersion] = useState(apiCourseVersion);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const pending = useRef<{ key: string; id: string } | null>(null);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const dueDate =
    source.providerData.startDate ??
    (source.providerData.startsAt
      ? Temporal.Instant.from(source.providerData.startsAt)
          .toZonedDateTimeISO(timeZone)
          .toPlainDate()
          .toString()
      : '');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const common = {
        title: String(form.get('title')),
        notes: String(form.get('notes')),
        canvasSourceRef: {
          itemId: source.id,
          expectedVersion: source.version,
          ...(courseVersion
            ? { kind: 'assignment-api', expectedCourseVersion: courseVersion }
            : {}),
        },
      };
      const body =
        kind === 'task'
          ? {
              ...common,
              dueDate: form.get('dueDate') || null,
              priority: 'normal',
            }
          : {
              ...common,
              courseId: String(form.get('courseId')),
              timeZone: String(form.get('timeZone')),
              startsAt: wallTimeToInstant(
                String(form.get('startsAt')),
                String(form.get('timeZone')),
                String(form.get('offset')) as 'reject' | 'earlier' | 'later',
              ),
              endsAt: wallTimeToInstant(
                String(form.get('endsAt')),
                String(form.get('timeZone')),
                String(form.get('offset')) as 'reject' | 'earlier' | 'later',
              ),
            };
      const path = kind === 'task' ? '/api/v1/tasks' : '/api/v1/calendar';
      const key = JSON.stringify({ path, body });
      if (pending.current?.key !== key)
        pending.current = { key, id: crypto.randomUUID() };
      const options = {
        method: 'POST',
        body: { ...body, operationId: pending.current.id },
      };
      if (kind === 'task') await requestJson(path, taskResponseSchema, options);
      else await requestJson(path, calendarResponseSchema, options);
      pending.current = null;
      setMessage(kind === 'task' ? 'Task created.' : 'Study block created.');
      setKind(null);
    } catch (failure) {
      setError(
        failure instanceof RequestError && failure.code === 'VERSION_CONFLICT'
          ? `Canvas ${courseVersion ? 'assignment or course' : 'entry'} changed. Reload Canvas, then reload source version. Your planner draft is retained.`
          : failure instanceof Error
            ? failure.message
            : 'Could not create planner item.',
      );
    } finally {
      setBusy(false);
    }
  }
  function open(next: 'task' | 'study') {
    setSource(item);
    setCourseVersion(apiCourseVersion);
    setKind(next);
    setError('');
    setMessage('');
  }
  return (
    <div>
      {!kind && (
        <div className="item-actions">
          <button
            className="text-button"
            disabled={item.availability !== 'available'}
            onClick={() => open('task')}
          >
            Create task
          </button>
          <button
            className="text-button"
            disabled={item.availability !== 'available'}
            onClick={() => open('study')}
          >
            Plan study
          </button>
        </div>
      )}
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
      {kind && (
        <form
          className="editor-form"
          aria-label="Canvas planning"
          onSubmit={(event) => {
            void submit(event);
          }}
        >
          <h4>{kind === 'task' ? 'Create task' : 'Plan study'}</h4>
          <Help label="Canvas planning">
            Review the task deadline or study time. Timed deadlines use this
            device's timezone. Refreshes preserve your planner edits and source
            labels are inherited. Items created from uploaded files remain
            excluded from future AI processing. Creation requires a connection.
            Retry an unchanged save after a failed response; creating another
            item is a separate action.
          </Help>
          <p className="meta">Source version {source.version}</p>
          {(source.version !== item.version ||
            courseVersion !== apiCourseVersion) && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setSource(item);
                setCourseVersion(apiCourseVersion);
              }}
            >
              Reload source version
            </button>
          )}
          <label>
            Planner title
            <input
              name="title"
              defaultValue={source.providerData.title}
              maxLength={200}
              required
            />
          </label>
          <label>
            Planner notes
            <textarea name="notes" maxLength={10000} rows={2} />
          </label>
          {kind === 'task' ? (
            <label>
              Task deadline
              <input type="date" name="dueDate" defaultValue={dueDate} />
            </label>
          ) : (
            <>
              <label>
                Study class
                <select
                  name="courseId"
                  defaultValue={
                    courses.some((course) => course.id === source.courseId)
                      ? (source.courseId ?? '')
                      : ''
                  }
                  required
                >
                  <option value="">Select class</option>
                  {courses.map((course) => (
                    <option key={course.id} value={course.id}>
                      {course.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Study timezone
                <input name="timeZone" defaultValue={timeZone} required />
              </label>
              <label>
                Study starts
                <input name="startsAt" type="datetime-local" required />
              </label>
              <label>
                Study ends
                <input name="endsAt" type="datetime-local" required />
              </label>
              <label>
                Repeated time offset
                <select name="offset" defaultValue="reject">
                  <option value="reject">Require unambiguous time</option>
                  <option value="earlier">Earlier offset</option>
                  <option value="later">Later offset</option>
                </select>
              </label>
            </>
          )}
          <div className="item-actions">
            <button className="primary-button" disabled={busy}>
              {kind === 'task' ? 'Save task' : 'Save study block'}
            </button>
            <button type="button" disabled={busy} onClick={() => setKind(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
