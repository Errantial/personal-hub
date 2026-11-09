import {
  Temporal,
  parseRRule,
  recurrenceSchema,
  recurrenceSummary,
  toRRule,
} from '@hub/contracts';
import type { RecurrenceRule } from '@hub/contracts';

export type RecurrenceFrequency =
  'none' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'custom';
export type RecurrenceDraft = {
  frequency: RecurrenceFrequency;
  interval: string;
  weekdays: string[];
  monthlyMode: 'date' | 'weekday';
  monthDay: string;
  setPos: string;
  endMode: 'never' | 'until' | 'count';
  until: string;
  count: string;
  timeZone: string;
  custom: string;
};

export const weekdayChoices = [
  ['MO', 'Mon'],
  ['TU', 'Tue'],
  ['WE', 'Wed'],
  ['TH', 'Thu'],
  ['FR', 'Fri'],
  ['SA', 'Sat'],
  ['SU', 'Sun'],
] as const;

export function weekdayOf(date: string) {
  return weekdayChoices[Temporal.PlainDate.from(date).dayOfWeek - 1]![0];
}

export function draftFromRule(
  rule: RecurrenceRule | null | undefined,
  anchor: string,
  timeZone: string,
): RecurrenceDraft {
  return {
    frequency: rule?.frequency ?? 'none',
    interval: String(rule?.interval ?? 1),
    weekdays: rule?.byDay ?? [weekdayOf(anchor)],
    monthlyMode: rule?.monthlyMode ?? 'date',
    monthDay: String(rule?.byMonthDay ?? Temporal.PlainDate.from(anchor).day),
    setPos: String(rule?.bySetPos ?? 1),
    endMode: rule?.until ? 'until' : rule?.count ? 'count' : 'never',
    until: rule?.until ?? '',
    count: rule?.count ? String(rule.count) : '',
    timeZone: rule?.timeZone ?? timeZone,
    custom: rule ? toRRule(rule) : '',
  };
}

/** Builds a validated rule from the editor draft, or null when incomplete. */
export function ruleFromDraft(
  draft: RecurrenceDraft,
  anchor: string,
): RecurrenceRule | null {
  if (draft.frequency === 'none') return null;
  if (draft.frequency === 'custom') {
    try {
      return parseRRule(draft.custom, draft.timeZone);
    } catch {
      return null;
    }
  }
  const interval = Number(draft.interval);
  if (!Number.isInteger(interval) || interval < 1 || interval > 99) return null;
  const count = draft.endMode === 'count' ? Number(draft.count) : null;
  if (count !== null && (!Number.isInteger(count) || count < 1)) return null;
  const until = draft.endMode === 'until' ? draft.until : null;
  if (draft.endMode === 'until' && !until) return null;
  const byDay =
    draft.frequency === 'weekly'
      ? draft.weekdays.length
        ? draft.weekdays
        : [weekdayOf(anchor)]
      : draft.frequency === 'monthly' && draft.monthlyMode === 'weekday'
        ? [draft.weekdays[0] ?? weekdayOf(anchor)]
        : null;
  const byMonthDay =
    draft.frequency === 'monthly' && draft.monthlyMode === 'date'
      ? Number(draft.monthDay)
      : null;
  if (
    byMonthDay !== null &&
    (!Number.isInteger(byMonthDay) || byMonthDay < 1 || byMonthDay > 31)
  )
    return null;
  const bySetPos =
    draft.frequency === 'monthly' && draft.monthlyMode === 'weekday'
      ? Number(draft.setPos)
      : null;
  const parsed = recurrenceSchema.safeParse({
    frequency: draft.frequency,
    interval,
    count,
    until,
    byDay,
    monthlyMode: draft.frequency === 'monthly' ? draft.monthlyMode : null,
    byMonthDay,
    bySetPos,
    timeZone: draft.timeZone,
  });
  return parsed.success ? (parsed.data as RecurrenceRule) : null;
}

export function summaryOf(
  rule: RecurrenceRule | null | undefined,
  anchor: string,
) {
  return rule ? recurrenceSummary(rule, anchor) : '';
}
