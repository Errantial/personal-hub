import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  trackedDeadlineResponseSchema,
  type TrackedDeadline,
} from '@hub/contracts';
import { getJson } from '../lib/api';
import {
  deadlineDueDraft,
  deadlineDueOverride,
  deadlinePersonalDueDraft,
  deadlineProviderDueDraft,
  dueLabel,
  safeCanvasHref,
} from '../lib/deadlines';
import type { DeadlineDueDraft } from '../lib/deadlines';
import { useMutation, useOnline, useResource } from '../lib/hooks';
import type { Route } from '../lib/router';
import { Help } from './Help';
import { Link } from './Link';
import { StatusChip } from './StatusChip';
import { TaskDueFields } from './TaskDueFields';

type TasksRoute = Extract<Route, { name: 'tasks' }>;
type Draft = {
  titleOverride: string;
  due: DeadlineDueDraft;
  priority: TrackedDeadline['priority'];
  notes: string;
  sensitivity: TrackedDeadline['sensitivity'];
};

const toDraft = (deadline: TrackedDeadline): Draft => ({
  titleOverride: deadline.titleOverride ?? '',
  due: deadlineDueDraft(deadline),
  priority: deadline.priority,
  notes: deadline.notes,
  sensitivity: deadline.sensitivity,
});

const sourceKindLabels: Record<
  TrackedDeadline['sources'][number]['kind'],
  string
> = {
  'calendar-feed': 'Calendar feed',
  'calendar-file': 'Calendar file',
  'assignment-api': 'Canvas API',
  browser: 'Browser collector',
};

function draftDueLabel(draft: DeadlineDueDraft) {
  if (draft.mode === 'provider') return 'using Canvas value';
  try {
    return dueLabel(deadlineDueOverride(draft) as TrackedDeadline['due']);
  } catch {
    return 'Review the Personal Hub due override';
  }
}

export function DeadlineEditor({
  id,
  listRoute,
  navigate,
  onChanged,
}: {
  id: string;
  listRoute: TasksRoute;
  navigate: (route: Route) => void;
  onChanged: () => Promise<unknown>;
}) {
  const resource = useResource(
    (signal) =>
      getJson(`/api/v1/deadlines/${id}`, trackedDeadlineResponseSchema, signal),
    { failure: 'Imported deadline unavailable. Retry.', key: id },
  );
  const latest = resource.data?.deadline;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [base, setBase] = useState(0);
  const [message, setMessage] = useState('');
  const [titleError, setTitleError] = useState('');
  const title = useRef<HTMLInputElement>(null);
  const save = useMutation();
  const completion = useMutation();
  const online = useOnline();

  useEffect(() => {
    if (!latest || draft) return;
    setDraft(toDraft(latest));
    setBase(latest.version);
  }, [latest, draft]);

  const changedElsewhere =
    !!latest &&
    (latest.version !== base || save.conflict || completion.conflict);
  const blocked = !online || changedElsewhere;

  async function loadLatest() {
    const result = await resource.reload();
    const fresh = result?.deadline;
    if (!fresh) return;
    setBase(fresh.version);
    save.reset();
    completion.reset();
    setMessage('Latest version loaded. Your edits are kept.');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || !latest || blocked) return;
    if (draft.titleOverride && !draft.titleOverride.trim()) {
      setTitleError('Enter a title or clear the override');
      title.current?.focus();
      return;
    }
    let dueOverride;
    try {
      dueOverride = deadlineDueOverride(draft.due);
    } catch (error) {
      save.setError(
        error instanceof Error ? error.message : 'Choose a valid due value.',
      );
      return;
    }
    const result = await save.run(
      trackedDeadlineResponseSchema,
      'PUT',
      `/api/v1/deadlines/${id}`,
      {
        expectedVersion: base,
        titleOverride: draft.titleOverride.trim() || null,
        priority: draft.priority,
        notes: draft.notes,
        dueOverride,
        sensitivity: draft.sensitivity,
      },
      'Could not save this imported deadline. Your edits are still here.',
    );
    if (!result) return;
    setDraft(toDraft(result.deadline));
    setBase(result.deadline.version);
    setMessage('Saved in Personal Hub. Canvas was not changed.');
    await onChanged();
    await resource.reload();
  }

  async function changeCompletion() {
    if (!latest || blocked) return;
    const completed = !!latest.completedAt;
    const result = await completion.run(
      trackedDeadlineResponseSchema,
      'POST',
      `/api/v1/deadlines/${id}/${completed ? 'reopen' : 'complete'}`,
      { expectedVersion: base },
      'Could not update completion. Reload this imported deadline and try again.',
    );
    if (!result) return;
    setBase(result.deadline.version);
    setMessage(
      completed
        ? 'Reopened in Personal Hub. Canvas was not changed.'
        : 'Completed in Personal Hub. Canvas submission was not changed.',
    );
    await onChanged();
    await resource.reload();
  }

  if (!draft || !latest)
    return (
      <section
        className="panel deadline-editor"
        aria-label="Imported deadline editor"
      >
        <BackLink route={listRoute} navigate={navigate} />
        {resource.loading ? (
          <p role="status">Loading…</p>
        ) : resource.error ? (
          <>
            <p role="alert">{resource.error}</p>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                void resource.reload();
              }}
            >
              Retry imported deadline
            </button>
          </>
        ) : (
          <p>This imported deadline is not available.</p>
        )}
      </section>
    );

  const canvasHref = safeCanvasHref(latest.sourceUrl);
  const completed = !!latest.completedAt;
  return (
    <section
      className="panel deadline-editor"
      aria-labelledby="deadline-editor-title"
    >
      <BackLink route={listRoute} navigate={navigate} />
      <div className="deadline-editor__heading">
        <h2 id="deadline-editor-title">Edit imported deadline</h2>
        <Help label="Imported deadline editing">
          Personal Hub keeps these edits and completion separately from Canvas.
          Saving here never submits, reopens, reschedules or edits the
          assignment in Canvas.
        </Help>
      </div>
      <p className="deadline-editor__boundary">
        Edits and completion are local to Personal Hub. Nothing here submits or
        reopens Canvas work.
      </p>
      {!online && (
        <p role="alert" className="form-error">
          Imported deadline changes need a connection. Your draft stays here.
        </p>
      )}
      {changedElsewhere && (
        <div role="alert" className="form-error">
          <p>Changed elsewhere. Your edits are still here.</p>
          <button
            type="button"
            className="secondary-button"
            disabled={resource.loading}
            onClick={() => {
              void loadLatest();
            }}
          >
            Load latest version
          </button>
        </div>
      )}
      {(latest.sourceConflict || latest.sourceAvailability !== 'available') && (
        <p role="status" className="deadline-editor__source-status">
          {latest.sourceConflict
            ? 'Canvas sources disagree. Review their values before changing the Personal Hub override.'
            : `Canvas source is ${latest.sourceAvailability}. The last imported facts stay visible.`}
        </p>
      )}
      <form
        className="editor-form"
        noValidate
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <label>
          Personal Hub title override (optional)
          <input
            ref={title}
            maxLength={200}
            value={draft.titleOverride}
            aria-invalid={!!titleError || undefined}
            aria-describedby={titleError ? 'deadline-title-error' : undefined}
            disabled={save.pending}
            placeholder={
              latest.sources.find((source) => source.primary)?.title ?? ''
            }
            onChange={(event) => {
              setDraft({ ...draft, titleOverride: event.target.value });
              setTitleError('');
              setMessage('');
            }}
          />
        </label>
        {titleError && (
          <p id="deadline-title-error" className="form-error">
            <span className="visually-hidden">Error: </span>
            {titleError}
          </p>
        )}
        <fieldset className="deadline-editor__due-mode">
          <legend>Due value</legend>
          <label>
            <input
              type="radio"
              name="deadline-due-mode"
              checked={draft.due.mode === 'provider'}
              disabled={save.pending}
              onChange={() =>
                setDraft({ ...draft, due: deadlineProviderDueDraft(latest) })
              }
            />
            Use Canvas value
          </label>
          <label>
            <input
              type="radio"
              name="deadline-due-mode"
              checked={draft.due.mode === 'personal'}
              disabled={save.pending}
              onChange={() =>
                setDraft({
                  ...draft,
                  due: deadlinePersonalDueDraft(latest.due),
                })
              }
            />
            Personal Hub due override
          </label>
        </fieldset>
        {draft.due.mode === 'personal' && (
          <TaskDueFields
            value={draft.due.value}
            disabled={save.pending}
            onChange={(value) => {
              setDraft({ ...draft, due: { mode: 'personal', value } });
              setMessage('');
              save.setError('');
            }}
          />
        )}
        <p className="meta">
          Canvas source due: {dueLabel(latest.providerDue)} · Personal Hub:{' '}
          {draftDueLabel(draft.due)}
        </p>
        {draft.due.mode === 'personal' && (
          <button
            type="button"
            className="text-button"
            disabled={save.pending}
            onClick={() =>
              setDraft({ ...draft, due: deadlineProviderDueDraft(latest) })
            }
          >
            Use Canvas value
          </button>
        )}
        {latest.alternateTimedDue && (
          <button
            type="button"
            className="text-button"
            disabled={save.pending}
            onClick={() =>
              setDraft({
                ...draft,
                due: deadlinePersonalDueDraft(latest.alternateTimedDue!),
              })
            }
          >
            Use alternate Canvas time ({dueLabel(latest.alternateTimedDue)})
          </button>
        )}
        <label>
          Priority
          <select
            value={draft.priority}
            disabled={save.pending}
            onChange={(event) =>
              setDraft({
                ...draft,
                priority: event.target.value as TrackedDeadline['priority'],
              })
            }
          >
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
          </select>
        </label>
        <label>
          Notes (optional)
          <textarea
            rows={4}
            maxLength={10000}
            value={draft.notes}
            disabled={save.pending}
            onChange={(event) =>
              setDraft({ ...draft, notes: event.target.value })
            }
          />
        </label>
        <label>
          Content label
          <select
            value={draft.sensitivity}
            disabled={save.pending}
            onChange={(event) =>
              setDraft({
                ...draft,
                sensitivity: event.target
                  .value as TrackedDeadline['sensitivity'],
              })
            }
          >
            <option value="unlabeled">Unlabeled</option>
            <option value="personal">Personal</option>
            <option value="restricted">Restricted</option>
          </select>
        </label>
        <Help label="Imported deadline content label">
          Your label combines with retained Canvas source labels. The effective
          label is {latest.effectiveSensitivity}.
        </Help>
        {save.error && !changedElsewhere && (
          <p role="alert" className="form-error">
            {save.error}
          </p>
        )}
        <p role="status">{message}</p>
        <div className="form-actions">
          <button className="primary-button" disabled={save.pending || blocked}>
            {save.pending ? 'Saving…' : 'Save Personal Hub changes'}
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={completion.pending || blocked}
            onClick={() => {
              void changeCompletion();
            }}
          >
            {completion.pending
              ? 'Saving…'
              : completed
                ? 'Reopen in Personal Hub'
                : 'Mark complete in Personal Hub'}
          </button>
        </div>
        {completion.error && !changedElsewhere && (
          <p role="alert" className="form-error">
            {completion.error}
          </p>
        )}
      </form>

      <details
        open={latest.sourceConflict}
        className="deadline-editor__sources"
      >
        <summary>
          Canvas source values{latest.sourceConflict ? ' · Conflict' : ''}
        </summary>
        <p>
          Effective Canvas title:{' '}
          {latest.sources.find((source) => source.primary)?.title ??
            'Unavailable'}
        </p>
        <p>Canvas source due: {dueLabel(latest.providerDue)}</p>
        <ul className="deadline-source-list">
          {latest.sources.map((source) => (
            <li key={`${source.kind}:${source.sourceId}`}>
              <strong>
                {sourceKindLabels[source.kind]}
                {source.primary ? ' · Primary' : ''}
              </strong>
              <span>{source.title}</span>
              <span>{dueLabel(source.due)}</span>
              <span>
                {source.availability} · version {source.capturedVersion}{' '}
                captured, {source.currentVersion} current
              </span>
              {!source.identityMatches && (
                <StatusChip tone="danger">Canvas identity changed</StatusChip>
              )}
            </li>
          ))}
        </ul>
      </details>
      {canvasHref ? (
        <a
          className="link-button"
          href={canvasHref}
          target="_blank"
          rel="noreferrer"
        >
          Open in Canvas
        </a>
      ) : latest.sourceUrl ? (
        <p className="meta">Canvas link unavailable.</p>
      ) : null}
      <button
        type="button"
        className="text-button"
        disabled={resource.loading}
        onClick={() => {
          void loadLatest();
        }}
      >
        Reload imported deadline
      </button>
    </section>
  );
}

function BackLink({
  route,
  navigate,
}: {
  route: TasksRoute;
  navigate: (route: Route) => void;
}) {
  return (
    <Link className="task-editor__back" route={route} navigate={navigate}>
      Back to tasks
    </Link>
  );
}
