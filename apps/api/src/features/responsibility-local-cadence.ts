import { Temporal, responsibilityLocalRuleSchema } from '@hub/contracts';
import type { ResponsibilityLocalRule } from '@hub/contracts';
import { ApiError } from '../errors.js';

/** The rule's local times per day: `times` (D57) or the single localTime. */
const slotTimes = (rule: ResponsibilityLocalRule) =>
  rule.times ?? [rule.localTime];

// Civil date arithmetic preserves the chosen time. Compatible disambiguation
// shifts nonexistent times forward and selects the earlier folded instant.
// Slot `index` is day floor(index / n) at the (index mod n)th listed time.
export function localReviewSlot(
  candidate: ResponsibilityLocalRule,
  index: number,
): string | null {
  const rule = responsibilityLocalRuleSchema.parse(candidate);
  if (!Number.isSafeInteger(index) || index < 0)
    throw new ApiError(
      409,
      'LOCAL_SCHEDULE_UNAVAILABLE',
      'Local schedule position is unavailable.',
    );
  const step = rule.interval * (rule.frequency === 'weekly' ? 7 : 1);
  const times = slotTimes(rule);
  let date;
  try {
    date = Temporal.PlainDate.from(rule.startDate).add({
      days: step * Math.floor(index / times.length),
    });
  } catch {
    return null;
  }
  if (date.year > 9999) return null;
  const instant = date
    .toPlainDateTime(times[index % times.length])
    .toZonedDateTime(rule.timeZone, { disambiguation: 'compatible' })
    .toInstant();
  const value = new Date(instant.epochMilliseconds).toISOString();
  return /^\d{4}-/.test(value) && !value.startsWith('0000') ? value : null;
}
export function advanceLocalReview(
  rule: ResponsibilityLocalRule,
  index: number,
  due: string,
  now: number,
) {
  const year = new Date(now).getUTCFullYear();
  if (
    !Number.isSafeInteger(now) ||
    !Number.isFinite(year) ||
    year < 1 ||
    year > 9999
  )
    throw new ApiError(
      409,
      'SCHEDULE_RANGE',
      'Review time is outside the supported range.',
    );
  if (localReviewSlot(rule, index) !== due)
    throw new ApiError(
      409,
      'LOCAL_SCHEDULE_UNAVAILABLE',
      'Local schedule slot could not be verified.',
    );
  if (Date.parse(due) > now)
    throw new ApiError(409, 'NOT_DUE', 'This review is not due.');
  const start = Temporal.PlainDate.from(rule.startDate);
  const localNow = Temporal.Instant.fromEpochMilliseconds(now)
    .toZonedDateTimeISO(rule.timeZone)
    .toPlainDate();
  const step = rule.interval * (rule.frequency === 'weekly' ? 7 : 1);
  const perDay = slotTimes(rule).length;
  let latest = Math.max(
    index,
    (Math.floor(start.until(localNow).days / step) + 1) * perDay - 1,
  );
  for (let remaining = 8 * perDay; latest > index && remaining; remaining--) {
    const candidate = localReviewSlot(rule, latest);
    if (candidate !== null && Date.parse(candidate) <= now) break;
    latest--;
  }
  const latestSlot = localReviewSlot(rule, latest);
  if (latestSlot === null || Date.parse(latestSlot) > now)
    throw new ApiError(
      409,
      'LOCAL_SCHEDULE_UNAVAILABLE',
      'Local schedule position could not be resolved.',
    );
  let nextIndex = latest + 1;
  // A civil date skipped by a zone transition can resolve to the same instant
  // as the following date. Coalesce it rather than generating duplicate runs.
  for (let remaining = 8; remaining; remaining--) {
    const next = localReviewSlot(rule, nextIndex);
    if (next === null)
      return {
        next: null,
        nextLocalIndex: null,
        skippedIntervals: nextIndex - index - 1,
      };
    if (Date.parse(next) > now)
      return {
        next,
        nextLocalIndex: nextIndex,
        skippedIntervals: nextIndex - index - 1,
      };
    nextIndex++;
  }
  throw new ApiError(
    409,
    'LOCAL_SCHEDULE_UNAVAILABLE',
    'Choose another local schedule start.',
  );
}

/** The first slot strictly after `now`, so a new schedule never starts in the past. */
export function firstSlotAfter(
  rule: ResponsibilityLocalRule,
  now: number,
): { index: number; at: string } | null {
  const perDay = slotTimes(rule).length;
  const step = rule.interval * (rule.frequency === 'weekly' ? 7 : 1);
  const localNow = Temporal.Instant.fromEpochMilliseconds(now)
    .toZonedDateTimeISO(rule.timeZone)
    .toPlainDate();
  const days = Temporal.PlainDate.from(rule.startDate).until(localNow).days;
  // Start one period before today's to cover zone offsets, then walk forward.
  let index = Math.max(0, (Math.floor(days / step) - 1) * perDay);
  for (let remaining = 3 * perDay + 8; remaining; remaining--, index++) {
    const at = localReviewSlot(rule, index);
    if (at === null) return null;
    if (Date.parse(at) > now) return { index, at };
  }
  return null;
}
