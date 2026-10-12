import type { Task } from '@hub/contracts';

export const contextLabels = ['unlabeled', 'personal', 'restricted'] as const;
export type ContextLabel = (typeof contextLabels)[number];
export type Context = { text: string; label: ContextLabel; taskId: string };

const labelText: Record<ContextLabel, string> = {
  unlabeled: 'Unlabeled',
  personal: 'Personal',
  restricted: 'Restricted',
};

/**
 * Text, label and optional task for an AI routing preview or request check.
 * Both forms use it, so their wording and limits stay identical; `names`
 * carries each form's field labels.
 */
export function AIContextPicker({
  value,
  onChange,
  tasks,
  disabled,
  names,
}: {
  value: Context;
  onChange: (value: Context) => void;
  tasks: Task[];
  disabled: boolean;
  names: { text: string; label: string; task: string };
}) {
  return (
    <>
      <label>
        {names.text}
        <textarea
          required
          maxLength={12000}
          rows={2}
          value={value.text}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, text: event.target.value })}
        />
      </label>
      <label>
        {names.label}
        <select
          value={value.label}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...value, label: event.target.value as ContextLabel })
          }
        >
          {contextLabels.map((label) => (
            <option key={label} value={label}>
              {labelText[label]}
            </option>
          ))}
        </select>
      </label>
      <label>
        {names.task}
        <select
          value={value.taskId}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...value, taskId: event.target.value })
          }
        >
          <option value="">No task</option>
          {tasks.map((task) => (
            <option key={task.id} value={task.id}>
              {task.title}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}
