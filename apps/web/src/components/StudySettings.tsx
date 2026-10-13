import { useState } from 'react';
import type { FormEvent } from 'react';
import { studyPreferencesSchema, zone as zoneSchema } from '@hub/contracts';
import type { StudyPreferences } from '@hub/contracts';
import { getJson } from '../lib/api';
import { minutesLabel } from '../lib/classes';
import { useMutation, useResource } from '../lib/hooks';
import { weekdays, weeklyMinutes, windowDrafts, windowsOf } from '../lib/study';
import type { WindowDraft } from '../lib/study';
import { ChangedElsewhere } from './ClassForms';
import { Help } from './Help';
import { ReadState } from './ReadState';
import { TimeZoneInput } from './TimeZoneInput';

/** Settings › Study: when and how long the study planner may schedule. */
export function StudySettings() {
  const preferences = useResource(
    async (signal) => ({
      data: await getJson(
        '/api/v1/study/preferences',
        studyPreferencesSchema,
        signal,
      ),
      cachedAt: null,
    }),
    { failure: 'Study settings need a connection. Retry.' },
  );
  const loaded = preferences.data?.data;
  return (
    <section
      className="panel preference-panel study-settings"
      aria-labelledby="study-settings-title"
    >
      <h2 id="study-settings-title">Study</h2>
      <Help label="Study settings">
        The study planner only suggests blocks inside these windows, separated
        by breaks and within the daily limit. It checks your planner calendar,
        not external calendars. Nothing is scheduled until you approve a plan.
      </Help>
      <ReadState resource={preferences} label="study settings" />
      {loaded && (
        // Mounted once: a reload adopts versions without replacing edits.
        <StudyForm
          saved={loaded}
          reload={async () => (await preferences.reload())?.data}
        />
      )}
    </section>
  );
}

type Draft = {
  timeZone: string;
  sessionMinutes: string;
  breakMinutes: string;
  dailyMaximumMinutes: string;
  windows: WindowDraft[];
};
const toDraft = (saved: StudyPreferences): Draft => ({
  timeZone: saved.timeZone,
  sessionMinutes: String(saved.sessionMinutes),
  breakMinutes: String(saved.breakMinutes),
  dailyMaximumMinutes: String(saved.dailyMaximumMinutes),
  windows: windowDrafts(saved.windows),
});
const whole = (value: string, min: number, max: number) => {
  const number = Number(value);
  return value.trim() &&
    Number.isInteger(number) &&
    number >= min &&
    number <= max
    ? number
    : null;
};

function StudyForm({
  saved,
  reload,
}: {
  saved: StudyPreferences;
  reload: () => Promise<StudyPreferences | undefined>;
}) {
  const [draft, setDraft] = useState(() => toDraft(saved));
  const [base, setBase] = useState(saved.version);
  const [error, setError] = useState<{ field: string; message: string } | null>(
    null,
  );
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const save = useMutation();
  const update = (changes: Partial<Draft>) => {
    setDraft({ ...draft, ...changes });
    setError(null);
    setMessage('');
  };
  const setWindow = (index: number, changes: Partial<WindowDraft>) =>
    update({
      windows: draft.windows.map((row, i) =>
        i === index ? { ...row, ...changes } : row,
      ),
    });
  const describedBy = (field: string) =>
    error?.field === field ? 'study-settings-error' : undefined;

  async function loadLatest() {
    setLoading(true);
    const fresh = await reload();
    setLoading(false);
    if (!fresh) return;
    setBase(fresh.version);
    save.reset();
    setMessage('Latest version loaded. Your edits are kept.');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (save.conflict) return;
    if (!zoneSchema.safeParse(draft.timeZone).success)
      return setError({
        field: 'zone',
        message: 'Enter a supported IANA timezone',
      });
    const sessionMinutes = whole(draft.sessionMinutes, 10, 180);
    if (sessionMinutes === null)
      return setError({
        field: 'session',
        message: 'Session length: whole minutes from 10 to 180',
      });
    const breakMinutes = whole(draft.breakMinutes, 0, 60);
    if (breakMinutes === null)
      return setError({
        field: 'break',
        message: 'Break: whole minutes from 0 to 60',
      });
    const dailyMaximumMinutes = whole(draft.dailyMaximumMinutes, 10, 480);
    if (dailyMaximumMinutes === null || dailyMaximumMinutes < sessionMinutes)
      return setError({
        field: 'daily',
        message:
          'Daily limit: whole minutes from 10 to 480, at least one session',
      });
    const windows = windowsOf(draft.windows);
    if ('error' in windows)
      return setError({
        field: `window-${windows.index}`,
        message: `${weekdays[draft.windows[windows.index]!.day - 1]} window: ${windows.error}`,
      });
    const result = await save.run(
      studyPreferencesSchema,
      'PUT',
      '/api/v1/study/preferences',
      {
        timeZone: draft.timeZone,
        sessionMinutes,
        breakMinutes,
        dailyMaximumMinutes,
        windows: windows.windows,
        expectedVersion: base,
      },
    );
    if (!result) return;
    setBase(result.version);
    setDraft(toDraft(result));
    setMessage('Study settings saved.');
  }

  const parsed = windowsOf(draft.windows);
  return (
    <form
      className="editor-form"
      noValidate
      aria-label="Study settings"
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      {save.conflict && (
        <ChangedElsewhere
          loading={loading}
          onLoad={() => {
            void loadLatest();
          }}
        />
      )}
      <label>
        Study timezone
        <TimeZoneInput
          value={draft.timeZone}
          aria-invalid={error?.field === 'zone'}
          aria-describedby={describedBy('zone')}
          onChange={(event) => update({ timeZone: event.target.value })}
        />
      </label>
      <div className="form-row">
        <label>
          Session (minutes)
          <input
            type="number"
            inputMode="numeric"
            min={10}
            max={180}
            value={draft.sessionMinutes}
            aria-invalid={error?.field === 'session'}
            aria-describedby={describedBy('session')}
            onChange={(event) => update({ sessionMinutes: event.target.value })}
          />
        </label>
        <label>
          Break (minutes)
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={60}
            value={draft.breakMinutes}
            aria-invalid={error?.field === 'break'}
            aria-describedby={describedBy('break')}
            onChange={(event) => update({ breakMinutes: event.target.value })}
          />
        </label>
        <label>
          Daily limit (minutes)
          <input
            type="number"
            inputMode="numeric"
            min={10}
            max={480}
            value={draft.dailyMaximumMinutes}
            aria-invalid={error?.field === 'daily'}
            aria-describedby={describedBy('daily')}
            onChange={(event) =>
              update({ dailyMaximumMinutes: event.target.value })
            }
          />
        </label>
      </div>
      <fieldset className="study-windows">
        <legend>Weekly availability</legend>
        <Help label="Weekly availability">
          Times are in the study timezone. An end of 00:00 means midnight at the
          end of that day. Windows on the same day cannot overlap.
        </Help>
        {draft.windows.length === 0 && (
          <p>No windows yet, so the planner cannot suggest any study time.</p>
        )}
        <ul className="study-windows__list">
          {draft.windows.map((row, index) => {
            const name = `Window ${index + 1}`;
            const invalid = error?.field === `window-${index}`;
            return (
              <li key={index} className="study-windows__row">
                <label>
                  {name} day
                  <select
                    value={row.day}
                    aria-invalid={invalid}
                    aria-describedby={describedBy(`window-${index}`)}
                    onChange={(event) =>
                      setWindow(index, { day: Number(event.target.value) })
                    }
                  >
                    {weekdays.map((day, i) => (
                      <option key={day} value={i + 1}>
                        {day}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {name} start
                  <input
                    type="time"
                    step={300}
                    value={row.start}
                    aria-invalid={invalid}
                    aria-describedby={describedBy(`window-${index}`)}
                    onChange={(event) =>
                      setWindow(index, { start: event.target.value })
                    }
                  />
                </label>
                <label>
                  {name} end
                  <input
                    type="time"
                    step={300}
                    value={row.end}
                    aria-invalid={invalid}
                    aria-describedby={describedBy(`window-${index}`)}
                    onChange={(event) =>
                      setWindow(index, { end: event.target.value })
                    }
                  />
                </label>
                <button
                  type="button"
                  className="secondary-button"
                  aria-label={`Remove ${name.toLowerCase()}`}
                  onClick={() =>
                    update({
                      windows: draft.windows.filter((_, i) => i !== index),
                    })
                  }
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
        <button
          type="button"
          className="secondary-button"
          disabled={draft.windows.length >= 28}
          onClick={() =>
            update({
              windows: [
                ...draft.windows,
                {
                  day: draft.windows.at(-1)?.day ?? 1,
                  start: '18:00',
                  end: '20:00',
                },
              ],
            })
          }
        >
          Add window
        </button>
        {'windows' in parsed && (
          <p className="meta">
            {minutesLabel(weeklyMinutes(parsed.windows))} available each week
          </p>
        )}
      </fieldset>
      {error && (
        <p id="study-settings-error" className="form-error">
          <span className="visually-hidden">Error: </span>
          {error.message}
        </p>
      )}
      {save.error && !save.conflict && (
        <p role="alert" className="form-error">
          {save.error}
        </p>
      )}
      <p role="status">{message}</p>
      <div className="form-actions">
        <button
          className="primary-button"
          disabled={save.pending || save.conflict}
        >
          {save.pending ? 'Saving…' : 'Save study settings'}
        </button>
      </div>
    </form>
  );
}
