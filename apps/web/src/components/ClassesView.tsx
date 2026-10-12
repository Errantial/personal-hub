import { useRef, useState } from 'react';
import {
  calendarListSchema,
  courseResponseSchema,
  coursesSchema,
  topicResponseSchema,
  topicsSchema,
} from '@hub/contracts';
import type { CalendarRecord, Course, Topic } from '@hub/contracts';
import { getSnapshot } from '../lib/api';
import type { StudyDraft } from '../lib/calendar';
import {
  assessmentLabel,
  averageProgress,
  isAssessed,
  splitStudyBlocks,
} from '../lib/classes';
import { useMutation, useResource } from '../lib/hooks';
import { classSectionLabels, classSections } from '../lib/router';
import type { ClassSection, Route } from '../lib/router';
import { ClassCanvasAssignments } from './ClassCanvasAssignments';
import { ClassCanvasEntries } from './ClassCanvasEntries';
import { ClassForm, TopicForm } from './ClassForms';
import { useConfirm } from './ConfirmDialog';
import { Help } from './Help';
import { Link } from './Link';
import { ReadState } from './ReadState';
import { StatusChip } from './StatusChip';
import './ClassesView.css';

type ClassesRoute = Extract<Route, { name: 'classes' }>;
type Navigate = (route: Route) => void;

const labelText = { personal: 'Personal', restricted: 'Restricted' } as const;

export function ClassesView({
  route,
  navigate,
  onSchedule,
}: {
  route: ClassesRoute;
  navigate: Navigate;
  onSchedule: (draft: StudyDraft) => void;
}) {
  const courses = useResource(
    (signal) => getSnapshot('/api/v1/courses', coursesSchema, signal),
    { failure: 'Classes unavailable. Retry classes.' },
  );
  const topics = useResource(
    (signal) => getSnapshot('/api/v1/topics', topicsSchema, signal),
    { failure: 'Topics unavailable. Retry topics.' },
  );
  const [dialog, confirm] = useConfirm();
  const remove = useMutation();
  const heading = useRef<HTMLHeadingElement>(null);
  const all = courses.data?.data.courses ?? [];
  const allTopics = topics.data?.data.topics ?? [];
  const reloadCourses = async () => (await courses.reload())?.data.courses;
  const reloadTopics = async () => (await topics.reload())?.data.topics;
  const listRoute: ClassesRoute = { name: 'classes' };

  async function deleteClass(course: Course) {
    const confirmed = await confirm({
      title: `Delete class “${course.name}”?`,
      message:
        'Its topics are removed from the portfolio. Calendar study blocks and Canvas links stay.',
      confirmLabel: 'Delete class',
    });
    if (!confirmed) return;
    const result = await remove.run(
      courseResponseSchema,
      'DELETE',
      `/api/v1/courses/${course.id}`,
      { expectedVersion: course.version },
      'Could not delete. The class is unchanged.',
    );
    if (!result) return;
    navigate(listRoute);
    await Promise.all([reloadCourses(), reloadTopics()]);
    heading.current?.focus();
  }

  return (
    <section className="classes-view" aria-label="Classes">
      {remove.error && (
        <p role="alert" className="form-error">
          {remove.error}
        </p>
      )}
      <div
        className={`classes-layout ${route.id ? 'classes-layout--detail' : ''}`}
      >
        <section
          className="panel classes-list-pane"
          aria-labelledby="class-list-title"
        >
          <h2 id="class-list-title" ref={heading} tabIndex={-1}>
            Classes{courses.data ? ` (${all.length})` : ''}
          </h2>
          <Help label="Classes">
            Progress and confidence are your own assessments. Grades are not
            imported, and finishing study time does not mean a topic is
            mastered.
          </Help>
          <ReadState resource={courses} label="classes" />
          <Link
            className="classes-add"
            route={{ name: 'classes', id: 'new' }}
            navigate={navigate}
            current={route.id === 'new'}
          >
            Add class
          </Link>
          {courses.data && !all.length && <p>No classes yet.</p>}
          <ul className="class-list">
            {all.map((course) => {
              const own = allTopics.filter(
                (topic) => topic.courseId === course.id,
              );
              const average = averageProgress(own);
              return (
                <li
                  key={course.id}
                  aria-current={route.id === course.id ? 'true' : undefined}
                >
                  <Link
                    className="class-list__title"
                    route={{ name: 'classes', id: course.id }}
                    navigate={navigate}
                  >
                    {course.name}
                  </Link>
                  <div className="class-list__meta">
                    {(course.term || course.instructor) && (
                      <span>
                        {[course.term, course.instructor]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    )}
                    <span>
                      {own.length} {own.length === 1 ? 'topic' : 'topics'}
                      {average !== null && ` · ${average}% self-reported`}
                    </span>
                    {course.sensitivity !== 'unlabeled' && (
                      <StatusChip>{labelText[course.sensitivity]}</StatusChip>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
        {route.id === 'new' && (
          <section
            className="panel class-detail"
            aria-labelledby="class-detail-title"
          >
            <BackLink navigate={navigate} />
            <h2 id="class-detail-title">Add class</h2>
            <ClassForm
              reload={reloadCourses}
              onSaved={(course) => navigate({ name: 'classes', id: course.id })}
            />
          </section>
        )}
        {route.id && route.id !== 'new' && (
          <ClassDetail
            key={route.id}
            route={route}
            id={route.id}
            course={all.find((item) => item.id === route.id)}
            loaded={!!courses.data}
            topics={allTopics.filter((topic) => topic.courseId === route.id)}
            navigate={navigate}
            onSchedule={onSchedule}
            reloadCourses={reloadCourses}
            reloadTopics={reloadTopics}
            onDelete={deleteClass}
            deleting={remove.pending}
            confirm={confirm}
          />
        )}
      </div>
      {dialog}
    </section>
  );
}

function BackLink({ navigate }: { navigate: Navigate }) {
  return (
    <Link
      className="class-detail__back"
      route={{ name: 'classes' }}
      navigate={navigate}
    >
      Back to classes
    </Link>
  );
}

type Confirm = ReturnType<typeof useConfirm>[1];

function ClassDetail({
  route,
  id,
  course,
  loaded,
  topics,
  navigate,
  onSchedule,
  reloadCourses,
  reloadTopics,
  onDelete,
  deleting,
  confirm,
}: {
  route: ClassesRoute;
  id: string;
  course: Course | undefined;
  loaded: boolean;
  topics: Topic[];
  navigate: Navigate;
  onSchedule: (draft: StudyDraft) => void;
  reloadCourses: () => Promise<Course[] | undefined>;
  reloadTopics: () => Promise<Topic[] | undefined>;
  onDelete: (course: Course) => Promise<void>;
  deleting: boolean;
  confirm: Confirm;
}) {
  const section: ClassSection = route.section ?? 'topics';
  if (!course)
    return (
      <section className="panel class-detail" aria-label="Class details">
        <BackLink navigate={navigate} />
        {loaded ? (
          <p>This class is not available. It may have been deleted.</p>
        ) : (
          <p role="status">Loading…</p>
        )}
      </section>
    );
  return (
    <section
      className="panel class-detail"
      aria-labelledby="class-detail-title"
    >
      <BackLink navigate={navigate} />
      <h2 id="class-detail-title">{course.name}</h2>
      <p className="meta">
        {[course.term, course.instructor].filter(Boolean).join(' · ') ||
          'No term or instructor'}
        {course.sensitivity !== 'unlabeled' &&
          ` · ${labelText[course.sensitivity]}`}
      </p>
      <nav aria-label="Class sections">
        <ul className="class-sections">
          {classSections.map((value) => (
            <li key={value}>
              <Link
                route={{
                  name: 'classes',
                  id,
                  ...(value === 'topics' ? {} : { section: value }),
                }}
                navigate={navigate}
                current={value === section}
              >
                {classSectionLabels[value]}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {section === 'topics' && (
        <TopicsSection
          course={course}
          topics={topics}
          reload={reloadTopics}
          onSchedule={onSchedule}
          confirm={confirm}
        />
      )}
      {section === 'study' && (
        <StudySection
          course={course}
          topics={topics}
          navigate={navigate}
          onSchedule={onSchedule}
        />
      )}
      {section === 'canvas' && (
        <>
          <ClassCanvasEntries key={course.id} courseId={course.id} />
          <ClassCanvasAssignments
            key={`assignments:${course.id}`}
            courseId={course.id}
          />
        </>
      )}
      {section === 'details' && (
        <section aria-label="Class details">
          <h3>Edit class</h3>
          <ClassForm
            course={course}
            reload={reloadCourses}
            onSaved={() => undefined}
            onDelete={(item) => {
              void onDelete(item);
            }}
            deleting={deleting}
          />
        </section>
      )}
    </section>
  );
}

function TopicsSection({
  course,
  topics,
  reload,
  onSchedule,
  confirm,
}: {
  course: Course;
  topics: Topic[];
  reload: () => Promise<Topic[] | undefined>;
  onSchedule: (draft: StudyDraft) => void;
  confirm: Confirm;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [addKey, setAddKey] = useState(0);
  const remove = useMutation();
  const average = averageProgress(topics);
  const editTarget = topics.find((topic) => topic.id === editing);

  async function deleteTopic(topic: Topic) {
    const confirmed = await confirm({
      title: `Delete topic “${topic.name}”?`,
      message: 'Its progress and notes are removed. Study blocks stay.',
      confirmLabel: 'Delete topic',
    });
    if (!confirmed) return;
    const result = await remove.run(
      topicResponseSchema,
      'DELETE',
      `/api/v1/topics/${topic.id}`,
      { expectedVersion: topic.version },
      'Could not delete. The topic is unchanged.',
    );
    if (!result) return;
    setEditing(null);
    await reload();
  }

  return (
    <section aria-label="Topics">
      <h3>Topics</h3>
      <p>
        {average === null
          ? 'No topic assessments yet.'
          : `Topic progress: ${average}% self-reported average.`}
      </p>
      <button
        type="button"
        className="secondary-button"
        onClick={() =>
          onSchedule({
            courseId: course.id,
            topicId: null,
            title: `Study ${course.name}`,
          })
        }
      >
        Plan class study
      </button>
      {remove.error && (
        <p role="alert" className="form-error">
          {remove.error}
        </p>
      )}
      <ul className="topic-list">
        {topics.map((topic) => (
          <li key={topic.id}>
            <div className="topic-list__body">
              <strong>{topic.name}</strong>
              <small>{assessmentLabel(topic)}</small>
              {isAssessed(topic) && (
                <progress
                  value={topic.progress}
                  max={100}
                  aria-label={`${topic.name} progress`}
                />
              )}
              {topic.notes && <p className="item-notes">{topic.notes}</p>}
              {topic.sensitivity !== 'unlabeled' && (
                <StatusChip>{labelText[topic.sensitivity]}</StatusChip>
              )}
            </div>
            <div className="topic-list__actions">
              <button
                type="button"
                className="secondary-button"
                aria-label={`Edit topic ${topic.name}`}
                onClick={() => setEditing(topic.id)}
              >
                Edit
              </button>
              <button
                type="button"
                className="secondary-button"
                aria-label={`Plan study for ${topic.name}`}
                onClick={() =>
                  onSchedule({
                    courseId: course.id,
                    topicId: topic.id,
                    title: `Study ${topic.name}`,
                  })
                }
              >
                Plan study
              </button>
              <button
                type="button"
                className="danger-button"
                disabled={remove.pending}
                aria-label={`Delete topic ${topic.name}`}
                onClick={() => {
                  void deleteTopic(topic);
                }}
              >
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
      {editTarget ? (
        <TopicForm
          key={`${editTarget.id}`}
          courseId={course.id}
          classLabel={course.sensitivity}
          topic={editTarget}
          reload={reload}
          onDone={() => setEditing(null)}
        />
      ) : (
        <TopicForm
          key={`new:${addKey}`}
          courseId={course.id}
          classLabel={course.sensitivity}
          reload={reload}
          onDone={() => setAddKey((value) => value + 1)}
        />
      )}
    </section>
  );
}

function timeText(event: CalendarRecord) {
  if (event.allDay) return `All day · ${event.startDate}`;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: event.timeZone,
  }).format(new Date(event.startsAt));
}

const statusText = {
  planned: 'Planned',
  completed: 'Completed',
  cancelled: 'Cancelled',
} as const;

/** Calendar events linked to this class. Editing happens in Calendar. */
function StudySection({
  course,
  topics,
  navigate,
  onSchedule,
}: {
  course: Course;
  topics: Topic[];
  navigate: Navigate;
  onSchedule: (draft: StudyDraft) => void;
}) {
  const events = useResource(
    (signal) => getSnapshot('/api/v1/calendar', calendarListSchema, signal),
    { failure: 'Study blocks unavailable. Retry study blocks.' },
  );
  const { upcoming, earlier } = splitStudyBlocks(
    events.data?.data.events ?? [],
    course.id,
    new Date(),
  );
  const topicName = (id: string | null) =>
    topics.find((topic) => topic.id === id)?.name;
  const group = (title: string, items: CalendarRecord[]) =>
    items.length > 0 && (
      <section aria-label={title}>
        <h4>{title}</h4>
        <ul className="study-list">
          {items.map((event) => (
            <li key={event.id}>
              <Link
                className="study-list__title"
                route={{
                  name: 'calendar',
                  editor: { kind: 'event', id: event.id },
                }}
                navigate={navigate}
              >
                {event.title}
              </Link>
              <div className="study-list__meta">
                <span>{timeText(event)}</span>
                {event.recurrence && <span>Repeats</span>}
                {topicName(event.topicId) && (
                  <span>{topicName(event.topicId)}</span>
                )}
                <StatusChip
                  tone={
                    event.studyStatus === 'cancelled' ? 'attention' : 'neutral'
                  }
                >
                  {statusText[event.studyStatus]}
                </StatusChip>
              </div>
            </li>
          ))}
        </ul>
      </section>
    );
  return (
    <section aria-label="Study blocks">
      <h3>Study blocks</h3>
      <Help label="Study blocks">
        Calendar events linked to this class. Completing a block records time
        spent; it does not change topic progress or mean mastery.
      </Help>
      <ReadState resource={events} label="study blocks" />
      <button
        type="button"
        className="secondary-button"
        onClick={() =>
          onSchedule({
            courseId: course.id,
            topicId: null,
            title: `Study ${course.name}`,
          })
        }
      >
        Plan class study
      </button>
      {events.data && !upcoming.length && !earlier.length && (
        <p>No study blocks for this class.</p>
      )}
      {group('Upcoming', upcoming)}
      {group('Earlier', earlier)}
    </section>
  );
}
