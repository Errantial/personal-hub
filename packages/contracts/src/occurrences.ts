import { Temporal } from '@js-temporal/polyfill';
import type { CalendarRecord, EventException, Occurrence } from './features.js';

export function expandEvent(
  event: CalendarRecord,
  from: string,
  to: string,
  viewZone: string,
  exceptions: EventException[] = [],
): Occurrence[] {
  const start = Temporal.Instant.from(event.startsAt).toZonedDateTimeISO(
    event.timeZone,
  );
  const anchor = Temporal.PlainDate.from(
    event.allDay ? event.startDate! : start.toPlainDate(),
  );
  const rangeStart = Temporal.PlainDate.from(from)
    .toZonedDateTime(viewZone)
    .toInstant();
  const rangeEnd = Temporal.PlainDate.from(to)
    .toZonedDateTime(viewZone)
    .toInstant();
  const duration =
    Temporal.Instant.from(event.endsAt).epochMilliseconds -
    Temporal.Instant.from(event.startsAt).epochMilliseconds;
  const days = event.allDay
    ? anchor.until(Temporal.PlainDate.from(event.endDate!)).days
    : Math.ceil(duration / 86400000);
  const byDate = new Map(
    exceptions.map((value) => [value.originalDate, value]),
  );
  const result = new Map<string, Occurrence>();
  function add(date: Temporal.PlainDate) {
    const key = date.toString();
    const exception = byDate.get(key);
    if (exception?.cancelled) return;
    let values: CalendarRecord;
    if (exception?.replacement)
      values = {
        ...event,
        ...exception.replacement,
        recurrence: event.recurrence,
      };
    else if (event.allDay)
      values = {
        ...event,
        startDate: key,
        endDate: date.add({ days }).toString(),
        startsAt: `${key}T00:00:00.000Z`,
        endsAt: `${date.add({ days }).toString()}T00:00:00.000Z`,
      };
    else {
      // Keep wall-clock start; future DST gaps move forward, folds choose earlier.
      const startsAt = date.equals(anchor)
        ? Temporal.Instant.from(event.startsAt)
        : date
            .toPlainDateTime(start.toPlainTime())
            .toZonedDateTime(event.timeZone, { disambiguation: 'compatible' })
            .toInstant();
      values = {
        ...event,
        startsAt: startsAt.toString({ smallestUnit: 'millisecond' }),
        endsAt: startsAt
          .add({ milliseconds: duration })
          .toString({ smallestUnit: 'millisecond' }),
      };
    }
    values.sensitivity = (['unlabeled', 'personal', 'restricted'] as const)[
      Math.max(
        ['unlabeled', 'personal', 'restricted'].indexOf(event.sensitivity),
        ['unlabeled', 'personal', 'restricted'].indexOf(values.sensitivity),
      )
    ]!;
    const overlap = values.allDay
      ? values.startDate! < to && values.endDate! > from
      : Temporal.Instant.compare(
          Temporal.Instant.from(values.startsAt),
          rangeEnd,
        ) < 0 &&
        Temporal.Instant.compare(
          Temporal.Instant.from(values.endsAt),
          rangeStart,
        ) > 0;
    if (overlap)
      result.set(key, {
        ...values,
        originalDate: key,
        occurrenceId: `${event.id}:${key}`,
        overridden: Boolean(exception?.replacement),
      });
  }
  const rule = event.recurrence;
  if (!rule) add(anchor);
  else {
    const lower = Temporal.PlainDate.from(from).subtract({ days: days + 2 });
    const upper = Temporal.PlainDate.from(to).add({ days: 2 });
    const diff =
      rule.frequency === 'monthly'
        ? (lower.year - anchor.year) * 12 + lower.month - anchor.month
        : anchor.until(lower).days / (rule.frequency === 'weekly' ? 7 : 1);
    let index = rule.count
      ? 0
      : Math.max(0, Math.floor(diff / rule.interval) - 1);
    let generated = 0;
    for (let steps = 0; steps < 12000; steps++, index++) {
      let date: Temporal.PlainDate;
      if (rule.frequency === 'monthly') {
        const month = anchor
          .with({ day: 1 })
          .add({ months: index * rule.interval });
        if (month.day !== 1) break;
        if (anchor.day > month.daysInMonth) {
          if (Temporal.PlainDate.compare(month, upper) > 0) break;
          continue;
        }
        date = month.with({ day: anchor.day });
      } else
        date = anchor.add({
          days: index * rule.interval * (rule.frequency === 'weekly' ? 7 : 1),
        });
      if (
        Temporal.PlainDate.compare(date, upper) >= 0 ||
        (rule.until && date.toString() > rule.until) ||
        (rule.count && generated >= rule.count)
      )
        break;
      generated++;
      if (Temporal.PlainDate.compare(date, lower) >= 0) add(date);
    }
  }
  // Moved occurrences may enter a window from a distant original date.
  for (const exception of exceptions)
    if (exception.replacement)
      add(Temporal.PlainDate.from(exception.originalDate));
  return [...result.values()].sort((a, b) =>
    a.startsAt.localeCompare(b.startsAt),
  );
}
