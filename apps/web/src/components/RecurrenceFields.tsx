import { useState } from 'react';
import type { RecurrenceRule } from '@hub/contracts';
import {
  draftFromRule,
  ruleFromDraft,
  summaryOf,
  weekdayChoices,
} from '../lib/recurrence';
import type { RecurrenceDraft } from '../lib/recurrence';
import { Help } from './Help';
import { TimeZoneInput } from './TimeZoneInput';

/**
 * Shared repeat editor for tasks, reminders and events. The parent keeps the
 * validated rule; this component owns text drafts so typing never throws.
 */
export function RecurrenceFields({
  value,
  anchor,
  timeZone,
  disabled = false,
  onChange,
}: {
  value: RecurrenceRule | null;
  anchor: string;
  timeZone: string;
  disabled?: boolean;
  onChange: (value: RecurrenceRule | null) => void;
}) {
  const [draft, setDraft] = useState<RecurrenceDraft>(() =>
    draftFromRule(value, anchor || today(), timeZone),
  );
  const [customError, setCustomError] = useState('');
  const day = anchor || today();
  const update = (next: RecurrenceDraft) => {
    setDraft(next);
    setCustomError('');
    if (next.frequency === 'none') {
      onChange(null);
      return;
    }
    const rule = ruleFromDraft(next, day);
    if (rule) onChange(rule);
    else if (next.frequency === 'custom')
      setCustomError(
        'Use FREQ=DAILY, WEEKLY, MONTHLY or YEARLY with optional INTERVAL, COUNT, UNTIL, BYDAY or BYMONTHDAY.',
      );
  };
  const summary = summaryOf(ruleFromDraft(draft, day), day);
  return (
    <fieldset
      className="calendar-section recurrence-fields"
      disabled={disabled}
    >
      <legend>Repeat</legend>
      <label>
        Repeat
        <select
          value={draft.frequency}
          onChange={(event) =>
            update({
              ...draft,
              frequency: event.target.value as RecurrenceDraft['frequency'],
            })
          }
        >
          <option value="none">Does not repeat</option>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
          <option value="yearly">Yearly</option>
          <option value="custom">Custom RRULE</option>
        </select>
      </label>
      {draft.frequency !== 'none' && draft.frequency !== 'custom' && (
        <>
          <div className="form-row">
            <label>
              Every
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={99}
                value={draft.interval}
                onChange={(event) =>
                  update({ ...draft, interval: event.target.value })
                }
              />
            </label>
            <label>
              Unit
              <output>
                {draft.frequency === 'daily'
                  ? 'days'
                  : draft.frequency === 'weekly'
                    ? 'weeks'
                    : draft.frequency === 'monthly'
                      ? 'months'
                      : 'years'}
              </output>
            </label>
          </div>
          {draft.frequency === 'weekly' && (
            <fieldset>
              <legend>On these days</legend>
              {weekdayChoices.map(([code, label]) => (
                <label key={code} className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={draft.weekdays.includes(code)}
                    onChange={(event) =>
                      update({
                        ...draft,
                        weekdays: event.target.checked
                          ? [...draft.weekdays, code]
                          : draft.weekdays.filter((day) => day !== code),
                      })
                    }
                  />
                  {label}
                </label>
              ))}
            </fieldset>
          )}
          {draft.frequency === 'monthly' && (
            <>
              <label className="checkbox-label">
                <input
                  type="radio"
                  name="monthly-mode"
                  checked={draft.monthlyMode === 'date'}
                  onChange={() => update({ ...draft, monthlyMode: 'date' })}
                />
                On day {draft.monthDay}
              </label>
              <label>
                Day of month
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={31}
                  value={draft.monthDay}
                  disabled={draft.monthlyMode !== 'date'}
                  onChange={(event) =>
                    update({ ...draft, monthDay: event.target.value })
                  }
                />
              </label>
              <label className="checkbox-label">
                <input
                  type="radio"
                  name="monthly-mode"
                  checked={draft.monthlyMode === 'weekday'}
                  onChange={() => update({ ...draft, monthlyMode: 'weekday' })}
                />
                On a weekday pattern
              </label>
              <div className="form-row">
                <label>
                  Position
                  <select
                    value={draft.setPos}
                    disabled={draft.monthlyMode !== 'weekday'}
                    onChange={(event) =>
                      update({ ...draft, setPos: event.target.value })
                    }
                  >
                    <option value="1">First</option>
                    <option value="2">Second</option>
                    <option value="3">Third</option>
                    <option value="4">Fourth</option>
                    <option value="5">Fifth</option>
                    <option value="-1">Last</option>
                  </select>
                </label>
                <label>
                  Weekday
                  <select
                    value={draft.weekdays[0] ?? 'MO'}
                    disabled={draft.monthlyMode !== 'weekday'}
                    onChange={(event) =>
                      update({ ...draft, weekdays: [event.target.value] })
                    }
                  >
                    {weekdayChoices.map(([code, label]) => (
                      <option key={code} value={code}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </>
          )}
          <fieldset>
            <legend>Ends</legend>
            <label className="checkbox-label">
              <input
                type="radio"
                name="repeat-end"
                checked={draft.endMode === 'never'}
                onChange={() => update({ ...draft, endMode: 'never' })}
              />
              Never
            </label>
            <label className="checkbox-label">
              <input
                type="radio"
                name="repeat-end"
                checked={draft.endMode === 'until'}
                onChange={() => update({ ...draft, endMode: 'until' })}
              />
              On date
            </label>
            {draft.endMode === 'until' && (
              <label>
                Repeat until
                <input
                  type="date"
                  value={draft.until}
                  min={day}
                  onChange={(event) =>
                    update({ ...draft, until: event.target.value })
                  }
                />
              </label>
            )}
            <label className="checkbox-label">
              <input
                type="radio"
                name="repeat-end"
                checked={draft.endMode === 'count'}
                onChange={() => update({ ...draft, endMode: 'count' })}
              />
              After
            </label>
            {draft.endMode === 'count' && (
              <label>
                Number of occurrences
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={1000}
                  value={draft.count}
                  onChange={(event) =>
                    update({ ...draft, count: event.target.value })
                  }
                />
              </label>
            )}
          </fieldset>
          <label>
            Timezone
            <TimeZoneInput
              value={draft.timeZone}
              onChange={(event) =>
                update({ ...draft, timeZone: event.target.value })
              }
            />
          </label>
        </>
      )}
      {draft.frequency === 'custom' && (
        <label>
          RRULE
          <input
            value={draft.custom}
            placeholder="FREQ=WEEKLY;BYDAY=MO,WE"
            onChange={(event) =>
              update({ ...draft, custom: event.target.value })
            }
          />
        </label>
      )}
      {customError && (
        <p role="alert" className="form-error">
          {customError}
        </p>
      )}
      {summary && <p role="status">{summary}</p>}
      <Help label="Repeat">
        Repeats keep the local time in the chosen timezone, including daylight
        saving changes. Monthly dates that do not exist are skipped.
      </Help>
    </fieldset>
  );
}

function today() {
  return new Date().toISOString().slice(0, 10);
}
