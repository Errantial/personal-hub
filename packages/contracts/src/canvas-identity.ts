const canvasOrigin = 'https://canvas.colorado.edu';
const providerId = /^[1-9]\d{0,19}$/;
const deadlineUrl =
  /^https:\/\/canvas\.colorado\.edu(\/courses\/([1-9]\d{0,19})\/(assignments|quizzes)\/([1-9]\d{0,19}))$/;

export type CanvasDeadlineIdentity = {
  canonicalKey: string;
  canonicalUrl: string;
  courseProviderId: string;
  providerId: string;
  resourceKind: 'assignment' | 'quiz';
};

export function canvasDeadlineIdentity(
  input: string | null | undefined,
): CanvasDeadlineIdentity | null {
  if (!input) return null;
  const match = deadlineUrl.exec(input);
  if (!match) return null;
  const resourceKind = match[3] === 'assignments' ? 'assignment' : 'quiz';
  return {
    canonicalKey: `canvas:canvas.colorado.edu:${match[1]}`,
    canonicalUrl: `${canvasOrigin}${match[1]}`,
    courseProviderId: match[2]!,
    providerId: match[4]!,
    resourceKind,
  };
}

export function canvasDeadlineUrl(
  courseProviderId: string,
  resourceKind: 'assignment' | 'quiz',
  itemProviderId: string,
) {
  if (!providerId.test(courseProviderId) || !providerId.test(itemProviderId))
    throw new Error('Invalid Canvas provider identity.');
  const segment = resourceKind === 'assignment' ? 'assignments' : 'quizzes';
  return `${canvasOrigin}/courses/${courseProviderId}/${segment}/${itemProviderId}`;
}

export function canvasAssignmentUrl(
  courseProviderId: string,
  assignmentProviderId: string,
) {
  return canvasDeadlineUrl(
    courseProviderId,
    'assignment',
    assignmentProviderId,
  );
}
