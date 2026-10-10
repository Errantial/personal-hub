import ICAL from 'ical.js';
import { Temporal, canvasProviderDataSchema } from '@hub/contracts';
import { z } from 'zod';
export class FeedError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
export type FeedEntry = {
  uid: string;
  cancelled: boolean;
  data: z.infer<typeof canvasProviderDataSchema>;
};
const supportedLink = (input: unknown): string | null => {
  if (typeof input !== 'string') return null;
  try {
    const url = new URL(input);
    return url.origin === 'https://canvas.colorado.edu' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^\/courses\/\d+\/(assignments|calendar_events|quizzes)\/\d+$/.test(
        url.pathname,
      )
      ? url.href
      : null;
  } catch {
    return null;
  }
};
export function parseCanvasFeed(text: string): FeedEntry[] {
  if (Buffer.byteLength(text) > 1024 * 1024)
    throw new FeedError('FEED_TOO_LARGE');
  try {
    const parsed = ICAL.parse(text);
    // Exactly one complete VCALENDAR; HTML login pages and partial files fail.
    if (parsed[0] !== 'vcalendar' || !/END:VCALENDAR\s*$/i.test(text))
      throw new FeedError('INVALID_FEED');
    const root = new ICAL.Component(parsed);
    if (root.getFirstPropertyValue('version') !== '2.0')
      throw new FeedError('INVALID_FEED');
    const events = root.getAllSubcomponents('vevent');
    if (events.length > 2000) throw new FeedError('FEED_TOO_LARGE');
    const seen = new Set<string>();
    return events.map((event) => {
      if (
        ['rrule', 'rdate', 'exdate', 'recurrence-id', 'duration'].some((name) =>
          event.hasProperty(name),
        )
      )
        throw new FeedError('UNSUPPORTED_FEED');
      const uid = z
        .string()
        .min(1)
        .max(1000)
        .parse(event.getFirstPropertyValue('uid'));
      if (seen.has(uid)) throw new FeedError('DUPLICATE_UID');
      seen.add(uid);
      const cancelled =
        String(event.getFirstPropertyValue('status') ?? '').toUpperCase() ===
        'CANCELLED';
      const date = (name: string) => {
        const property = event.getFirstProperty(name);
        if (property) {
          const raw = property.toJSON()[3];
          if (typeof raw !== 'string' || raw.startsWith('0000'))
            throw new FeedError('INVALID_FEED');
          // Validate before ICAL.Time decoration can normalize an invalid date.
          if (property.type === 'date')
            Temporal.PlainDate.from(raw, { overflow: 'reject' });
          else if (property.type === 'date-time')
            Temporal.PlainDateTime.from(raw.replace(/Z$/, ''), {
              overflow: 'reject',
            });
          else throw new FeedError('INVALID_FEED');
        }
        const value = property?.getFirstValue();
        if (!value) return null;
        if (!(value instanceof ICAL.Time)) throw new FeedError('INVALID_FEED');
        if (value.isDate)
          return {
            date: Temporal.PlainDate.from(value.toString(), {
              overflow: 'reject',
            }).toString(),
            instant: null,
          };
        const zone = property?.getParameter('tzid');
        const raw = value.toString();
        // No guessed timezone for floating times or ambiguous/nonexistent local times.
        const instant = raw.endsWith('Z')
          ? Temporal.Instant.from(raw).toString({ smallestUnit: 'millisecond' })
          : typeof zone === 'string'
            ? Temporal.PlainDateTime.from(raw, { overflow: 'reject' })
                .toZonedDateTime(zone, { disambiguation: 'reject' })
                .toInstant()
                .toString({ smallestUnit: 'millisecond' })
            : null;
        if (!instant) throw new FeedError('UNSUPPORTED_FEED');
        return { date: null, instant };
      };
      const start = date('dtstart');
      const end = date('dtend');
      if (!start && !cancelled) throw new FeedError('INVALID_FEED');
      if (end && (!start || (start.date === null) !== (end.date === null)))
        throw new FeedError('INVALID_FEED');
      if (
        start &&
        end &&
        (end.instant ?? end.date!) < (start.instant ?? start.date!)
      )
        throw new FeedError('INVALID_FEED');
      if (start?.date && end?.date && end.date <= start.date)
        throw new FeedError('INVALID_FEED');
      return {
        uid,
        cancelled,
        data: canvasProviderDataSchema.parse({
          title:
            event.getFirstPropertyValue('summary') ??
            (cancelled ? 'Cancelled entry' : 'Canvas entry'),
          description: event.getFirstPropertyValue('description') ?? '',
          startsAt: start?.instant ?? null,
          endsAt: end?.instant ?? null,
          startDate: start?.date ?? null,
          endDate:
            end?.date ??
            (start?.date
              ? Temporal.PlainDate.from(start.date).add({ days: 1 }).toString()
              : null),
          allDay: Boolean(start?.date),
          sourceUrl: supportedLink(event.getFirstPropertyValue('url')),
        }),
      };
    });
  } catch (error) {
    if (error instanceof FeedError) throw error;
    throw new FeedError('INVALID_FEED');
  }
}
export type FeedFetcher = (url: string) => Promise<string>;
export const fetchCanvasFeed: FeedFetcher = async (url) => {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 10000);
  try {
    const response = await fetch(url, {
      redirect: 'error',
      signal: abort.signal,
      headers: { Accept: 'text/calendar' },
    });
    if (!response.ok)
      throw new FeedError(
        response.status === 401 || response.status === 403
          ? 'ACCESS_REVOKED'
          : 'FETCH_FAILED',
      );
    if (!response.body) throw new FeedError('INVALID_FEED');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.length;
        if (bytes > 1024 * 1024) throw new FeedError('FEED_TOO_LARGE');
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } catch (error) {
    if (error instanceof FeedError) throw error;
    throw new FeedError('FETCH_FAILED');
  } finally {
    clearTimeout(timer);
  }
};
