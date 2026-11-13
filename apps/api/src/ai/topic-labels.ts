import { sensitivitySchema } from '@hub/contracts';
import type { z } from 'zod';

type Sensitivity = z.infer<typeof sensitivitySchema>;

export type TopicLabelState =
  { complete: false } | { complete: true; labels: Sensitivity[] };

/**
 * Topic context is eligible only when its retained label history is present.
 * Effective labels are the union of the topic, its class and every retained
 * history entry, so a later lowered sensitivity cannot erase an earlier label.
 */
export function topicLabelState(
  topic: { sensitivity: unknown; academicLabels: unknown },
  courseSensitivity: unknown,
): TopicLabelState {
  if (topic.academicLabels === null || topic.academicLabels === undefined)
    return { complete: false };
  const history = sensitivitySchema
    .array()
    .max(2)
    .safeParse(topic.academicLabels);
  const own = sensitivitySchema.safeParse(topic.sensitivity);
  const course = sensitivitySchema.safeParse(courseSensitivity);
  if (!history.success || !own.success || !course.success)
    return { complete: false };
  const all = [own.data, course.data, ...history.data];
  const retained = [
    ...new Set<Sensitivity>(all.filter((label) => label !== 'unlabeled')),
  ];
  return {
    complete: true,
    labels: retained.length ? retained : ['unlabeled'],
  };
}
