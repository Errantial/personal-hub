import { z } from 'zod';
import {
  instant,
  zone,
  canvasLmsCourseDataSchema,
  canvasLmsAssignmentDataSchema,
} from '@hub/contracts';
export const canvasApiOrigin = 'https://canvas.colorado.edu';
export class CanvasApiError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
const id = z.union([
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform(String),
  z.string().regex(/^[1-9]\d{0,19}$/),
]);
const courseSchema = z.object({
  id,
  name: z.string().min(1).max(200),
  course_code: z.string().max(200).optional(),
  term: z
    .object({ name: z.string().max(200) })
    .nullable()
    .optional(),
  time_zone: zone.nullable().optional(),
});
const assignmentSchema = z.object({
  id,
  course_id: id,
  name: z.string().min(1).max(200),
  due_at: instant.nullable(),
  points_possible: z.number().finite().nonnegative().nullable().optional(),
  published: z.boolean().optional(),
  locked_for_user: z.boolean().optional(),
});
export type CanvasApiSnapshot = {
  accountProviderId: string;
  courses: {
    providerId: string;
    data: z.infer<typeof canvasLmsCourseDataSchema>;
  }[];
  assignments: {
    providerId: string;
    courseProviderId: string;
    data: z.infer<typeof canvasLmsAssignmentDataSchema>;
  }[];
};
export type CanvasApiFetcher = (
  token: string,
  expectedAccountId?: string | null,
) => Promise<CanvasApiSnapshot>;
export function validateCanvasSnapshot(
  value: CanvasApiSnapshot,
): CanvasApiSnapshot {
  const snapshot = z
    .object({
      accountProviderId: id,
      courses: z
        .array(z.object({ providerId: id, data: canvasLmsCourseDataSchema }))
        .max(100),
      assignments: z
        .array(
          z.object({
            providerId: id,
            courseProviderId: id,
            data: canvasLmsAssignmentDataSchema,
          }),
        )
        .max(2000),
    })
    .safeParse(value);
  if (!snapshot.success) throw new CanvasApiError('INVALID_API_RESPONSE');
  const courses = new Set(
    snapshot.data.courses.map((course) => course.providerId),
  );
  const assignments = new Set(
    snapshot.data.assignments.map(
      (item) => `${item.courseProviderId}:${item.providerId}`,
    ),
  );
  if (
    courses.size !== snapshot.data.courses.length ||
    assignments.size !== snapshot.data.assignments.length ||
    snapshot.data.assignments.some(
      (item) => !courses.has(item.courseProviderId),
    )
  )
    throw new CanvasApiError('INVALID_API_RESPONSE');
  return snapshot.data;
}
function pageUrl(value: string, path: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CanvasApiError('UNSAFE_API_PAGE');
  }
  if (
    url.origin !== canvasApiOrigin ||
    url.username ||
    url.password ||
    url.hash ||
    url.pathname.replace(/\.json$/, '') !== path ||
    [...url.searchParams.keys()].some(
      (key) => key.toLowerCase() === 'access_token',
    )
  )
    throw new CanvasApiError('UNSAFE_API_PAGE');
  return url.href;
}
function nextPage(header: string | null, path: string) {
  if (!header) return null;
  if (header.length > 16384) throw new CanvasApiError('INVALID_API_RESPONSE');
  let next: string | null = null;
  let consumed = '';
  const pattern = /<([^<>]+)>([^,]*)(?:,|$)/g;
  for (const match of header.matchAll(pattern)) {
    consumed += match[0];
    const relation = /;\s*rel\s*=\s*(?:"([^"]+)"|([^\s;,]+))/i.exec(match[2]!);
    if (!relation) throw new CanvasApiError('INVALID_API_RESPONSE');
    if ((relation[1] ?? relation[2]!).split(/\s+/).includes('next')) {
      if (next) throw new CanvasApiError('INVALID_API_RESPONSE');
      next = pageUrl(match[1]!, path);
    }
  }
  if (consumed.replace(/\s/g, '') !== header.replace(/\s/g, ''))
    throw new CanvasApiError('INVALID_API_RESPONSE');
  return next;
}
export async function fetchCanvasApi(
  token: string,
  transport: typeof fetch = fetch,
  expectedAccountId?: string | null,
): Promise<CanvasApiSnapshot> {
  const signal = AbortSignal.timeout(90000);
  const budget = { pages: 0, bytes: 0 };
  async function readPage(next: string, path: string) {
    if (signal.aborted) throw new CanvasApiError('API_TIMEOUT');
    next = pageUrl(next, path);
    if (++budget.pages > 100) throw new CanvasApiError('API_LIMIT');
    let response: Response;
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
    try {
      response = await transport(next, {
        method: 'GET',
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
        signal: requestSignal,
      });
    } catch {
      throw new CanvasApiError(
        requestSignal.aborted ? 'API_TIMEOUT' : 'API_FETCH_FAILED',
      );
    }
    try {
      if (!response.ok)
        throw new CanvasApiError(
          response.status === 401
            ? 'API_AUTH_FAILED'
            : response.status === 403
              ? 'API_ACCESS_DENIED'
              : response.status === 429
                ? 'API_RATE_LIMITED'
                : 'API_FETCH_FAILED',
        );
      if (
        response.redirected ||
        (response.url && pageUrl(response.url, path) !== next)
      )
        throw new CanvasApiError('UNSAFE_API_PAGE');
      if (
        !/^application\/json(?:;|$)/i.test(
          response.headers.get('content-type') ?? '',
        )
      )
        throw new CanvasApiError('INVALID_API_RESPONSE');
    } catch (error) {
      await response.body?.cancel().catch(() => undefined);
      throw error;
    }
    const reader = response.body?.getReader();
    if (!reader) throw new CanvasApiError('INVALID_API_RESPONSE');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        budget.bytes += value.byteLength;
        if (size > 1024 * 1024 || budget.bytes > 8 * 1024 * 1024)
          throw new CanvasApiError('API_LIMIT');
        chunks.push(value);
      }
    } catch (error) {
      throw error instanceof CanvasApiError
        ? error
        : new CanvasApiError(
            requestSignal.aborted ? 'API_TIMEOUT' : 'API_FETCH_FAILED',
          );
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    let page: unknown;
    try {
      page = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
      );
    } catch {
      throw new CanvasApiError('INVALID_API_RESPONSE');
    }
    return { page, link: response.headers.get('link') };
  }
  async function pages(path: string, query: string) {
    let next: string | null = `${canvasApiOrigin}${path}?${query}`;
    const seen = new Set<string>();
    const rows: unknown[] = [];
    while (next) {
      next = pageUrl(next, path);
      if (seen.has(next)) throw new CanvasApiError('INVALID_API_RESPONSE');
      seen.add(next);
      const { page, link } = await readPage(next, path);
      if (!Array.isArray(page))
        throw new CanvasApiError('INVALID_API_RESPONSE');
      if (rows.length + page.length > (path === '/api/v1/courses' ? 100 : 2000))
        throw new CanvasApiError('API_LIMIT');
      rows.push(...page);
      next = nextPage(link, path);
    }
    return rows;
  }
  const identityPath = '/api/v1/users/self';
  const identity = z
    .object({ id })
    .safeParse(
      (await readPage(`${canvasApiOrigin}${identityPath}`, identityPath)).page,
    );
  if (!identity.success) throw new CanvasApiError('INVALID_API_RESPONSE');
  if (expectedAccountId && identity.data.id !== expectedAccountId)
    throw new CanvasApiError('API_ACCOUNT_MISMATCH');
  const result: CanvasApiSnapshot = {
    accountProviderId: identity.data.id,
    courses: [],
    assignments: [],
  };
  const courses = z
    .array(courseSchema)
    .safeParse(
      await pages(
        '/api/v1/courses',
        'per_page=100&enrollment_type=student&enrollment_state=active&include%5B%5D=term',
      ),
    );
  if (
    !courses.success ||
    new Set(courses.data.map((course) => course.id)).size !==
      courses.data.length
  )
    throw new CanvasApiError('INVALID_API_RESPONSE');
  for (const course of courses.data) {
    result.courses.push({
      providerId: course.id,
      data: {
        name: course.name,
        code: course.course_code ?? '',
        term: course.term?.name ?? '',
        timeZone: course.time_zone ?? null,
      },
    });
    const assignments = z
      .array(assignmentSchema)
      .safeParse(
        await pages(
          `/api/v1/courses/${course.id}/assignments`,
          'per_page=100&override_assignment_dates=true',
        ),
      );
    if (
      !assignments.success ||
      assignments.data.some((item) => item.course_id !== course.id)
    )
      throw new CanvasApiError('INVALID_API_RESPONSE');
    for (const assignment of assignments.data)
      result.assignments.push({
        providerId: assignment.id,
        courseProviderId: course.id,
        data: {
          title: assignment.name,
          dueAt: assignment.due_at,
          pointsPossible: assignment.points_possible ?? null,
          published: assignment.published ?? null,
          locked: assignment.locked_for_user ?? null,
        },
      });
    if (result.assignments.length > 2000) throw new CanvasApiError('API_LIMIT');
  }
  return validateCanvasSnapshot(result);
}
