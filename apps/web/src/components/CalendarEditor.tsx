import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  calendarResponseSchema,
  occurrencesResponseSchema,
  Temporal,
} from '@hub/contracts';
import type { CalendarRecord, Course, Topic } from '@hub/contracts';
import { getJson } from '../lib/api';
import {
  DraftError,
  checkLocalTime,
  foldChoices,
  localTimeMessages,
  resetsSeries,
  toDraft,
  toInput,
  tryInput,
} from '../lib/calendar';
import type {
  CalendarDraft,
  DraftField,
  Offset,
  StudyDraft,
} from '../lib/calendar';
import { useMutation, useResource } from '../lib/hooks';
import type { CalendarEditorRoute, Route } from '../lib/router';
import { Help } from './Help';
import { Link } from './Link';
import { PlannerSource } from './PlannerSource';
import { TimeZoneInput } from './TimeZoneInput';

type CalendarRoute = Extract<Route, { name: 'calendar' }>;
export type ReloadEvents = () => Promise<CalendarRecord[] | undefined>;

type Props = {
  editor: CalendarEditorRoute;
  events: CalendarRecord[];
  loaded: boolean;
  courses: Course[];
  topics: Topic[];
  /** Day shown in the list; new events start there. */
  date: string;
  viewingZone: string;
  study: StudyDraft | null;
  listRoute: CalendarRoute;
  navigate: (route: Route) => void;
  reload: ReloadEvents;
  onSaved: (event: CalendarRecord, created: boolean) => void;
  /** Deletes the series, or only one occurrence when `occurrenceDate` is set. */
  onDelete: (
    series: CalendarRecord,
    occurrenceDate: string | null,
  ) => Promise<void>;
  deleting: boolean;
};

/** Finds the record to edit: the series from the list, or one occurrence
 *  (fetched around its date, since the list may show another window). */
export function CalendarEditor(props: Props) {
  const { editor, events, loaded } = props;
  const series =
    editor.kind === 'new'
      ? null
      : (events.find((event) => event.id === editor.id) ?? null);
  const occurrenceDate = editor.kind === 'occurrence' ? editor.date : null;
  const occurrence = useResource(
    async (signal) => {
      if (!series || !occurrenceDate) return null;
      const around = Temporal.PlainDate.from(occurrenceDate);
      const query = new URLSearchParams({
        from: around.subtract({ days: 31 }).toString(),
        to: around.add({ days: 32 }).toString(),
        timeZone: series.timeZone,
      });
      const result = await getJson(
        `/api/v1/calendar/occurrences?${query}`,
        occurrencesResponseSchema,
        signal,
      );
      return (
        result.occurrences.find(
          (item) =>
            item.id === series.id && item.originalDate === occurrenceDate,
        ) ?? null
      );
    },
    {
      failure: 'This occurrence could not be loaded. Retry.',
      key: `${series?.id ?? ''}:${occurrenceDate ?? ''}`,
    },
  );

  /** Wide screens keep the agenda beside the editor, so the link only shows
   *  there when the editor has nothing to edit (`always`). */
  const backLink = (always: boolean) => (
    <Link
      className={`calendar-editor__back ${always ? 'calendar-editor__back--always' : ''}`}
      route={props.listRoute}
      navigate={props.navigate}
    >
      Back to calendar
    </Link>
  );
  const back = backLink(true);
  const message = (text: string, alert = false) => (
    <section className="panel calendar-editor" aria-label="Event editor">
      {back}
      <p role={alert ? 'alert' : 'status'}>{text}</p>
    </section>
  );

  if (editor.kind !== 'new' && !series)
    return loaded
      ? message('This event is not available. It may have been deleted.')
      : message('Loading…');
  if (editor.kind === 'occurrence') {
    if (occurrence.error) return message(occurrence.error, true);
    if (!occurrence.data) {
      return occurrence.loading || occurrence.data === undefined ? (
        message('Loading…')
      ) : (
        <section className="panel calendar-editor" aria-label="Event editor">
          {back}
          <p>This occurrence is not available. It may have been removed.</p>
          <Link
            className="calendar-link"
            route={{
              ...props.listRoute,
              editor: { kind: 'event', id: editor.id },
            }}
            navigate={props.navigate}
          >
            Edit entire series
          </Link>
        </section>
      );
    }
  }

  const source =
    editor.kind === 'occurrence'
      ? occurrence.data!
      : (series as CalendarRecord | null);
  async function refresh() {
    const fresh = await props.reload();
    if (editor.kind !== 'occurrence')
      return fresh?.find((event) => event.id === series?.id);
    return (await occurrence.reload()) ?? undefined;
  }
  return (
    <EditorForm
      key={`${editor.kind}:${series?.id ?? ''}:${occurrenceDate ?? ''}`}
      {...props}
      series={series}
      source={source}
      occurrenceDate={occurrenceDate}
      back={backLink(false)}
      refresh={refresh}
    />
  );
}

const fieldLabels: Partial<Record<keyof CalendarDraft, string>> = {
  title: 'Title',
  notes: 'Notes',
  allDay: 'All-day',
  timeZone: 'Event timezone',
  startDate: 'First day',
  lastDate: 'Last day',
  startsAt: 'Starts',
  endsAt: 'Ends',
  frequency: 'Repeat',
  interval: 'Every',
  count: 'Occurrences',
  until: 'Repeat until',
  courseId: 'Class',
  topicId: 'Topic',
  studyStatus: 'Status',
  sensitivity: 'Content label',
};
const display = (value: string | boolean) =>
  value === true ? 'Yes' : value === false ? 'No' : value || 'None';

function EditorForm({
  editor,
  series,
  source,
  occurrenceDate,
  events,
  courses,
  topics,
  date,
  viewingZone,
  study,
  listRoute,
  navigate,
  onSaved,
  onDelete,
  deleting,
  back,
  refresh,
}: Props & {
  series: CalendarRecord | null;
  source: CalendarRecord | null;
  occurrenceDate: string | null;
  back: React.ReactNode;
  refresh: () => Promise<CalendarRecord | undefined>;
}) {
  const creating = editor.kind === 'new';
  const defaults = {
    date,
    timeZone: viewingZone,
    study: creating ? study : null,
  };
  const [draft, setDraft] = useState<CalendarDraft>(() => ({
    ...toDraft(source, defaults),
    // An occurrence is one instance: it cannot repeat.
    ...(occurrenceDate ? { frequency: 'none' as const } : {}),
  }));
  // The version the draft was made from; only an explicit load or this
  // editor's own save moves it, so newer server data is never adopted silently.
  const [base, setBase] = useState(source?.version ?? 0);
  const [server, setServer] = useState<CalendarDraft | null>(null);
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState<{
    field: DraftField;
    text: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const save = useMutation();

  const latest = series
    ? events.find((event) => event.id === series.id)
    : undefined;
  const deletedElsewhere = !creating && !latest;
  const changedElsewhere =
    !creating && !!latest && (latest.version !== base || save.conflict);
  const blocked = deletedElsewhere || changedElsewhere;
  const recurring = !!series?.recurrence;
  const differences = server
    ? (Object.keys(fieldLabels) as (keyof CalendarDraft)[]).filter(
        (field) => server[field] !== draft[field],
      )
    : [];

  const startCheck = draft.allDay
    ? 'ok'
    : checkLocalTime(draft.startsAt, draft.timeZone);
  const endCheck = draft.allDay
    ? 'ok'
    : checkLocalTime(draft.endsAt, draft.timeZone);

  // The input as it would be saved, to warn before an edit resets a series.
  const pending = tryInput(draft);
  const willReset =
    !!series?.recurrence &&
    !occurrenceDate &&
    !!pending &&
    resetsSeries(series, pending);

  const update = <K extends keyof CalendarDraft>(
    field: K,
    value: CalendarDraft[K],
  ) => {
    setDraft((previous) => {
      const next = { ...previous, [field]: value };
      // A new time or zone needs its own choice if it occurs twice.
      if (field === 'startsAt' || field === 'timeZone') next.startOffset = '';
      if (field === 'endsAt' || field === 'timeZone') next.endOffset = '';
      if (field === 'courseId') next.topicId = '';
      return next;
    });
    setMessage('');
    setProblem(null);
  };
  const focusField = (field: DraftField) =>
    form.current
      ?.querySelector<HTMLElement>(`[data-field="${field}"]`)
      ?.focus();

  async function loadLatest() {
    setLoading(true);
    const fresh = await refresh();
    setLoading(false);
    if (!fresh) return;
    setBase(fresh.version);
    setServer({
      ...toDraft(fresh, defaults),
      ...(occurrenceDate ? { frequency: 'none' as const } : {}),
    });
    save.reset();
    setMessage('Latest version loaded. Your edits are kept.');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (blocked) return;
    let input;
    try {
      input = toInput(draft);
    } catch (error) {
      if (!(error instanceof DraftError)) throw error;
      setProblem({ field: error.field, text: error.message });
      // Wait for the error text to render before moving focus.
      requestAnimationFrame(() => focusField(error.field));
      return;
    }
    const path = creating
      ? '/api/v1/calendar'
      : occurrenceDate
        ? `/api/v1/calendar/${series!.id}/occurrences/${occurrenceDate}`
        : `/api/v1/calendar/${series!.id}`;
    const result = await save.run(
      calendarResponseSchema,
      creating ? 'POST' : 'PUT',
      path,
      creating ? input : { ...input, expectedVersion: base },
      'Could not save the event. Your changes are still here.',
    );
    if (!result) return;
    if (creating) {
      onSaved(result.event, true);
      return;
    }
    setServer(null);
    setMessage('Saved.');
    // Our own save just completed, so the refreshed version is ours to adopt.
    const fresh = await refresh();
    setBase(fresh?.version ?? result.event.version);
    onSaved(result.event, false);
  }

  const heading = creating
    ? study
      ? 'Schedule study time'
      : 'New event'
    : occurrenceDate
      ? 'Edit occurrence'
      : recurring
        ? 'Edit series'
        : 'Edit event';
  const shownProblem = (field: DraftField) => {
    if (problem?.field !== field) return null;
    // Repeated or missing times already explain themselves below the field.
    if (
      (field === 'startsAt' && startCheck !== 'ok') ||
      (field === 'endsAt' && endCheck !== 'ok')
    )
      return null;
    return (
      <p id={`calendar-${field}-error`} className="form-error">
        <span className="visually-hidden">Error: </span>
        {problem.text}
      </p>
    );
  };
  const attrs = (field: DraftField) => ({
    'data-field': field,
    'aria-invalid': problem?.field === field || undefined,
    'aria-describedby':
      problem?.field === field ? `calendar-${field}-error` : undefined,
  });
  const classCourse = courses.find((course) => course.id === draft.courseId);

  return (
    <section
      className="panel calendar-editor"
      aria-labelledby="calendar-editor-title"
    >
      {back}
      <h2 id="calendar-editor-title">{heading}</h2>
      {occurrenceDate && series && (
        <>
          <p>Only {occurrenceDate} changes.</p>
          <Link
            className="calendar-link"
            route={{ ...listRoute, editor: { kind: 'event', id: series.id } }}
            navigate={navigate}
          >
            Edit entire series
          </Link>
        </>
      )}
      {deletedElsewhere && (
        <p role="alert" className="form-error">
          This event was deleted elsewhere. Your edits are still here but cannot
          be saved.
        </p>
      )}
      {changedElsewhere && (
        <div role="alert" className="form-error">
          <p>Changed elsewhere. Your edits are still here.</p>
          <button
            type="button"
            className="secondary-button"
            disabled={loading}
            onClick={() => {
              void loadLatest();
            }}
          >
            {loading ? 'Loading…' : 'Load latest version'}
          </button>
        </div>
      )}
      {server && differences.length > 0 && (
        <details open>
          <summary>Differences from the latest version</summary>
          <dl className="calendar-compare">
            {differences.map((field) => (
              <div key={field}>
                <dt>{fieldLabels[field]}</dt>
                <dd>Latest: {display(server[field] as string | boolean)}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
      <form
        ref={form}
        className="editor-form"
        noValidate
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <fieldset className="calendar-section">
          <legend>Basics</legend>
          <label>
            Title
            <input
              {...attrs('title')}
              value={draft.title}
              maxLength={200}
              onChange={(event) => update('title', event.target.value)}
            />
          </label>
          {shownProblem('title')}
          <label>
            Notes (optional)
            <textarea
              rows={3}
              maxLength={10000}
              value={draft.notes}
              onChange={(event) => update('notes', event.target.value)}
            />
          </label>
        </fieldset>

        <fieldset className="calendar-section">
          <legend>Time</legend>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={draft.allDay}
              onChange={(event) => update('allDay', event.target.checked)}
            />
            All-day
          </label>
          <label>
            Event timezone
            <TimeZoneInput
              {...attrs('timeZone')}
              value={draft.timeZone}
              onChange={(event) => update('timeZone', event.target.value)}
            />
          </label>
          {shownProblem('timeZone')}
          {draft.allDay ? (
            <div className="form-row">
              <label>
                First day
                <input
                  {...attrs('startDate')}
                  type="date"
                  value={draft.startDate}
                  onChange={(event) => update('startDate', event.target.value)}
                />
              </label>
              <label>
                Last day
                <input
                  {...attrs('lastDate')}
                  type="date"
                  value={draft.lastDate}
                  onChange={(event) => update('lastDate', event.target.value)}
                />
              </label>
              {shownProblem('startDate')}
              {shownProblem('lastDate')}
            </div>
          ) : (
            <>
              <TimeField
                label="Starts"
                field="startsAt"
                value={draft.startsAt}
                check={startCheck}
                offset={draft.startOffset}
                zone={draft.timeZone}
                attrs={attrs('startsAt')}
                onChange={(value) => update('startsAt', value)}
                onOffset={(value) =>
                  setDraft((previous) => ({ ...previous, startOffset: value }))
                }
              />
              {shownProblem('startsAt')}
              <TimeField
                label="Ends"
                field="endsAt"
                value={draft.endsAt}
                check={endCheck}
                offset={draft.endOffset}
                zone={draft.timeZone}
                attrs={attrs('endsAt')}
                onChange={(value) => update('endsAt', value)}
                onOffset={(value) =>
                  setDraft((previous) => ({ ...previous, endOffset: value }))
                }
              />
              {shownProblem('endsAt')}
            </>
          )}
          <Help label="Time">
            Times use the event timezone, not the timezone you are viewing in.
            Repeats keep the local start time; a repeat that lands in a skipped
            hour moves forward and in a repeated hour uses the earlier time.
          </Help>
        </fieldset>

        {!occurrenceDate && (
          <fieldset className="calendar-section">
            <legend>Repeat</legend>
            <label>
              Repeat
              <select
                value={draft.frequency}
                onChange={(event) =>
                  update(
                    'frequency',
                    event.target.value as CalendarDraft['frequency'],
                  )
                }
              >
                <option value="none">Does not repeat</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </label>
            {draft.frequency !== 'none' && (
              <>
                <div className="form-row">
                  <label>
                    Every (1–52)
                    <input
                      {...attrs('interval')}
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={52}
                      value={draft.interval}
                      onChange={(event) =>
                        update('interval', event.target.value)
                      }
                    />
                  </label>
                  <label>
                    Occurrences (blank = ongoing)
                    <input
                      {...attrs('count')}
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={1000}
                      value={draft.count}
                      onChange={(event) => update('count', event.target.value)}
                    />
                  </label>
                </div>
                {shownProblem('interval')}
                {shownProblem('count')}
                <label>
                  Repeat until (optional)
                  <input
                    {...attrs('until')}
                    type="date"
                    value={draft.until}
                    onChange={(event) => update('until', event.target.value)}
                  />
                </label>
                <Help label="Repeat">
                  Weekly repeats use the start weekday. Monthly repeats skip
                  months without the start day.
                </Help>
              </>
            )}
            {willReset && (
              <p role="status" className="calendar-warning">
                Saving resets this series’ edited occurrences and cancels their
                reminders.
              </p>
            )}
          </fieldset>
        )}

        <fieldset className="calendar-section">
          <legend>Study</legend>
          <div className="form-row">
            <label>
              Class
              <select
                value={draft.courseId}
                onChange={(event) => update('courseId', event.target.value)}
              >
                <option value="">No class</option>
                {draft.courseId && !classCourse && (
                  <option value={draft.courseId}>Archived class</option>
                )}
                {courses.map((course) => (
                  <option value={course.id} key={course.id}>
                    {course.name}
                  </option>
                ))}
              </select>
            </label>
            {draft.courseId && (
              <label>
                Topic
                <select
                  value={draft.topicId}
                  onChange={(event) => update('topicId', event.target.value)}
                >
                  <option value="">General class study</option>
                  {topics
                    .filter((topic) => topic.courseId === draft.courseId)
                    .map((topic) => (
                      <option value={topic.id} key={topic.id}>
                        {topic.name}
                      </option>
                    ))}
                </select>
              </label>
            )}
          </div>
          {draft.courseId && (
            <label>
              Status
              <select
                value={draft.studyStatus}
                onChange={(event) =>
                  update(
                    'studyStatus',
                    event.target.value as CalendarDraft['studyStatus'],
                  )
                }
              >
                <option value="planned">Planned</option>
                <option value="completed">Completed</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </label>
          )}
          <Help label="Study">
            Study blocks inherit class and topic labels. Marking a session
            completed does not change topic confidence.
          </Help>
        </fieldset>

        <fieldset className="calendar-section">
          <legend>Label</legend>
          <label>
            Content label
            <select
              value={draft.sensitivity}
              onChange={(event) =>
                update(
                  'sensitivity',
                  event.target.value as CalendarDraft['sensitivity'],
                )
              }
            >
              <option value="unlabeled">Unlabeled</option>
              <option value="personal">Personal</option>
              <option value="restricted">Restricted</option>
            </select>
          </label>
          <Help label="Content label">
            Labels you apply limit which AI providers may use this event. Labels
            inherited from a class or source stay applied.
          </Help>
        </fieldset>

        {save.error && !changedElsewhere && (
          <p role="alert" className="form-error">
            {save.error}
          </p>
        )}
        <p role="status">{message}</p>
        <div className="form-actions">
          <button className="primary-button" disabled={save.pending || blocked}>
            {save.pending
              ? 'Saving…'
              : creating
                ? 'Save event'
                : 'Save changes'}
          </button>
        </div>
      </form>
      {latest && (
        <>
          <PlannerSource source={latest.canvasSource} />
          <div className="calendar-editor__danger">
            <button
              type="button"
              className="danger-button"
              disabled={deleting || save.pending}
              onClick={() => {
                void onDelete(latest, occurrenceDate);
              }}
            >
              {occurrenceDate
                ? 'Delete occurrence or series'
                : recurring
                  ? 'Delete series'
                  : 'Delete event'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/** A date-time field that explains a skipped time and asks which one is meant
 *  for a repeated time. Choices appear only when the entered time needs them. */
function TimeField({
  label,
  field,
  value,
  check,
  offset,
  zone,
  attrs,
  onChange,
  onOffset,
}: {
  label: string;
  field: 'startsAt' | 'endsAt';
  value: string;
  check: ReturnType<typeof checkLocalTime>;
  offset: Offset;
  zone: string;
  attrs: Record<string, unknown>;
  onChange: (value: string) => void;
  onOffset: (value: Offset) => void;
}) {
  const choices = check === 'fold' ? foldChoices(value, zone) : null;
  return (
    <>
      <label>
        {label}
        <input
          {...attrs}
          // Focus goes to the choice instead when the time occurs twice.
          data-field={check === 'fold' ? undefined : field}
          type="datetime-local"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      {check === 'gap' && (
        <p role="status" className="form-error">
          {localTimeMessages.gap}
        </p>
      )}
      {choices && (
        <fieldset className="calendar-fold">
          <legend>{label} at a repeated time</legend>
          <p role="status">{localTimeMessages.fold}</p>
          {(['earlier', 'later'] as const).map((option, index) => (
            <label key={option} className="checkbox-label">
              <input
                type="radio"
                name={`${field}-offset`}
                data-field={index === 0 ? field : undefined}
                checked={offset === option}
                onChange={() => onOffset(option)}
              />
              {option === 'earlier' ? 'Earlier' : 'Later'} (UTC{choices[option]}
              )
            </label>
          ))}
        </fieldset>
      )}
    </>
  );
}
