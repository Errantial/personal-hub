import { describe, expect, it } from 'vitest';
import {
  Temporal,
  nextOccurrenceDate,
  parseRRule,
  recurrenceDates,
  recurrenceSchema,
  recurrenceSummary,
  toRRule,
} from '@hub/contracts';
import type { RecurrenceRule } from '@hub/contracts';

const rule = (value: Record<string, unknown>): RecurrenceRule =>
  recurrenceSchema.parse({
    frequency: 'daily',
    interval: 1,
    count: null,
    until: null,
    ...value,
  }) as RecurrenceRule;
const range = (
  value: RecurrenceRule,
  anchor: string,
  from: string,
  to: string,
) =>
  recurrenceDates(
    value,
    Temporal.PlainDate.from(anchor),
    Temporal.PlainDate.from(from),
    Temporal.PlainDate.from(to),
  ).map((date) => date.toString());

describe('RRULE-style recurrence', () => {
  it('expands chosen weekdays and keeps wall dates across DST', () => {
    const weekly = rule({
      frequency: 'weekly',
      byDay: ['MO', 'WE'],
      count: 6,
      timeZone: 'America/Denver',
    });
    expect(range(weekly, '2027-03-01', '2027-03-01', '2027-03-31')).toEqual([
      '2027-03-01',
      '2027-03-03',
      '2027-03-08',
      '2027-03-10',
      '2027-03-15',
      '2027-03-17',
    ]);
    expect(
      nextOccurrenceDate(
        weekly,
        Temporal.PlainDate.from('2027-03-01'),
        Temporal.PlainDate.from('2027-03-17'),
      )?.toString(),
    ).toBeUndefined();
    const fall = rule({
      frequency: 'weekly',
      byDay: ['SU'],
      count: 4,
      timeZone: 'America/Denver',
    });
    expect(range(fall, '2027-10-24', '2027-10-24', '2027-11-30')).toEqual([
      '2027-10-24',
      '2027-10-31',
      '2027-11-07',
      '2027-11-14',
    ]);
  });

  it('skips absent month-end days instead of clamping', () => {
    const monthly = rule({
      frequency: 'monthly',
      byMonthDay: 31,
      count: 4,
      timeZone: 'America/Denver',
    });
    expect(range(monthly, '2028-01-31', '2028-01-01', '2028-08-01')).toEqual([
      '2028-01-31',
      '2028-03-31',
      '2028-05-31',
      '2028-07-31',
    ]);
  });

  it('keeps monthly intervals aligned when the window starts mid-series', () => {
    const everyTwo = rule({
      frequency: 'monthly',
      interval: 2,
      count: null,
      until: null,
    });
    expect(range(everyTwo, '2026-01-15', '2026-04-01', '2026-09-30')).toEqual([
      '2026-05-15',
      '2026-07-15',
      '2026-09-15',
    ]);
    const everyThree = rule({
      frequency: 'monthly',
      interval: 3,
      count: null,
      until: null,
    });
    expect(range(everyThree, '2026-05-01', '2026-08-15', '2027-03-01')).toEqual(
      ['2026-11-01', '2027-02-01'],
    );
  });

  it('supports monthly nth-weekday and last-weekday patterns', () => {
    const secondTuesday = rule({
      frequency: 'monthly',
      monthlyMode: 'weekday',
      byDay: ['TU'],
      bySetPos: 2,
      count: 3,
      timeZone: 'America/Denver',
    });
    expect(
      range(secondTuesday, '2027-01-12', '2027-01-01', '2027-06-01'),
    ).toEqual(['2027-01-12', '2027-02-09', '2027-03-09']);
    const lastFriday = rule({
      frequency: 'monthly',
      monthlyMode: 'weekday',
      byDay: ['FR'],
      bySetPos: -1,
      count: 3,
      timeZone: 'America/Denver',
    });
    expect(range(lastFriday, '2027-01-29', '2027-01-01', '2027-05-01')).toEqual(
      ['2027-01-29', '2027-02-26', '2027-03-26'],
    );
  });

  it('supports yearly leap days and interval years', () => {
    const yearly = rule({
      frequency: 'yearly',
      count: 3,
      timeZone: 'America/Denver',
    });
    expect(range(yearly, '2028-02-29', '2028-01-01', '2040-01-01')).toEqual([
      '2028-02-29',
      '2032-02-29',
      '2036-02-29',
    ]);
    const everyOther = rule({
      frequency: 'yearly',
      interval: 2,
      count: 2,
      timeZone: 'America/Denver',
    });
    expect(range(everyOther, '2027-11-09', '2027-01-01', '2032-01-01')).toEqual(
      ['2027-11-09', '2029-11-09'],
    );
  });

  it('parses and renders RRULE text, including NONE handling by callers', () => {
    const parsed = parseRRule(
      'FREQ=MONTHLY;INTERVAL=2;BYDAY=2TU;COUNT=5',
      'America/Denver',
    );
    expect(parsed).toMatchObject({
      frequency: 'monthly',
      interval: 2,
      monthlyMode: 'weekday',
      byDay: ['TU'],
      bySetPos: 2,
      count: 5,
      timeZone: 'America/Denver',
    });
    expect(toRRule(parsed)).toBe('FREQ=MONTHLY;INTERVAL=2;COUNT=5;BYDAY=2TU');
    expect(parseRRule('FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20271231').until).toBe(
      '2027-12-31',
    );
    expect(() => parseRRule('FREQ=HOURLY')).toThrow();
    expect(() => parseRRule('FREQ=MONTHLY;BYDAY=MO,WE')).toThrow();
    expect(() =>
      recurrenceSchema.parse({
        frequency: 'weekly',
        interval: 1,
        count: null,
        until: null,
        byDay: [],
      }),
    ).toThrow();
  });

  it('summarizes rules in plain language', () => {
    expect(
      recurrenceSummary(
        rule({
          frequency: 'weekly',
          byDay: ['MO', 'WE'],
          until: '2027-12-15',
        }),
        '2027-11-01',
      ),
    ).toBe('Weekly on Monday, Wednesday, until 2027-12-15');
    expect(
      recurrenceSummary(
        rule({
          frequency: 'monthly',
          monthlyMode: 'weekday',
          byDay: ['TU'],
          bySetPos: 2,
        }),
        '2027-01-12',
      ),
    ).toBe('Monthly on the 2nd Tuesday');
    expect(
      recurrenceSummary(rule({ frequency: 'yearly', count: 3 }), '2027-11-09'),
    ).toBe('Yearly on Nov 9, 3 occurrences');
  });
});
