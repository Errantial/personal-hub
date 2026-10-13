import { useState } from 'react';
import type { FormEvent } from 'react';
import { studyGoalSchema } from '@hub/contracts';
import type { Course } from '@hub/contracts';
import { z } from 'zod';
import { getJson } from '../lib/api';
import { minutesLabel, priorityLabel } from '../lib/classes';
import { useMutation, useResource } from '../lib/hooks';
import { ChangedElsewhere } from './ClassForms';
import { Help } from './Help';
import { ReadState } from './ReadState';

type Goal = z.infer<typeof studyGoalSchema>;
const goalsSchema = z.object({ goals: z.array(studyGoalSchema) });

/** A class's weekly study goal, which the study planner uses as its budget. */
export function StudyGoal({ course }: { course: Course }) {
  const goals = useResource(
    async (signal) => ({
      data: await getJson('/api/v1/study/goals', goalsSchema, signal),
      cachedAt: null,
    }),
    { failure: 'Study goal needs a connection. Retry.' },
  );
  const find = (list: Goal[] | undefined) =>
    list?.find((goal) => goal.courseId === course.id);
  const goal = find(goals.data?.data.goals);
  return (
    <section aria-labelledby="study-goal-title" className="study-goal">
      <h4 id="study-goal-title">Weekly goal</h4>
      <Help label="Weekly goal">
        The study planner suggests up to this much time each week, ranked by
        priority, deadlines and your topic assessments. Zero turns planning off
        for this class.
      </Help>
      <ReadState resource={goals} label="study goal" />
      {goals.data && !goal && <p>Archived classes have no study goal.</p>}
      {goal && (
        <GoalForm
          courseId={course.id}
          saved={goal}
          reload={async () => find((await goals.reload())?.data.goals)}
        />
      )}
    </section>
  );
}

function GoalForm({
  courseId,
  saved,
  reload,
}: {
  courseId: string;
  saved: Goal;
  reload: () => Promise<Goal | undefined>;
}) {
  const [minutes, setMinutes] = useState(String(saved.minutesPerWeek));
  const [priority, setPriority] = useState(saved.priority);
  const [targetDate, setTargetDate] = useState(saved.targetDate ?? '');
  const [base, setBase] = useState(saved.version);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const save = useMutation();
  const changed = () => {
    setError('');
    setMessage('');
  };

  async function loadLatest() {
    setLoading(true);
    const fresh = await reload();
    setLoading(false);
    if (!fresh) return;
    setBase(fresh.version);
    save.reset();
    setMessage('Latest version loaded. Your edits are kept.');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (save.conflict) return;
    const value = Number(minutes);
    if (
      !minutes.trim() ||
      !Number.isInteger(value) ||
      value < 0 ||
      value > 2400
    )
      return setError('Enter whole minutes from 0 to 2400');
    const result = await save.run(
      studyGoalSchema,
      'PUT',
      `/api/v1/study/goals/${courseId}`,
      {
        minutesPerWeek: value,
        priority,
        targetDate: targetDate || null,
        expectedVersion: base,
      },
    );
    if (!result) return;
    setBase(result.version);
    setMessage(
      result.minutesPerWeek
        ? `Goal saved: ${minutesLabel(result.minutesPerWeek)} a week.`
        : 'Goal saved. Planning is off for this class.',
    );
  }

  return (
    <form
      className="editor-form"
      noValidate
      aria-label="Weekly goal"
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      {save.conflict && (
        <ChangedElsewhere
          loading={loading}
          onLoad={() => {
            void loadLatest();
          }}
        />
      )}
      <div className="form-row">
        <label>
          Minutes per week
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={2400}
            step={5}
            value={minutes}
            aria-invalid={!!error}
            aria-describedby={error ? 'study-goal-error' : undefined}
            onChange={(event) => {
              setMinutes(event.target.value);
              changed();
            }}
          />
        </label>
        <label>
          Study priority
          <select
            value={priority}
            onChange={(event) => {
              setPriority(Number(event.target.value));
              changed();
            }}
          >
            {[5, 4, 3, 2, 1].map((value) => (
              <option key={value} value={value}>
                {priorityLabel(value)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Target date (optional)
          <input
            type="date"
            value={targetDate}
            onChange={(event) => {
              setTargetDate(event.target.value);
              changed();
            }}
          />
        </label>
      </div>
      {error && (
        <p id="study-goal-error" className="form-error">
          <span className="visually-hidden">Error: </span>
          {error}
        </p>
      )}
      {save.error && !save.conflict && (
        <p role="alert" className="form-error">
          {save.error}
        </p>
      )}
      <p role="status">{message}</p>
      <div className="form-actions">
        <button
          className="primary-button"
          disabled={save.pending || save.conflict}
        >
          {save.pending ? 'Saving…' : 'Save weekly goal'}
        </button>
      </div>
    </form>
  );
}
