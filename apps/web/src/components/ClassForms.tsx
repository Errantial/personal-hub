import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { courseResponseSchema, topicResponseSchema } from '@hub/contracts';
import type { Course, Topic } from '@hub/contracts';
import { useMutation } from '../lib/hooks';
import { Help } from './Help';

type Sensitivity = Course['sensitivity'];

/** Shown when the record changed on the server after the draft was made. */
export function ChangedElsewhere({
  loading,
  onLoad,
}: {
  loading: boolean;
  onLoad: () => void;
}) {
  return (
    <div role="alert" className="form-error">
      <p>Changed elsewhere. Your edits are still here.</p>
      <button
        type="button"
        className="secondary-button"
        disabled={loading}
        onClick={onLoad}
      >
        {loading ? 'Loading…' : 'Load latest version'}
      </button>
    </div>
  );
}

export function LabelSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Sensitivity;
  onChange: (value: Sensitivity) => void;
}) {
  return (
    <label>
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as Sensitivity)}
      >
        <option value="unlabeled">Unlabeled</option>
        <option value="personal">Personal</option>
        <option value="restricted">Restricted</option>
      </select>
    </label>
  );
}

type ClassDraft = {
  name: string;
  term: string;
  instructor: string;
  notes: string;
  sensitivity: Sensitivity;
};
const toClassDraft = (course?: Course): ClassDraft => ({
  name: course?.name ?? '',
  term: course?.term ?? '',
  instructor: course?.instructor ?? '',
  notes: course?.notes ?? '',
  sensitivity: course?.sensitivity ?? 'unlabeled',
});

/** Adds a class, or edits `course`. The draft keeps the version it started
 *  from; newer server data is only adopted by an explicit "Load latest". */
export function ClassForm({
  course,
  reload,
  onSaved,
  onDelete,
  deleting = false,
}: {
  course?: Course | undefined;
  reload: () => Promise<Course[] | undefined>;
  onSaved: (course: Course, created: boolean) => void;
  onDelete?: (course: Course) => void;
  deleting?: boolean;
}) {
  const [draft, setDraft] = useState(() => toClassDraft(course));
  const [base, setBase] = useState(course?.version ?? 0);
  const [nameError, setNameError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const name = useRef<HTMLInputElement>(null);
  const save = useMutation();
  const changedElsewhere =
    !!course && (course.version !== base || save.conflict);
  const update = <K extends keyof ClassDraft>(
    field: K,
    value: ClassDraft[K],
  ) => {
    setDraft({ ...draft, [field]: value });
    setMessage('');
    if (field === 'name') setNameError('');
  };

  async function loadLatest() {
    setLoading(true);
    const fresh = (await reload())?.find((item) => item.id === course?.id);
    setLoading(false);
    if (!fresh) return;
    setBase(fresh.version);
    save.reset();
    setMessage('Latest version loaded. Your edits are kept.');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (changedElsewhere) return;
    if (!draft.name.trim()) {
      setNameError('Enter a class name');
      name.current?.focus();
      return;
    }
    const result = await save.run(
      courseResponseSchema,
      course ? 'PUT' : 'POST',
      course ? `/api/v1/courses/${course.id}` : '/api/v1/courses',
      course ? { ...draft, expectedVersion: base } : { ...draft },
    );
    if (!result) return;
    const fresh = (await reload())?.find(
      (item) => item.id === result.course.id,
    );
    setBase(fresh?.version ?? result.course.version);
    setMessage(course ? 'Saved.' : '');
    onSaved(result.course, !course);
  }

  return (
    <form
      className="editor-form"
      noValidate
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      {changedElsewhere && (
        <ChangedElsewhere
          loading={loading}
          onLoad={() => {
            void loadLatest();
          }}
        />
      )}
      <label>
        Class name
        <input
          ref={name}
          value={draft.name}
          maxLength={200}
          aria-invalid={!!nameError}
          aria-describedby={nameError ? 'class-name-error' : undefined}
          onChange={(event) => update('name', event.target.value)}
        />
      </label>
      {nameError && (
        <p id="class-name-error" className="form-error">
          <span className="visually-hidden">Error: </span>
          {nameError}
        </p>
      )}
      <label>
        Term
        <input
          value={draft.term}
          maxLength={100}
          onChange={(event) => update('term', event.target.value)}
        />
      </label>
      <label>
        Instructor
        <input
          value={draft.instructor}
          maxLength={200}
          onChange={(event) => update('instructor', event.target.value)}
        />
      </label>
      <label>
        Class notes
        <textarea
          rows={3}
          value={draft.notes}
          maxLength={10000}
          onChange={(event) => update('notes', event.target.value)}
        />
      </label>
      <LabelSelect
        label="Class content label"
        value={draft.sensitivity}
        onChange={(value) => update('sensitivity', value)}
      />
      <Help label="Content label">
        Labels you apply limit which AI providers may use this class. New topics
        start with the class label.
      </Help>
      {save.error && !changedElsewhere && (
        <p role="alert" className="form-error">
          {save.error}
        </p>
      )}
      <p role="status">{message}</p>
      <div className="form-actions">
        <button
          className="primary-button"
          disabled={save.pending || changedElsewhere}
        >
          {save.pending
            ? 'Saving…'
            : course
              ? 'Save class changes'
              : 'Add class'}
        </button>
        {course && onDelete && (
          <button
            type="button"
            className="danger-button"
            disabled={deleting || save.pending}
            onClick={() => onDelete(course)}
          >
            Delete class
          </button>
        )}
      </div>
      {course && (
        <Help label="Deleting a class">
          Deleting a class also removes its topics from the portfolio. Calendar
          study blocks and Canvas links remain.
        </Help>
      )}
    </form>
  );
}

type TopicDraft = {
  name: string;
  notes: string;
  progress: string;
  confidence: Topic['confidence'];
  sensitivity: Sensitivity;
};
const toTopicDraft = (topic: Topic | undefined, sensitivity: Sensitivity) => ({
  name: topic?.name ?? '',
  notes: topic?.notes ?? '',
  progress: String(topic?.progress ?? 0),
  confidence: topic?.confidence ?? ('unknown' as const),
  sensitivity: topic?.sensitivity ?? sensitivity,
});

/** Adds a topic to a class, or edits `topic` (same conflict rules as classes). */
export function TopicForm({
  courseId,
  classLabel,
  topic,
  reload,
  onDone,
}: {
  courseId: string;
  classLabel: Sensitivity;
  topic?: Topic | undefined;
  reload: () => Promise<Topic[] | undefined>;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState<TopicDraft>(() =>
    toTopicDraft(topic, classLabel),
  );
  const [base, setBase] = useState(topic?.version ?? 0);
  const [nameError, setNameError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const name = useRef<HTMLInputElement>(null);
  const save = useMutation();
  const changedElsewhere = !!topic && (topic.version !== base || save.conflict);
  const update = <K extends keyof TopicDraft>(
    field: K,
    value: TopicDraft[K],
  ) => {
    setDraft({ ...draft, [field]: value });
    setMessage('');
    if (field === 'name') setNameError('');
  };

  async function loadLatest() {
    setLoading(true);
    const fresh = (await reload())?.find((item) => item.id === topic?.id);
    setLoading(false);
    if (!fresh) return;
    setBase(fresh.version);
    save.reset();
    setMessage('Latest version loaded. Your edits are kept.');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (changedElsewhere) return;
    if (!draft.name.trim()) {
      setNameError('Enter a topic name');
      name.current?.focus();
      return;
    }
    const progress = Math.round(Number(draft.progress));
    const fields = {
      courseId,
      name: draft.name,
      notes: draft.notes,
      confidence: draft.confidence,
      progress: Number.isFinite(progress)
        ? Math.min(100, Math.max(0, progress))
        : 0,
      sensitivity: draft.sensitivity,
    };
    const result = await save.run(
      topicResponseSchema,
      topic ? 'PUT' : 'POST',
      topic ? `/api/v1/topics/${topic.id}` : '/api/v1/topics',
      topic ? { ...fields, expectedVersion: base } : fields,
    );
    if (!result) return;
    await reload();
    onDone();
  }

  return (
    <form
      className="editor-form"
      noValidate
      aria-label={topic ? 'Edit topic' : 'Add topic'}
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <h3>{topic ? 'Edit topic' : 'Add topic'}</h3>
      {changedElsewhere && (
        <ChangedElsewhere
          loading={loading}
          onLoad={() => {
            void loadLatest();
          }}
        />
      )}
      <label>
        Topic name
        <input
          ref={name}
          value={draft.name}
          maxLength={200}
          aria-invalid={!!nameError}
          aria-describedby={nameError ? 'topic-name-error' : undefined}
          onChange={(event) => update('name', event.target.value)}
        />
      </label>
      {nameError && (
        <p id="topic-name-error" className="form-error">
          <span className="visually-hidden">Error: </span>
          {nameError}
        </p>
      )}
      <label>
        Topic notes
        <textarea
          rows={2}
          value={draft.notes}
          maxLength={10000}
          onChange={(event) => update('notes', event.target.value)}
        />
      </label>
      <div className="form-row">
        <label>
          Progress (%)
          <input
            type="number"
            min={0}
            max={100}
            value={draft.progress}
            onChange={(event) => update('progress', event.target.value)}
          />
        </label>
        <label>
          Confidence
          <select
            value={draft.confidence}
            onChange={(event) =>
              update('confidence', event.target.value as Topic['confidence'])
            }
          >
            <option value="unknown">Unknown</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </label>
      </div>
      <LabelSelect
        label="Topic content label"
        value={draft.sensitivity}
        onChange={(value) => update('sensitivity', value)}
      />
      {save.error && !changedElsewhere && (
        <p role="alert" className="form-error">
          {save.error}
        </p>
      )}
      <p role="status">{message}</p>
      <div className="form-actions">
        <button
          className="primary-button"
          disabled={save.pending || changedElsewhere}
        >
          {save.pending
            ? 'Saving…'
            : topic
              ? 'Save topic changes'
              : 'Add topic'}
        </button>
        {topic && (
          <button type="button" className="secondary-button" onClick={onDone}>
            Cancel topic edit
          </button>
        )}
      </div>
    </form>
  );
}
