const presets = [
  { minutes: 1440, label: '1 day before' },
  { minutes: 60, label: '1 hour before' },
  { minutes: 10, label: '10 minutes before' },
] as const;

/** Multiple reminder times for a task or event, stored as minutes before. */
export function ReminderOffsetsFields({
  value,
  disabled = false,
  onChange,
}: {
  value: number[];
  disabled?: boolean;
  onChange: (value: number[]) => void;
}) {
  const extra = value.filter(
    (minutes) => !presets.some((preset) => preset.minutes === minutes),
  );
  return (
    <fieldset className="calendar-section" disabled={disabled}>
      <legend>Remind me</legend>
      {presets.map((preset) => (
        <label key={preset.minutes} className="checkbox-label">
          <input
            type="checkbox"
            checked={value.includes(preset.minutes)}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...value, preset.minutes].sort((a, b) => b - a)
                  : value.filter((minutes) => minutes !== preset.minutes),
              )
            }
          />
          {preset.label}
        </label>
      ))}
      {extra.length > 0 && (
        <p className="hint">Also {extra.join(', ')} minutes before.</p>
      )}
      <p className="hint">
        Offsets apply to the task due time or event start, and to each repeating
        occurrence.
      </p>
    </fieldset>
  );
}
