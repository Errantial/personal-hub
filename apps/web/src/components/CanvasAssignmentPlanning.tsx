import type {
  CanvasLmsAssignment,
  CanvasLmsCourse,
  Course,
} from '@hub/contracts';
import { CanvasPlanning } from './CanvasPlanning';
import type { CanvasPlanningItem } from './CanvasPlanning';

export function CanvasAssignmentPlanning({
  assignment,
  course,
  classes,
}: {
  assignment: CanvasLmsAssignment;
  course: CanvasLmsCourse;
  classes: Course[];
}) {
  // Reuse the planner form's presentation; API identity is carried explicitly in the request.
  const item: CanvasPlanningItem = {
    id: assignment.id,
    version: assignment.version,
    courseId: course.courseId,
    availability:
      course.availability === 'missing' ? 'missing' : assignment.availability,
    providerData: {
      title: assignment.providerData.title,
      startDate: null,
      startsAt: assignment.providerData.dueAt,
    },
  };
  return (
    <CanvasPlanning
      item={item}
      courses={classes}
      apiCourseVersion={course.version}
    />
  );
}
