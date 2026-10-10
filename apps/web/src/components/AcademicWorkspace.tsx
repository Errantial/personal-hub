import { Help } from './Help';
import { ClassCanvasEntries } from './ClassCanvasEntries';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  coursesSchema,
  topicsSchema,
  courseResponseSchema,
  topicResponseSchema,
} from '@hub/contracts';
import type { Course, Topic } from '@hub/contracts';
import { getJson, requestJson } from '../lib/api';
import type { StudyDraft } from './CalendarWorkspace';
export function AcademicWorkspace({
  onSchedule,
}: {
  onSchedule: (draft: StudyDraft) => void;
}) {
  const [courses, setCourses] = useState<Course[]>([]);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [selected, setSelected] = useState('');
  const [courseEdit, setCourseEdit] = useState<Course | null>(null);
  const [topicEdit, setTopicEdit] = useState<Topic | null>(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef<{ key: string; id: string } | null>(null);
  async function load(signal?: AbortSignal, refreshEditor = false) {
    const [classes, subjects] = await Promise.all([
      getJson('/api/v1/courses', coursesSchema, signal),
      getJson('/api/v1/topics', topicsSchema, signal),
    ]);
    setCourses(classes.courses);
    setTopics(subjects.topics);
    setSelected((value) =>
      classes.courses.some((item) => item.id === value)
        ? value
        : (classes.courses[0]?.id ?? ''),
    );
    if (refreshEditor)
      setCourseEdit((old) => {
        const current = classes.courses.find((value) => value.id === old?.id);
        return old && current ? { ...old, version: current.version } : old;
      });
    if (refreshEditor)
      setTopicEdit((old) => {
        const current = subjects.topics.find((value) => value.id === old?.id);
        return old && current ? { ...old, version: current.version } : old;
      });
  }
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).catch(() => {
      if (!controller.signal.aborted)
        setError('Could not load classes. Reload to try again.');
    });
    return () => controller.abort();
  }, []);
  async function change(
    kind: 'courses' | 'topics',
    method: string,
    id: string | null,
    body: Record<string, unknown>,
  ) {
    const path = `/api/v1/${kind}${id ? `/${id}` : ''}`;
    const key = JSON.stringify({ path, method, body });
    if (pending.current?.key !== key)
      pending.current = { key, id: crypto.randomUUID() };
    const input = { ...body, operationId: pending.current.id };
    if (kind === 'courses')
      await requestJson(path, courseResponseSchema, { method, body: input });
    else await requestJson(path, topicResponseSchema, { method, body: input });
    pending.current = null;
  }
  async function submit(
    event: FormEvent<HTMLFormElement>,
    kind: 'courses' | 'topics',
  ) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    const editing = kind === 'courses' ? courseEdit : topicEdit;
    try {
      const common = {
        name: String(form.get('name')),
        notes: String(form.get('notes')),
        sensitivity: String(form.get('sensitivity')),
      };
      const fields =
        kind === 'courses'
          ? {
              ...common,
              term: String(form.get('term')),
              instructor: String(form.get('instructor')),
            }
          : {
              ...common,
              courseId: selected,
              confidence: String(form.get('confidence')),
              progress: Number(form.get('progress')),
            };
      await change(kind, editing ? 'PUT' : 'POST', editing?.id ?? null, {
        ...fields,
        ...(editing ? { expectedVersion: editing.version } : {}),
      });
      if (kind === 'courses') setCourseEdit(null);
      else setTopicEdit(null);
      setRevision((value) => value + 1);
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }
  async function remove(kind: 'courses' | 'topics', item: Course | Topic) {
    setBusy(true);
    setError('');
    try {
      await change(kind, 'DELETE', item.id, { expectedVersion: item.version });
      setCourseEdit(null);
      setTopicEdit(null);
      await load();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Could not delete.',
      );
    } finally {
      setBusy(false);
    }
  }
  const current = courses.find((value) => value.id === selected);
  const subjects = topics.filter((value) => value.courseId === selected);
  return (
    <section aria-label="Class portfolios">
      <div className="form-actions">
        <button
          className="secondary-button"
          onClick={() => {
            setError('');
            void load(undefined, true).catch(() =>
              setError('Could not reload.'),
            );
          }}
          disabled={busy}
        >
          Reload classes
        </button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="academic-grid">
        <section className="panel planner-panel">
          <h2>Classes</h2>
          <Help label="Classes">
            Progress and confidence are your own assessments. Grades have not
            been imported.
          </Help>
          <ul className="planner-list">
            {courses.map((course) => (
              <li key={course.id}>
                <div className="planner-item-content">
                  <button
                    className="text-button"
                    aria-pressed={selected === course.id}
                    onClick={() => {
                      setSelected(course.id);
                      setTopicEdit(null);
                    }}
                  >
                    {course.name}
                  </button>
                  <small>
                    {course.term} {course.instructor}
                  </small>
                  <span className="item-label">{course.sensitivity}</span>
                </div>
                <div className="item-actions">
                  <button
                    className="text-button"
                    disabled={busy}
                    aria-label={`Edit class ${course.name}`}
                    onClick={() => setCourseEdit(course)}
                  >
                    Edit
                  </button>
                  <button
                    className="text-button"
                    disabled={busy}
                    aria-label={`Delete class ${course.name}`}
                    onClick={() => {
                      void remove('courses', course);
                    }}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <form
            key={`${courseEdit?.id ?? 'new'}:${revision}`}
            className="editor-form"
            onSubmit={(event) => {
              void submit(event, 'courses');
            }}
          >
            <h3>{courseEdit ? 'Edit class' : 'Add class'}</h3>
            <label>
              Class name
              <input
                name="name"
                defaultValue={courseEdit?.name ?? ''}
                required
                maxLength={200}
              />
            </label>
            <label>
              Term
              <input
                name="term"
                defaultValue={courseEdit?.term ?? ''}
                maxLength={100}
              />
            </label>
            <label>
              Instructor
              <input
                name="instructor"
                defaultValue={courseEdit?.instructor ?? ''}
                maxLength={200}
              />
            </label>
            <label>
              Class notes
              <textarea
                name="notes"
                rows={2}
                defaultValue={courseEdit?.notes ?? ''}
                maxLength={10000}
              />
            </label>
            <label>
              Class content label
              <select
                name="sensitivity"
                defaultValue={courseEdit?.sensitivity ?? 'unlabeled'}
              >
                <option value="unlabeled">Unlabeled</option>
                <option value="personal">Personal</option>
                <option value="restricted">Restricted</option>
              </select>
            </label>
            <div className="form-actions">
              <button className="primary-button" disabled={busy}>
                {courseEdit ? 'Save class changes' : 'Add class'}
              </button>
              {courseEdit && (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setCourseEdit(null)}
                >
                  Cancel class edit
                </button>
              )}
            </div>
            <Help label="Classes">
              Deleting a class also removes its topics from the portfolio;
              existing calendar study blocks remain.
            </Help>
          </form>
        </section>
        <section className="panel planner-panel" aria-label="Class topics">
          <h2>{current?.name ?? 'Select a class'}</h2>
          {current && (
            <>
              <p className="item-notes">{current.notes}</p>
              <ClassCanvasEntries key={current.id} courseId={current.id} />
              <button
                className="secondary-button"
                onClick={() =>
                  onSchedule({
                    courseId: current.id,
                    topicId: null,
                    title: `Study ${current.name}`,
                  })
                }
              >
                Schedule class study
              </button>
              <p>
                {subjects.length
                  ? `Topic progress: ${Math.round(subjects.reduce((sum, topic) => sum + topic.progress, 0) / subjects.length)}% self-reported average.`
                  : 'No topic assessments yet.'}
              </p>
              <ul className="planner-list">
                {subjects.map((topic) => (
                  <li key={topic.id}>
                    <div className="planner-item-content">
                      <strong>{topic.name}</strong>
                      <small>
                        {topic.progress}% complete · confidence:{' '}
                        {topic.confidence}
                      </small>
                      <progress
                        value={topic.progress}
                        max={100}
                        aria-label={`${topic.name} progress`}
                      />
                      <p className="item-notes">{topic.notes}</p>
                      <span className="item-label">{topic.sensitivity}</span>
                    </div>
                    <div className="item-actions">
                      <button
                        className="text-button"
                        disabled={busy}
                        aria-label={`Edit topic ${topic.name}`}
                        onClick={() => setTopicEdit(topic)}
                      >
                        Edit
                      </button>
                      <button
                        className="text-button"
                        disabled={busy}
                        aria-label={`Delete topic ${topic.name}`}
                        onClick={() => {
                          void remove('topics', topic);
                        }}
                      >
                        Delete
                      </button>
                      <button
                        className="text-button"
                        onClick={() =>
                          onSchedule({
                            courseId: current.id,
                            topicId: topic.id,
                            title: `Study ${topic.name}`,
                          })
                        }
                      >
                        Schedule study
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
              <form
                key={`${topicEdit?.id ?? 'new'}:${selected}:${revision}`}
                className="editor-form"
                onSubmit={(event) => {
                  void submit(event, 'topics');
                }}
              >
                <h3>{topicEdit ? 'Edit topic' : 'Add topic'}</h3>
                <label>
                  Topic name
                  <input
                    name="name"
                    defaultValue={topicEdit?.name ?? ''}
                    required
                    maxLength={200}
                  />
                </label>
                <label>
                  Topic notes
                  <textarea
                    name="notes"
                    rows={2}
                    defaultValue={topicEdit?.notes ?? ''}
                    maxLength={10000}
                  />
                </label>
                <div className="form-row">
                  <label>
                    Progress (%)
                    <input
                      name="progress"
                      type="number"
                      min={0}
                      max={100}
                      defaultValue={topicEdit?.progress ?? 0}
                      required
                    />
                  </label>
                  <label>
                    Confidence
                    <select
                      name="confidence"
                      defaultValue={topicEdit?.confidence ?? 'unknown'}
                    >
                      <option value="unknown">Unknown</option>
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                    </select>
                  </label>
                </div>
                <label>
                  Topic content label
                  <select
                    name="sensitivity"
                    defaultValue={topicEdit?.sensitivity ?? current.sensitivity}
                  >
                    <option value="unlabeled">Unlabeled</option>
                    <option value="personal">Personal</option>
                    <option value="restricted">Restricted</option>
                  </select>
                </label>
                <div className="form-actions">
                  <button className="primary-button" disabled={busy}>
                    {topicEdit ? 'Save topic changes' : 'Add topic'}
                  </button>
                  {topicEdit && (
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => setTopicEdit(null)}
                    >
                      Cancel topic edit
                    </button>
                  )}
                </div>
              </form>
            </>
          )}
        </section>
      </div>
    </section>
  );
}
