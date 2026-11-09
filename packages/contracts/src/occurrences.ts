import { Temporal } from '@js-temporal/polyfill';
import { recurrenceSchema } from './features.js';
import type { CalendarRecord, EventException, Occurrence } from './features.js';

export type RecurrenceRule = NonNullable<CalendarRecord['recurrence']>;
const weekdayCodes = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
const weekdayNames = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;
const monthNames = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

function ordinal(value: number) {
  const mod100 = value % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${value}th`;
  return `${value}${value % 10 === 1 ? 'st' : value % 10 === 2 ? 'nd' : value % 10 === 3 ? 'rd' : 'th'}`;
}

function weekdayOf(date: Temporal.PlainDate) {
  return weekdayCodes[date.dayOfWeek - 1]!;
}

function nthWeekdayOfMonth(
  month: Temporal.PlainDate,
  weekday: (typeof weekdayCodes)[number],
  position: number,
) {
  const first = month.with({ day: 1 });
  const target = weekdayCodes.indexOf(weekday) + 1;
  if (position < 0) {
    const last = month.with({ day: month.daysInMonth });
    const lastWeekday = last.subtract({
      days: (last.dayOfWeek - target + 7) % 7,
    });
    const candidate = lastWeekday.add({ weeks: position + 1 });
    return candidate.month === month.month ? candidate : null;
  }
  const date = first.add({ days: (target - first.dayOfWeek + 7) % 7 });
  const candidate = date.add({ days: (position - 1) * 7 });
  return candidate.month === month.month ? candidate : null;
}

/**
 * Expands one RRULE-style rule from its anchor date. Dates are inclusive of
 * `from` and `to`; count/until bound the whole series, not the window.
 */
export function recurrenceDates(
  rule: RecurrenceRule,
  anchor: Temporal.PlainDate,
  from: Temporal.PlainDate,
  to: Temporal.PlainDate,
): Temporal.PlainDate[] {
  const result: Temporal.PlainDate[] = [];
  const lower = Temporal.PlainDate.compare(from, anchor) < 0 ? anchor : from;
  let generated = 0;
  let index = 0;
  let skipped = false;
  const add = (date: Temporal.PlainDate) => {
    generated++;
    if (Temporal.PlainDate.compare(date, lower) >= 0) result.push(date);
  };
  const done = (date: Temporal.PlainDate) =>
    Temporal.PlainDate.compare(date, to) > 0 ||
    (rule.until !== null && date.toString() > rule.until) ||
    (rule.count !== null && generated >= rule.count);
  if (rule.frequency === 'daily') {
    if (rule.count === null)
      index = Math.max(
        0,
        Math.floor(anchor.until(lower).days / rule.interval) - 1,
      );
    for (let steps = 0; steps < 200000; steps++, index++) {
      const date = anchor.add({ days: index * rule.interval });
      if (done(date)) break;
      add(date);
      if (rule.count !== null && generated >= rule.count) break;
    }
  } else if (rule.frequency === 'weekly') {
    const weekStart = anchor.subtract({ days: anchor.dayOfWeek - 1 });
    const days = (rule.byDay ?? [weekdayOf(anchor)])
      .map((day) => weekdayCodes.indexOf(day) + 1)
      .sort((a, b) => a - b);
    if (rule.count === null)
      index = Math.max(
        0,
        Math.floor(anchor.until(lower).days / 7 / rule.interval) - 1,
      );
    for (let steps = 0; steps < 200000; steps++, index++) {
      const week = weekStart.add({ weeks: index * rule.interval });
      for (const day of days) {
        const date = week.add({ days: day - 1 });
        if (Temporal.PlainDate.compare(date, anchor) < 0) continue;
        if (done(date)) {
          skipped = true;
          break;
        }
        add(date);
        if (rule.count !== null && generated >= rule.count) {
          skipped = true;
          break;
        }
      }
      if (skipped) break;
    }
  } else if (rule.frequency === 'monthly') {
    const monthStart = anchor.with({ day: 1 });
    if (rule.count === null)
      index = Math.max(
        0,
        Math.floor(
          (lower.year - anchor.year) * 12 + lower.month - anchor.month,
        ) /
          rule.interval -
          1,
      );
    for (let steps = 0; steps < 200000; steps++, index++) {
      const month = monthStart.add({ months: index * rule.interval });
      if (month.day !== 1) break;
      let date: Temporal.PlainDate | null = null;
      if (rule.monthlyMode === 'weekday' && rule.byDay?.[0])
        date = nthWeekdayOfMonth(month, rule.byDay[0], rule.bySetPos ?? 1);
      else {
        const day = rule.byMonthDay ?? anchor.day;
        if (day <= month.daysInMonth) date = month.with({ day });
      }
      if (!date) {
        if (
          Temporal.PlainDate.compare(month, to) > 0 ||
          (rule.until !== null && month.toString() > rule.until)
        )
          break;
        continue;
      }
      if (done(date)) break;
      add(date);
      if (rule.count !== null && generated >= rule.count) break;
    }
  } else {
    if (rule.count === null)
      index = Math.max(
        0,
        Math.floor((lower.year - anchor.year) / rule.interval) - 1,
      );
    for (let steps = 0; steps < 200000; steps++, index++) {
      const year = anchor.year + index * rule.interval;
      if (year > 9999) break;
      const day = rule.byMonthDay ?? anchor.day;
      let date: Temporal.PlainDate;
      try {
        date = Temporal.PlainDate.from({
          year,
          month: anchor.month,
          day,
        });
      } catch {
        continue;
      }
      if (date.month !== anchor.month || date.day !== day) continue;
      if (done(date)) break;
      add(date);
      if (rule.count !== null && generated >= rule.count) break;
    }
  }
  return result;
}

/** The first occurrence strictly after `after`, or null when the series ends. */
export function nextOccurrenceDate(
  rule: RecurrenceRule,
  anchor: Temporal.PlainDate,
  after: Temporal.PlainDate,
) {
  const from = after.add({ days: 1 });
  return (
    recurrenceDates(rule, anchor, from, from.add({ years: 60 }))[0] ?? null
  );
}

/** One-line summary for pickers and lists. */
export function recurrenceSummary(rule: RecurrenceRule, anchor?: string) {
  const anchorDate = anchor ? Temporal.PlainDate.from(anchor) : null;
  const every =
    rule.interval === 1
      ? ''
      : rule.frequency === 'daily'
        ? `Every ${rule.interval} days`
        : rule.frequency === 'weekly'
          ? `Every ${rule.interval} weeks`
          : rule.frequency === 'monthly'
            ? `Every ${rule.interval} months`
            : `Every ${rule.interval} years`;
  const weekdayList = (values: string[]) =>
    values
      .map((day) => weekdayNames[weekdayCodes.indexOf(day as never)])
      .join(', ');
  let text: string;
  if (rule.frequency === 'daily') text = every || 'Daily';
  else if (rule.frequency === 'weekly')
    text = `${every || 'Weekly'}${
      rule.byDay?.length ? ` on ${weekdayList(rule.byDay)}` : ''
    }`;
  else if (rule.frequency === 'monthly') {
    if (rule.monthlyMode === 'weekday' && rule.byDay?.[0]) {
      const position =
        rule.bySetPos === -1 ? 'last' : `${ordinal(rule.bySetPos ?? 1)}`;
      text = `${every || 'Monthly'} on the ${position} ${weekdayNames[weekdayCodes.indexOf(rule.byDay[0])]}`;
    } else {
      const day = rule.byMonthDay ?? anchorDate?.day ?? 1;
      text = `${every || 'Monthly'} on the ${ordinal(day)}`;
    }
  } else {
    const month =
      anchorDate !== null ? `${monthNames[anchorDate.month - 1]} ` : '';
    const day = rule.byMonthDay ?? anchorDate?.day;
    text = `${every || 'Yearly'}${day ? ` on ${month}${day}` : ''}`;
  }
  if (rule.until) text += `, until ${rule.until}`;
  else if (rule.count) text += `, ${rule.count} occurrences`;
  return text;
}

/** Parses a custom RFC 5545 RRULE subset into the structured rule. */
export function parseRRule(text: string, timeZone = 'America/Denver') {
  const parts = new Map<string, string>();
  for (const part of text.replace(/^RRULE:/i, '').split(';')) {
    const [key, value] = part.split('=');
    if (!key || value === undefined || parts.has(key.toUpperCase()))
      throw new Error('This repeat rule is not valid.');
    parts.set(key.toUpperCase(), value);
  }
  const frequency = {
    DAILY: 'daily',
    WEEKLY: 'weekly',
    MONTHLY: 'monthly',
    YEARLY: 'yearly',
  }[parts.get('FREQ') ?? ''] as RecurrenceRule['frequency'] | undefined;
  if (!frequency) throw new Error('Use FREQ=DAILY, WEEKLY, MONTHLY or YEARLY.');
  const interval = Number(parts.get('INTERVAL') ?? 1);
  const count = parts.has('COUNT') ? Number(parts.get('COUNT')) : null;
  const untilText = parts.get('UNTIL');
  const until = untilText
    ? untilText.includes('-')
      ? untilText
      : `${untilText.slice(0, 4)}-${untilText.slice(4, 6)}-${untilText.slice(6, 8)}`
    : null;
  let byDay: RecurrenceRule['byDay'] = null;
  let bySetPos: number | null = null;
  let monthlyMode: RecurrenceRule['monthlyMode'] = null;
  const byDayText = parts.get('BYDAY');
  if (byDayText) {
    const parsed = byDayText.split(',').map((value) => {
      const match = /^([+-]?\d)?(MO|TU|WE|TH|FR|SA|SU)$/.exec(value);
      if (!match) throw new Error('This weekday list is not valid.');
      return { position: match[1] ? Number(match[1]) : null, day: match[2]! };
    });
    byDay = parsed.map((value) => value.day as (typeof weekdayCodes)[number]);
    if (frequency === 'monthly') {
      if (parsed.length !== 1 || parsed[0]!.position === null)
        throw new Error('Use one numbered weekday for a monthly pattern.');
      monthlyMode = 'weekday';
      bySetPos = parsed[0]!.position;
    } else if (parsed.some((value) => value.position !== null))
      throw new Error('Numbered weekdays apply to monthly repeats.');
  }
  const byMonthDay = parts.has('BYMONTHDAY')
    ? Number(parts.get('BYMONTHDAY'))
    : null;
  for (const key of parts.keys())
    if (
      ![
        'FREQ',
        'INTERVAL',
        'COUNT',
        'UNTIL',
        'BYDAY',
        'BYMONTHDAY',
        'BYSETPOS',
      ].includes(key)
    )
      throw new Error(`Unsupported repeat rule ${key}.`);
  if (parts.has('BYSETPOS')) {
    if (frequency !== 'monthly')
      throw new Error('BYSETPOS applies to monthly repeats.');
    bySetPos = Number(parts.get('BYSETPOS'));
  }
  if (monthlyMode === 'weekday' && bySetPos === null)
    bySetPos = Number(parts.get('BYSETPOS') ?? 1);
  return recurrenceSchema.parse({
    frequency,
    interval,
    count,
    until,
    byDay,
    monthlyMode,
    byMonthDay,
    bySetPos,
    timeZone,
  });
}

/** Canonical RRULE text for a structured rule. */
export function toRRule(rule: RecurrenceRule) {
  const parts = [`FREQ=${rule.frequency.toUpperCase()}`];
  if (rule.interval !== 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.count !== null) parts.push(`COUNT=${rule.count}`);
  if (rule.until !== null)
    parts.push(`UNTIL=${rule.until.replaceAll('-', '')}`);
  if (rule.monthlyMode === 'weekday' && rule.byDay?.[0])
    parts.push(`BYDAY=${rule.bySetPos ?? 1}${rule.byDay[0]}`);
  else if (rule.byDay?.length) parts.push(`BYDAY=${rule.byDay.join(',')}`);
  if (rule.monthlyMode !== 'weekday' && rule.byMonthDay !== null)
    parts.push(`BYMONTHDAY=${rule.byMonthDay}`);
  return parts.join(';');
}

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
    for (const date of recurrenceDates(rule, anchor, lower, upper)) add(date);
  }
  // Moved occurrences may enter a window from a distant original date.
  for (const exception of exceptions)
    if (exception.replacement)
      add(Temporal.PlainDate.from(exception.originalDate));
  return [...result.values()].sort((a, b) =>
    a.startsAt.localeCompare(b.startsAt),
  );
}
