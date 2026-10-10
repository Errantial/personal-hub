import { Help } from './Help';
import { PlannerSource } from './PlannerSource';
import { CanvasEntry } from './CanvasEntry';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  Temporal,
  calendarListSchema,
  occurrencesResponseSchema,
  coursesSchema,
  topicsSchema,
  calendarResponseSchema,
  wallTimeToInstant,
  instantToWall,
  zone,
  canvasItemsResponseSchema,
  canvasItemInRange,
  plannerSensitivity,
} from '@hub/contracts';
import type {
  CalendarRecord,
  CalendarInput,
  Course,
  Topic,
  Occurrence,
  CanvasItem,
} from '@hub/contracts';
import { getJson, requestJson } from '../lib/api';
export type StudyDraft = {
  courseId: string;
  topicId: string | null;
  title: string;
};
type Editing = { event: CalendarRecord; originalDate: string | null };

export function CalendarWorkspace({
  studyDraft,
}: {
  studyDraft: StudyDraft | null;
}) {
  const [timeZone, setTimeZone] = useState(
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [date, setDate] = useState(Temporal.Now.plainDateISO().toString());
  const [mode, setMode] = useState<'day' | 'week'>('week');
  const [events, setEvents] = useState<CalendarRecord[]>([]);
  const [occurrences, setOccurrences] = useState<Occurrence[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [canvas, setCanvas] = useState<{
    key: string;
    items: CanvasItem[];
    lastImportedAt: string | null;
    error: string;
  } | null>(null);
  const canvasRequest = useRef(0);
  const pending = useRef<{ key: string; id: string } | null>(null);
  const chosen = Temporal.PlainDate.from(date);
  const from = (
    mode === 'week' ? chosen.subtract({ days: chosen.dayOfWeek - 1 }) : chosen
  ).toString();
  const to = Temporal.PlainDate.from(from)
    .add({ days: mode === 'week' ? 7 : 1 })
    .toString();
  const canvasKey = `${from}:${to}:${timeZone}`;
  async function load(signal?: AbortSignal, refreshEditor = false) {
    const query = new URLSearchParams({ from, to, timeZone });
    const request = ++canvasRequest.current;
    void getJson(
      `/api/v1/connections/canvas/calendar?${query}`,
      canvasItemsResponseSchema,
      signal,
    ).then(
      (result) => {
        if (!signal?.aborted && request === canvasRequest.current)
          setCanvas({ key: canvasKey, ...result, error: '' });
      },
      () => {
        if (!signal?.aborted && request === canvasRequest.current)
          setCanvas({
            key: canvasKey,
            items: [],
            lastImportedAt: null,
            error: 'Canvas entries unavailable. Reload calendar to retry.',
          });
      },
    );
    const [series, expanded, classes, subjects] = await Promise.all([
      getJson('/api/v1/calendar', calendarListSchema, signal),
      getJson(
        `/api/v1/calendar/occurrences?${query}`,
        occurrencesResponseSchema,
        signal,
      ),
      getJson('/api/v1/courses', coursesSchema, signal),
      getJson('/api/v1/topics', topicsSchema, signal),
    ]);
    setEvents(series.events);
    setOccurrences(expanded.occurrences);
    setCourses(classes.courses);
    setTopics(subjects.topics);
    if (refreshEditor)
      setEditing((previous) => {
        const current = series.events.find(
          (value) => value.id === previous?.event.id,
        );
        return previous && current
          ? {
              ...previous,
              event: { ...previous.event, version: current.version },
            }
          : previous;
      });
  }
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).catch(() => {
      if (!controller.signal.aborted)
        setError('Could not load the calendar. Reload to try again.');
    });
    return () => controller.abort();
  }, [from, to, timeZone]);
  async function change(
    path: string,
    method: string,
    body: Record<string, unknown>,
  ) {
    const key = JSON.stringify({ path, method, body });
    if (pending.current?.key !== key)
      pending.current = { key, id: crypto.randomUUID() };
    await requestJson(path, calendarResponseSchema, {
      method,
      body: { ...body, operationId: pending.current.id },
    });
    pending.current = null;
  }
  async function save(values: CalendarInput) {
    setBusy(true);
    setError('');
    try {
      await change(
        editing
          ? `/api/v1/calendar/${editing.event.id}${editing.originalDate ? `/occurrences/${editing.originalDate}` : ''}`
          : '/api/v1/calendar',
        editing ? 'PUT' : 'POST',
        {
          ...values,
          ...(editing ? { expectedVersion: editing.event.version } : {}),
        },
      );
      setEditing(null);
      setRevision((value) => value + 1);
      await load();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Could not save the event.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function remove(item: Occurrence, wholeSeries: boolean) {
    setBusy(true);
    setError('');
    try {
      await change(
        `/api/v1/calendar/${item.id}${item.recurrence && !wholeSeries ? `/occurrences/${item.originalDate}` : ''}`,
        'DELETE',
        { expectedVersion: item.version },
      );
      setEditing(null);
      await load();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Could not delete the event.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function complete(item: Occurrence) {
    setEditing({
      event: { ...item, studyStatus: 'completed' },
      originalDate: item.recurrence ? item.originalDate : null,
    });
    setError(
      'Use the status field to record completion, then save. Topic progress remains your own assessment.',
    );
  }
  const days = Array.from({ length: mode === 'week' ? 7 : 1 }, (_, index) =>
    Temporal.PlainDate.from(from).add({ days: index }).toString(),
  );
  return (
    <section aria-label="Calendar workspace">
      <div className="calendar-toolbar panel">
        <div className="form-actions">
          <button
            className="secondary-button"
            onClick={() =>
              setDate(
                chosen.subtract({ days: mode === 'week' ? 7 : 1 }).toString(),
              )
            }
          >
            Previous {mode}
          </button>
          <button
            className="secondary-button"
            onClick={() =>
              setDate(
                Temporal.Now.zonedDateTimeISO(timeZone)
                  .toPlainDate()
                  .toString(),
              )
            }
          >
            Calendar today
          </button>
          <button
            className="secondary-button"
            onClick={() =>
              setDate(chosen.add({ days: mode === 'week' ? 7 : 1 }).toString())
            }
          >
            Next {mode}
          </button>
        </div>
        <div className="form-actions">
          <button
            className="theme-button"
            aria-pressed={mode === 'day'}
            onClick={() => setMode('day')}
          >
            Day view
          </button>
          <button
            className="theme-button"
            aria-pressed={mode === 'week'}
            onClick={() => setMode('week')}
          >
            Week view
          </button>
          <label>
            Calendar date
            <input
              aria-label="Calendar date"
              type="date"
              value={date}
              onChange={(event) => {
                if (event.target.value) setDate(event.target.value);
              }}
            />
          </label>
          <button
            className="text-button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void load(undefined, true)
                .then(() => setError(''))
                .catch(() => setError('Could not reload.'))
                .finally(() => setBusy(false));
            }}
          >
            Reload calendar
          </button>
        </div>
        <form
          className="form-actions"
          onSubmit={(event) => {
            event.preventDefault();
            try {
              const value = zone.parse(
                new FormData(event.currentTarget).get('zone'),
              );
              setTimeZone(value);
              setError('');
            } catch {
              setError('Enter a supported IANA timezone.');
            }
          }}
        >
          <label>
            Viewing timezone
            <input
              name="zone"
              defaultValue={timeZone}
              required
              maxLength={100}
            />
          </label>
          <button className="secondary-button">Apply timezone</button>
        </form>
      </div>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {busy && <p role="status">Updating calendar…</p>}
      <Help label="Calendar">
        {from} through{' '}
        {Temporal.PlainDate.from(to).subtract({ days: 1 }).toString()} ·{' '}
        {timeZone}. Task deadlines are separate from reserved calendar time.
        <br />
        Canvas entries are read-only. Point entries are deadlines;
        cancelled/missing entries are kept visible and do not reserve time.
      </Help>
      {canvas?.key === canvasKey && canvas.error && (
        <p role="alert" className="form-error">
          {canvas.error}
        </p>
      )}
      {canvas?.key === canvasKey && canvas.lastImportedAt && (
        <p className="meta">
          Canvas last import: {new Date(canvas.lastImportedAt).toLocaleString()}
        </p>
      )}
      <div className={`calendar-days ${mode}`}>
        {days.map((day) => (
          <section
            className="panel calendar-day"
            key={day}
            aria-label={`Agenda ${day}`}
          >
            <h2>
              {new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, {
                timeZone: 'UTC',
                weekday: 'short',
                month: 'short',
                day: 'numeric',
              })}
            </h2>
            {canvas?.key === canvasKey &&
              canvas.items
                .filter((item) =>
                  canvasItemInRange(
                    item,
                    day,
                    Temporal.PlainDate.from(day).add({ days: 1 }).toString(),
                    timeZone,
                  ),
                )
                .map((item) => (
                  <CanvasEntry key={item.id} item={item} timeZone={timeZone} />
                ))}
            {occurrences
              .filter((item) =>
                item.allDay
                  ? item.startDate! <= day && item.endDate! > day
                  : Temporal.Instant.compare(
                      Temporal.Instant.from(item.startsAt),
                      Temporal.PlainDate.from(day)
                        .add({ days: 1 })
                        .toZonedDateTime(timeZone)
                        .toInstant(),
                    ) < 0 &&
                    Temporal.Instant.compare(
                      Temporal.Instant.from(item.endsAt),
                      Temporal.PlainDate.from(day)
                        .toZonedDateTime(timeZone)
                        .toInstant(),
                    ) > 0,
              )
              .map((item) => (
                <article
                  className={`calendar-event ${item.studyStatus === 'cancelled' ? 'cancelled' : ''}`}
                  key={item.occurrenceId}
                >
                  <strong>{item.title}</strong>
                  <small>
                    {item.allDay
                      ? 'All day'
                      : `${new Date(item.startsAt).toLocaleTimeString(undefined, { timeZone, hour: 'numeric', minute: '2-digit' })} – ${new Date(item.endsAt).toLocaleTimeString(undefined, { timeZone, hour: 'numeric', minute: '2-digit' })}`}
                  </small>
                  {item.courseId && (
                    <small>
                      Study ·{' '}
                      {courses.find((course) => course.id === item.courseId)
                        ?.name ?? 'Archived class'}{' '}
                      · {item.studyStatus}
                    </small>
                  )}
                  {item.recurrence && (
                    <small>
                      Repeats {item.recurrence.frequency}
                      {item.overridden ? ' · edited occurrence' : ''}
                    </small>
                  )}
                  {plannerSensitivity(item) !== 'unlabeled' && (
                    <small>{plannerSensitivity(item)}</small>
                  )}
                  <PlannerSource source={item.canvasSource} />
                  <div className="item-actions calendar-actions">
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() => {
                        setError('');
                        setEditing({
                          event: item,
                          originalDate: item.recurrence
                            ? item.originalDate
                            : null,
                        });
                      }}
                    >
                      Edit {item.recurrence ? 'occurrence' : 'event'}
                    </button>
                    {item.recurrence && (
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() => {
                          const series = events.find(
                            (value) => value.id === item.id,
                          );
                          if (series) {
                            setEditing({ event: series, originalDate: null });
                            setError(
                              'Changing the series start or repetition resets its occurrence edits and cancels occurrence reminders.',
                            );
                          }
                        }}
                      >
                        Edit series
                      </button>
                    )}
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() => {
                        void remove(item, false);
                      }}
                    >
                      Delete {item.recurrence ? 'occurrence' : 'event'}
                    </button>
                    {item.recurrence && (
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() => {
                          void remove(item, true);
                        }}
                      >
                        Delete series
                      </button>
                    )}
                    {item.courseId && item.studyStatus === 'planned' && (
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() => {
                          void complete(item);
                        }}
                      >
                        Complete session
                      </button>
                    )}
                  </div>
                </article>
              ))}
          </section>
        ))}
      </div>
      <div className="panel calendar-editor">
        <CalendarEditor
          key={`${editing?.event.id ?? 'new'}:${editing?.originalDate ?? 'series'}:${revision}`}
          editing={editing}
          courses={courses}
          topics={topics}
          date={date}
          timeZone={timeZone}
          studyDraft={studyDraft}
          busy={busy}
          onSave={save}
          onError={setError}
          onCancel={() => setEditing(null)}
        />
      </div>
    </section>
  );
}
function CalendarEditor({
  editing,
  courses,
  topics,
  date,
  timeZone,
  studyDraft,
  busy,
  onSave,
  onError,
  onCancel,
}: {
  editing: Editing | null;
  courses: Course[];
  topics: Topic[];
  date: string;
  timeZone: string;
  studyDraft: StudyDraft | null;
  busy: boolean;
  onSave: (value: CalendarInput) => Promise<void>;
  onError: (value: string) => void;
  onCancel: () => void;
}) {
  const event = editing?.event;
  const [allDay, setAllDay] = useState(event?.allDay ?? false);
  const [eventZone, setEventZone] = useState(event?.timeZone ?? timeZone);
  const [frequency, setFrequency] = useState(
    editing?.originalDate ? 'none' : (event?.recurrence?.frequency ?? 'none'),
  );
  const [course, setCourse] = useState(
    event?.courseId ?? studyDraft?.courseId ?? '',
  );
  function submit(action: FormEvent<HTMLFormElement>) {
    action.preventDefault();
    const data = new FormData(action.currentTarget);
    try {
      const startDate = allDay ? String(data.get('startDate')) : null;
      const endDate = allDay
        ? Temporal.PlainDate.from(String(data.get('lastDate')))
            .add({ days: 1 })
            .toString()
        : null;
      const choice = String(data.get('offset')) as
        'reject' | 'earlier' | 'later';
      const values: CalendarInput = {
        title: String(data.get('title')),
        notes: String(data.get('notes')),
        timeZone: eventZone,
        sensitivity: String(
          data.get('sensitivity'),
        ) as CalendarInput['sensitivity'],
        allDay,
        startDate,
        endDate,
        startsAt: allDay
          ? `${startDate}T00:00:00.000Z`
          : wallTimeToInstant(String(data.get('startsAt')), eventZone, choice),
        endsAt: allDay
          ? `${endDate}T00:00:00.000Z`
          : wallTimeToInstant(String(data.get('endsAt')), eventZone, choice),
        recurrence:
          frequency === 'none'
            ? null
            : {
                frequency: frequency as 'daily' | 'weekly' | 'monthly',
                interval: Number(data.get('interval')),
                count: data.get('count') ? Number(data.get('count')) : null,
                until: data.get('until') ? String(data.get('until')) : null,
              },
        courseId: course || null,
        topicId: course && data.get('topic') ? String(data.get('topic')) : null,
        studyStatus: String(
          data.get('status') ?? 'planned',
        ) as CalendarInput['studyStatus'],
      };
      void onSave(values);
    } catch (failure) {
      onError(
        failure instanceof Error ? failure.message : 'Check the entered times.',
      );
    }
  }
  return (
    <form className="editor-form" onSubmit={submit}>
      <h2>
        {editing
          ? `Edit ${editing.originalDate ? 'occurrence' : 'event / series'}`
          : studyDraft
            ? 'Schedule study time'
            : 'Add calendar event'}
      </h2>
      <label>
        Calendar event title
        <input
          name="title"
          defaultValue={event?.title ?? studyDraft?.title ?? ''}
          required
          maxLength={200}
        />
      </label>
      <label>
        Calendar notes
        <textarea
          name="notes"
          defaultValue={event?.notes ?? ''}
          maxLength={10000}
          rows={2}
        />
      </label>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={allDay}
          onChange={(action) => setAllDay(action.target.checked)}
        />
        All-day event
      </label>
      <label>
        Event timezone
        <input
          value={eventZone}
          onChange={(action) => setEventZone(action.target.value)}
          required
          maxLength={100}
        />
      </label>
      {allDay ? (
        <div className="form-row">
          <label>
            First day
            <input
              name="startDate"
              type="date"
              defaultValue={event?.startDate ?? date}
              required
            />
          </label>
          <label>
            Last day
            <input
              name="lastDate"
              type="date"
              defaultValue={
                event?.endDate
                  ? Temporal.PlainDate.from(event.endDate)
                      .subtract({ days: 1 })
                      .toString()
                  : date
              }
              required
            />
          </label>
        </div>
      ) : (
        <>
          <div className="form-row">
            <label>
              Event starts
              <input
                name="startsAt"
                type="datetime-local"
                required
                defaultValue={
                  event
                    ? instantToWall(event.startsAt, event.timeZone)
                    : `${date}T10:00`
                }
              />
            </label>
            <label>
              Event ends
              <input
                name="endsAt"
                type="datetime-local"
                required
                defaultValue={
                  event
                    ? instantToWall(event.endsAt, event.timeZone)
                    : `${date}T11:00`
                }
              />
            </label>
          </div>
          <label>
            Repeated-time offset
            <select
              name="offset"
              defaultValue={
                event
                  ? Temporal.Instant.from(event.startsAt).toZonedDateTimeISO(
                      event.timeZone,
                    ).offset ===
                    Temporal.PlainDateTime.from(
                      instantToWall(event.startsAt, event.timeZone),
                    ).toZonedDateTime(event.timeZone, {
                      disambiguation: 'later',
                    }).offset
                    ? 'later'
                    : 'earlier'
                  : 'reject'
              }
            >
              <option value="reject">
                Require a choice if time occurs twice
              </option>
              <option value="earlier">Earlier offset</option>
              <option value="later">Later offset</option>
            </select>
          </label>
          <Help label="Calendar">
            Times use the event timezone. Nonexistent local times are rejected.
            Repeats preserve local start time; future DST gaps shift forward and
            repeated times use the earlier offset.
          </Help>
        </>
      )}
      {!editing?.originalDate && (
        <>
          <label>
            Repeat
            <select
              value={frequency}
              onChange={(action) => setFrequency(action.target.value)}
            >
              <option value="none">Does not repeat</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </label>
          {frequency !== 'none' && (
            <>
              <div className="form-row">
                <label>
                  Repeat interval
                  <input
                    name="interval"
                    type="number"
                    min={1}
                    max={52}
                    defaultValue={event?.recurrence?.interval ?? 1}
                    required
                  />
                </label>
                <label>
                  Occurrences (blank = ongoing)
                  <input
                    name="count"
                    type="number"
                    min={1}
                    max={1000}
                    defaultValue={event?.recurrence?.count ?? ''}
                  />
                </label>
              </div>
              <label>
                Repeat until (inclusive, optional)
                <input
                  name="until"
                  type="date"
                  defaultValue={event?.recurrence?.until ?? ''}
                />
              </label>
              <Help label="Calendar">
                Weekly repeats use the start weekday. Monthly repeats skip
                months without the start day.
              </Help>
            </>
          )}
        </>
      )}
      <div className="form-row">
        <label>
          Study class
          <select
            value={course}
            onChange={(action) => setCourse(action.target.value)}
          >
            <option value="">No class / regular event</option>
            {courses.map((value) => (
              <option value={value.id} key={value.id}>
                {value.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Study topic
          <select
            name="topic"
            key={course}
            defaultValue={event?.topicId ?? studyDraft?.topicId ?? ''}
          >
            <option value="">General class study</option>
            {topics
              .filter((value) => value.courseId === course)
              .map((value) => (
                <option value={value.id} key={value.id}>
                  {value.name}
                </option>
              ))}
          </select>
        </label>
      </div>
      {course && (
        <label>
          Study status
          <select name="status" defaultValue={event?.studyStatus ?? 'planned'}>
            <option value="planned">Planned</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </label>
      )}
      <label>
        Event content label
        <select
          name="sensitivity"
          defaultValue={event?.sensitivity ?? 'unlabeled'}
        >
          <option value="unlabeled">Unlabeled</option>
          <option value="personal">Personal</option>
          <option value="restricted">Restricted</option>
        </select>
      </label>
      <Help label="Calendar">
        Study blocks inherit class/topic labels. Completion does not
        automatically change topic confidence.
      </Help>
      <div className="form-actions">
        <button className="primary-button" disabled={busy} aria-busy={busy}>
          {editing ? 'Save calendar changes' : 'Save calendar event'}
        </button>
        {editing && (
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel calendar edit
          </button>
        )}
      </div>
    </form>
  );
}
