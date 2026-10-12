import { Temporal, responsibilityLocalRuleSchema } from '@hub/contracts';
import type { ResponsibilityLocalRule } from '@hub/contracts';
import { ApiError } from '../errors.js';

// Civil date arithmetic preserves the chosen time. Compatible disambiguation
// shifts nonexistent times forward and selects the earlier folded instant.
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
  let date;
  try {
    date = Temporal.PlainDate.from(rule.startDate).add({ days: step * index });
  } catch {
    return null;
  }
  if (date.year > 9999) return null;
  const instant = date
    .toPlainDateTime(rule.localTime)
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
  let latest = Math.max(index, Math.floor(start.until(localNow).days / step));
  for (let remaining = 8; latest > index && remaining; remaining--) {
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
