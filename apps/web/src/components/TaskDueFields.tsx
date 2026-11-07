import { useId } from 'react';
import { checkLocalTime, foldChoices } from '../lib/calendar';
import type { TaskDueDraft } from '../lib/task-deadline';
import { TimeZoneInput } from './TimeZoneInput';
import './TaskDueFields.css';

export function TaskDueFields({
  value,
  onChange,
  disabled = false,
}: {
  value: TaskDueDraft;
  onChange: (value: TaskDueDraft) => void;
  disabled?: boolean;
}) {
  const offsetName = useId();
  const local =
    value.dueDate && value.dueTime ? `${value.dueDate}T${value.dueTime}` : '';
  const check = local ? checkLocalTime(local, value.dueTimeZone) : 'ok';
  const choices =
    check === 'fold' ? foldChoices(local, value.dueTimeZone) : null;
  return (
    <div className="task-due-fields">
      <label>
        Due date (optional)
        <input
          type="date"
          value={value.dueDate}
          disabled={disabled}
          onChange={(event) => {
            const dueDate = event.target.value;
            onChange({
              ...value,
              dueDate,
              dueOffset: '',
              ...(dueDate ? {} : { dueTime: '' }),
            });
          }}
        />
      </label>
      <label>
        Due time (optional)
        <input
          type="time"
          value={value.dueTime}
          disabled={disabled || !value.dueDate}
          onChange={(event) =>
            onChange({ ...value, dueTime: event.target.value, dueOffset: '' })
          }
        />
      </label>
      {value.dueTime && (
        <label>
          Timezone
          <TimeZoneInput
            value={value.dueTimeZone}
            disabled={disabled}
            onChange={(event) =>
              onChange({
                ...value,
                dueTimeZone: event.target.value,
                dueOffset: '',
              })
            }
          />
        </label>
      )}
      {check === 'gap' && (
        <p role="alert" className="form-error">
          This due time does not exist in the selected timezone. Choose another
          time.
        </p>
      )}
      {choices && (
        <fieldset>
          <legend>This due time happens twice. Choose one.</legend>
          <label>
            <input
              type="radio"
              name={offsetName}
              checked={value.dueOffset === 'earlier'}
              disabled={disabled}
              onChange={() => onChange({ ...value, dueOffset: 'earlier' })}
            />
            Earlier ({choices.earlier})
          </label>
          <label>
            <input
              type="radio"
              name={offsetName}
              checked={value.dueOffset === 'later'}
              disabled={disabled}
              onChange={() => onChange({ ...value, dueOffset: 'later' })}
            />
            Later ({choices.later})
          </label>
        </fieldset>
      )}
    </div>
  );
}
