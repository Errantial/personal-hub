import { useEffect, useState } from 'react';
import { Temporal } from '@hub/contracts';

const fullDate = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});
const monthTitle = new Intl.DateTimeFormat(undefined, {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});
const weekdayLong = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  timeZone: 'UTC',
});
const weekdayInitial = new Intl.DateTimeFormat(undefined, {
  weekday: 'narrow',
  timeZone: 'UTC',
});
// Plain dates are formatted at UTC noon so they never shift a day.
const asDate = (day: Temporal.PlainDate) => new Date(`${day}T12:00:00Z`);

/** A small month for jumping to a date. Its month follows `date` and can be
 *  paged without moving the calendar. */
export function MiniMonth({
  date,
  today,
  onPick,
}: {
  date: string;
  today: string;
  onPick: (date: string) => void;
}) {
  const [month, setMonth] = useState(() =>
    Temporal.PlainDate.from(date).with({ day: 1 }),
  );
  useEffect(
    () => setMonth(Temporal.PlainDate.from(date).with({ day: 1 })),
    [date],
  );
  const first = month.subtract({ days: month.dayOfWeek - 1 });
  const weeks = Array.from({ length: 6 }, (_, week) =>
    Array.from({ length: 7 }, (_, day) => first.add({ days: week * 7 + day })),
  );
  return (
    <div className="mini-month">
      <div className="mini-month__head">
        <button
          type="button"
          className="mini-month__step"
          aria-label="Previous month"
          onClick={() => setMonth(month.subtract({ months: 1 }))}
        >
          ‹
        </button>
        <span className="mini-month__title" aria-live="polite">
          {monthTitle.format(asDate(month))}
        </span>
        <button
          type="button"
          className="mini-month__step"
          aria-label="Next month"
          onClick={() => setMonth(month.add({ months: 1 }))}
        >
          ›
        </button>
      </div>
      <table className="mini-month__grid">
        <thead>
          <tr>
            {weeks[0]!.map((day) => (
              <th
                key={day.dayOfWeek}
                scope="col"
                aria-label={weekdayLong.format(asDate(day))}
              >
                {weekdayInitial.format(asDate(day))}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week[0]!.toString()}>
              {week.map((day) => {
                const value = day.toString();
                return (
                  <td key={value}>
                    <button
                      type="button"
                      aria-label={fullDate.format(asDate(day))}
                      aria-pressed={value === date}
                      aria-current={value === today ? 'date' : undefined}
                      className={
                        day.month === month.month ? '' : 'mini-month__other'
                      }
                      onClick={() => onPick(value)}
                    >
                      {day.day}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
