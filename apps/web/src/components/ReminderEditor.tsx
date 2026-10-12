import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  calendarListSchema,
  reminderResponseSchema,
  reminderSnoozeResponseSchema,
  tasksResponseSchema,
  wallTimeToInstant,
} from '@hub/contracts';
import type { Reminder } from '@hub/contracts';
import { getSnapshot } from '../lib/api';
import { checkLocalTime, foldChoices } from '../lib/calendar';
import { useMutation, useResource } from '../lib/hooks';
import { snoozeChoices } from '../lib/reminders';
import { instantToWall } from '@hub/contracts';
import { Help } from './Help';

type Offset = 'earlier' | 'later' | '';

const timeMessages = {
  gap: 'This time does not exist in your timezone (clocks skip forward). Choose another time.',
  fold: 'This time happens twice in your timezone (clocks go back). Choose which one.',
} as const;

/** Time field with its gap/fold handling, shared by add, reschedule and snooze. */
function WhenField({
  label,
  value,
  offset,
  zone,
  onChange,
  onOffset,
  error,
  fieldRef,
}: {
  label: string;
  value: string;
  offset: Offset;
  zone: string;
  onChange: (value: string) => void;
  onOffset: (value: Offset) => void;
  error: string;
  fieldRef: React.RefObject<HTMLInputElement | null>;
}) {
  const check = value ? checkLocalTime(value, zone) : 'ok';
  const choices = check === 'fold' ? foldChoices(value, zone) : null;
  return (
    <>
      <label>
        {label}
        <input
          ref={fieldRef}
          type="datetime-local"
          value={value}
          aria-invalid={!!error || check === 'gap'}
          aria-describedby={error ? 'reminder-time-error' : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      {error && (
        <p id="reminder-time-error" className="form-error">
          <span className="visually-hidden">Error: </span>
          {error}
        </p>
      )}
      {check === 'gap' && (
        <p role="status" className="form-error">
          {timeMessages.gap}
        </p>
      )}
      {choices && (
        <fieldset className="calendar-fold">
          <legend>{label} at a repeated time</legend>
          <p role="status">{timeMessages.fold}</p>
          {(['earlier', 'later'] as const).map((option) => (
            <label key={option} className="checkbox-label">
              <input
                type="radio"
                name="reminder-offset"
                checked={offset === option}
                onChange={() => onOffset(option)}
              />
              {option === 'earlier' ? 'Earlier' : 'Later'} (UTC
              {choices[option]})
            </label>
          ))}
        </fieldset>
      )}
    </>
  );
}

/** Errors for a typed local time, or the instant it means. */
function resolveTime(value: string, zone: string, offset: Offset) {
  if (!value) return { error: 'Choose a time' } as const;
  const check = checkLocalTime(value, zone);
  if (check === 'gap') return { error: timeMessages.gap } as const;
  if (check === 'fold' && !offset) return { error: timeMessages.fold } as const;
  return {
    instant: wallTimeToInstant(value, zone, offset || 'reject'),
  } as const;
}

function ChangedElsewhere({
  loading,
  onLoad,
}: {
  loading: boolean;
  onLoad: () => void;
}) {
  return (
    <div role="alert" className="form-error">
      <p>Changed elsewhere. Your edits are still here.</p>
      <button
        type="button"
        className="secondary-button"
        disabled={loading}
        onClick={onLoad}
      >
        {loading ? 'Loading…' : 'Load latest version'}
      </button>
    </div>
  );
}

/**
 * Adds a reminder, reschedules a queued/paused/failed one, or snoozes a
 * delivered one. The draft keeps the version it started from; newer server
 * data is only adopted by an explicit "Load latest version".
 */
export function ReminderEditor({
  reminder,
  reload,
  onDone,
}: {
  reminder?: Reminder | undefined;
  reload: () => Promise<Reminder[] | undefined>;
  onDone: () => void;
}) {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const snoozing = reminder?.status === 'delivered';
  const [title, setTitle] = useState(reminder?.title ?? '');
  const [when, setWhen] = useState(
    reminder && !snoozing ? instantToWall(reminder.scheduledAt, zone) : '',
  );
  const [offset, setOffset] = useState<Offset>('');
  const [target, setTarget] = useState(
    reminder?.targetKind ? `${reminder.targetKind}:${reminder.targetId}` : '',
  );
  const [occurrence, setOccurrence] = useState(reminder?.occurrenceDate ?? '');
  const [base, setBase] = useState(reminder?.version ?? 0);
  const [titleError, setTitleError] = useState('');
  const [timeError, setTimeError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  // A save that finishes after the owner left must not navigate them back.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const titleField = useRef<HTMLInputElement>(null);
  const timeField = useRef<HTMLInputElement>(null);
  const save = useMutation();
  // Linked-item choices are only needed (and fetched) while editing.
  const tasks = useResource(
    (signal) => getSnapshot('/api/v1/tasks', tasksResponseSchema, signal),
    { failure: 'Tasks unavailable, so linked items cannot be listed.' },
  );
  const events = useResource(
    (signal) => getSnapshot('/api/v1/calendar', calendarListSchema, signal),
    { failure: 'Events unavailable, so linked items cannot be listed.' },
  );
  const changedElsewhere =
    !!reminder && (reminder.version !== base || save.conflict);
  const [sourceKind = '', sourceId = ''] = target.split(':');
  const editable =
    !reminder ||
    ['queued', 'paused', 'failed', 'delivered'].includes(reminder.status);

  async function loadLatest() {
    setLoading(true);
    const fresh = (await reload())?.find((item) => item.id === reminder?.id);
    setLoading(false);
    if (!fresh) return;
    setBase(fresh.version);
    save.reset();
    setMessage('Latest version loaded. Your edits are kept.');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (changedElsewhere) return;
    setTitleError('');
    setTimeError('');
    if (!snoozing && !title.trim()) {
      setTitleError('Enter a reminder title');
      titleField.current?.focus();
      return;
    }
    const time = resolveTime(when, zone, offset);
    if ('error' in time) {
      setTimeError(time.error);
      timeField.current?.focus();
      return;
    }
    const saved = snoozing
      ? await save.run(
          reminderSnoozeResponseSchema,
          'POST',
          `/api/v1/reminders/${reminder.id}/snooze`,
          { scheduledAt: time.instant, expectedVersion: base },
          'Could not snooze. Your time is still here.',
        )
      : await save.run(
          reminderResponseSchema,
          reminder ? 'PUT' : 'POST',
          reminder ? `/api/v1/reminders/${reminder.id}` : '/api/v1/reminders',
          {
            title,
            scheduledAt: time.instant,
            targetKind: sourceKind || null,
            targetId: sourceId || null,
            occurrenceDate:
              sourceKind === 'event' && occurrence ? occurrence : null,
            ...(reminder ? { expectedVersion: base } : {}),
          },
          'Could not save reminder. Your changes are still here.',
        );
    if (!saved) return;
    await reload();
    if (mounted.current) onDone();
  }

  const heading = snoozing
    ? 'Snooze reminder'
    : reminder
      ? 'Reschedule reminder'
      : 'Add reminder';

  if (!editable)
    return <p>This reminder is {reminder.status} and cannot be changed.</p>;

  return (
    <form
      className="editor-form"
      noValidate
      aria-label={heading}
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      {changedElsewhere && (
        <ChangedElsewhere
          loading={loading}
          onLoad={() => {
            void loadLatest();
          }}
        />
      )}
      {snoozing ? (
        <>
          <p>
            <strong>{reminder.title}</strong> was delivered. Snoozing adds a new
            reminder; the original stays in the inbox.
          </p>
          <div className="form-actions">
            {snoozeChoices(new Date()).map((choice) => (
              <button
                key={choice.label}
                type="button"
                className="secondary-button"
                onClick={() => {
                  setWhen(choice.value);
                  setOffset('');
                  setTimeError('');
                }}
              >
                {choice.label}
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <label>
            Reminder title
            <input
              ref={titleField}
              value={title}
              maxLength={200}
              aria-invalid={!!titleError}
              aria-describedby={titleError ? 'reminder-title-error' : undefined}
              onChange={(event) => {
                setTitle(event.target.value);
                setTitleError('');
                setMessage('');
              }}
            />
          </label>
          {titleError && (
            <p id="reminder-title-error" className="form-error">
              <span className="visually-hidden">Error: </span>
              {titleError}
            </p>
          )}
        </>
      )}
      <WhenField
        label={snoozing ? 'Snooze until' : 'Remind at'}
        value={when}
        offset={offset}
        zone={zone}
        error={timeError}
        fieldRef={timeField}
        onChange={(value) => {
          setWhen(value);
          setOffset('');
          setTimeError('');
          setMessage('');
        }}
        onOffset={setOffset}
      />
      <Help label="Reminder time">
        Times use this device&apos;s timezone ({zone}).{' '}
        {snoozing
          ? 'Choose a future time within 365 days.'
          : 'A past time is delivered on the worker’s next check.'}
      </Help>
      {!snoozing && (
        <>
          <label>
            Linked item
            <select
              value={target}
              onChange={(event) => {
                setTarget(event.target.value);
                setOccurrence('');
              }}
            >
              <option value="">Standalone reminder</option>
              {reminder?.targetKind === 'academic-work' && (
                <option value={`academic-work:${reminder.targetId}`}>
                  Academic work
                </option>
              )}
              {(tasks.data?.data.tasks ?? [])
                .filter((item) => !item.completed)
                .map((item) => (
                  <option key={item.id} value={`task:${item.id}`}>
                    Task: {item.title}
                  </option>
                ))}
              {(events.data?.data.events ?? [])
                .filter((item) => item.studyStatus === 'planned')
                .map((item) => (
                  <option key={item.id} value={`event:${item.id}`}>
                    Event: {item.title}
                  </option>
                ))}
            </select>
          </label>
          {(tasks.error || events.error) && (
            <p role="alert" className="form-error">
              {tasks.error || events.error}
            </p>
          )}
          {sourceKind === 'event' && (
            <label>
              Original occurrence date (repeating events only)
              <input
                type="date"
                value={occurrence}
                onChange={(event) => setOccurrence(event.target.value)}
              />
            </label>
          )}
        </>
      )}
      {save.error && !changedElsewhere && (
        <p role="alert" className="form-error">
          {save.error}
        </p>
      )}
      <p role="status">{message}</p>
      <div className="form-actions">
        <button
          className="primary-button"
          disabled={save.pending || changedElsewhere}
        >
          {save.pending
            ? 'Saving…'
            : snoozing
              ? 'Snooze'
              : reminder
                ? 'Save reminder changes'
                : 'Add reminder'}
        </button>
        <button type="button" className="secondary-button" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}
