import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  academicWorkBrowseResponseSchema,
  academicWorkResponseSchema,
} from '@hub/contracts';
import type {
  AcademicWork,
  AcademicWorkBrowseResponse,
  Course,
} from '@hub/contracts';
import { RequestError, getJson } from '../lib/api';
import {
  minutesLabel,
  priorityLabel,
  scoreLabel,
  workKindLabels,
  workStatusLabels,
} from '../lib/classes';
import { formatDate } from '../lib/format';
import { useMutation } from '../lib/hooks';
import { maxSelection } from '../lib/selection';
import { ChangedElsewhere, LabelSelect } from './ClassForms';
import type { useConfirm } from './ConfirmDialog';
import { DeletedItems } from './DeletedItems';
import { Help } from './Help';
import { StatusChip } from './StatusChip';
import { WorkBatchBar } from './WorkBatch';

type Confirm = ReturnType<typeof useConfirm>[1];
type BrowseStatus = AcademicWorkBrowseResponse['status'];
type Page = AcademicWorkBrowseResponse;
type Listed = Page['work'][number];

const statusFilters: Record<BrowseStatus, string> = {
  all: 'All',
  open: 'Open',
  planned: 'Planned',
  in_progress: 'In progress',
  submitted: 'Submitted',
  cancelled: 'Cancelled',
};
const pageSize = 50;
const labelText = { personal: 'Personal', restricted: 'Restricted' } as const;

/**
 * Owner-entered assignments, exams and projects for one class: a filtered,
 * paged list with full counts, individual editing, and selected changes.
 * Online only; nothing here is cached or queued offline.
 */
export function ClassWork({
  course,
  confirm,
}: {
  course: Course;
  confirm: Confirm;
}) {
  const [status, setStatus] = useState<BrowseStatus>('all');
  const [page, setPage] = useState<Page | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [addKey, setAddKey] = useState(0);
  const [notice, setNotice] = useState<{
    text: string;
    undo?: AcademicWork;
  } | null>(null);
  const [deletedKey, setDeletedKey] = useState(0);
  const [selecting, setSelecting] = useState(false);
  const [selection, setSelection] = useState(new Map<string, number>());
  const remove = useMutation();
  const restore = useMutation();
  const heading = useRef<HTMLHeadingElement>(null);
  // Only the newest read may update the list (filters can change mid-read).
  const generation = useRef(0);

  const load = useCallback(
    async (after?: NonNullable<Page['nextAfter']>) => {
      const current = ++generation.current;
      setLoading(true);
      setError('');
      const query = new URLSearchParams({
        courseId: course.id,
        courseState: 'all',
        status,
        limit: String(pageSize),
      });
      if (after) {
        query.set('after', after.id);
        query.set('expectedCursorVersion', String(after.version));
        query.set('expectedCourseVersion', String(after.courseVersion));
      }
      try {
        const result = await getJson(
          `/api/v1/academic-work/browse?${query}`,
          academicWorkBrowseResponseSchema,
        );
        if (current !== generation.current) return undefined;
        // A later page extends the list; counts come from the newest read.
        setPage((previous) =>
          after && previous
            ? { ...result, work: [...previous.work, ...result.work] }
            : result,
        );
        return result.work;
      } catch (caught) {
        if (current === generation.current)
          setError(
            after &&
              caught instanceof RequestError &&
              ['VERSION_CONFLICT', 'NOT_FOUND'].includes(caught.code)
              ? 'The list changed. Reload to see the latest.'
              : 'Work unavailable. Check the connection and reload.',
          );
        return undefined;
      } finally {
        if (current === generation.current) setLoading(false);
      }
    },
    [course.id, status],
  );
  useEffect(() => {
    setSelection(new Map());
    void load();
  }, [load]);

  const work = page?.work ?? [];
  const editTarget = work.find((item) => item.id === editing);
  const summary = page?.summary;

  async function deleteWork(item: AcademicWork) {
    const confirmed = await confirm({
      title: `Delete “${item.title}”?`,
      message:
        'Restore it from Recently deleted. Reminders cancelled by the deletion stay cancelled.',
      confirmLabel: 'Delete work',
    });
    if (!confirmed) return;
    const result = await remove.run(
      academicWorkResponseSchema,
      'DELETE',
      `/api/v1/academic-work/${item.id}`,
      { expectedVersion: item.version },
      'Could not delete. The work is unchanged.',
    );
    if (!result) return;
    setEditing(null);
    setNotice({ text: `Deleted “${item.title}”.`, undo: result.work });
    await load();
    setDeletedKey((value) => value + 1);
    heading.current?.focus();
  }

  async function undoDelete(item: AcademicWork) {
    const result = await restore.run(
      academicWorkResponseSchema,
      'POST',
      `/api/v1/academic-work/${item.id}/restore`,
      { expectedVersion: item.version },
      'Could not undo. Check the connection and try again.',
    );
    if (!result) return;
    setNotice({ text: `Restored “${item.title}”.` });
    await load();
    setDeletedKey((value) => value + 1);
  }

  async function batchApplied(text: string) {
    setNotice({ text });
    setSelecting(false);
    setSelection(new Map());
    const fresh = await load();
    if (editing && !fresh?.some((item) => item.id === editing))
      setEditing(null);
    setDeletedKey((value) => value + 1);
    heading.current?.focus();
  }

  function toggleSelected(item: AcademicWork) {
    const next = new Map(selection);
    if (next.has(item.id)) next.delete(item.id);
    else next.set(item.id, item.version);
    setSelection(next);
  }

  return (
    <section aria-label="Work">
      <div className="list-header">
        <h3 ref={heading} tabIndex={-1}>
          Work{summary ? ` (${summary.totalCount})` : ''}
        </h3>
        {work.length > 0 && (
          <button
            type="button"
            className="secondary-button"
            aria-pressed={selecting}
            onClick={() => {
              setSelecting(!selecting);
              setSelection(new Map());
            }}
          >
            Select
          </button>
        )}
      </div>
      <Help label="Work">
        Assignments, exams and projects you enter yourself. Submitted means you
        marked it submitted; scores are your own records, not a class grade.
        Estimates are full effort, not time remaining.
      </Help>
      {summary && (
        <p className="meta">
          {summary.openCount} open · {summary.submittedCount} submitted ·{' '}
          {summary.cancelledCount} cancelled · Open estimate{' '}
          {minutesLabel(summary.estimatedOpenMinutes)}
          {summary.missingDeadlineCount + summary.missingEstimateCount > 0 &&
            ` · Missing: ${summary.missingDeadlineCount} deadlines, ${summary.missingEstimateCount} estimates`}
        </p>
      )}
      <label className="work-filter">
        Status
        <select
          value={status}
          onChange={(event) => {
            setStatus(event.target.value as BrowseStatus);
            setSelecting(false);
          }}
        >
          {Object.entries(statusFilters).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <div role="status" className="work-notice">
        {notice && <p>{notice.text}</p>}
        {notice?.undo && (
          <button
            type="button"
            className="secondary-button"
            disabled={restore.pending}
            onClick={() => {
              void undoDelete(notice.undo!);
            }}
          >
            Undo
          </button>
        )}
      </div>
      {(remove.error || restore.error) && (
        <p role="alert" className="form-error">
          {remove.error || restore.error}
        </p>
      )}
      {selecting && page && (
        <WorkBatchBar
          selection={selection}
          visible={work}
          courseVersion={work[0]?.courseVersion ?? course.version}
          latest={() => load()}
          onSelect={setSelection}
          onApplied={batchApplied}
        />
      )}
      {error && (
        <div role="alert" className="form-error">
          <p>{error}</p>
          <button
            type="button"
            className="secondary-button"
            disabled={loading}
            onClick={() => {
              void load();
            }}
          >
            Reload work
          </button>
        </div>
      )}
      {loading && !page && <p role="status">Loading…</p>}
      {page && !work.length && (
        <p>{status === 'all' ? 'No work yet.' : 'No work with this status.'}</p>
      )}
      <ul className="work-list">
        {work.map((item) => (
          <WorkRow
            key={item.id}
            item={item}
            onEdit={() => setEditing(item.id)}
            selection={
              selecting
                ? {
                    selected: selection.has(item.id),
                    available:
                      selection.has(item.id) || selection.size < maxSelection,
                    toggle: () => toggleSelected(item),
                  }
                : null
            }
          />
        ))}
      </ul>
      {page?.nextAfter && (
        <button
          type="button"
          className="secondary-button"
          disabled={loading}
          onClick={() => {
            void load(page.nextAfter!);
          }}
        >
          {loading ? 'Loading…' : 'Load more'}
        </button>
      )}
      {editTarget ? (
        <WorkForm
          key={editTarget.id}
          course={course}
          work={editTarget}
          reload={() => load()}
          onDone={() => setEditing(null)}
          onDelete={(item) => {
            void deleteWork(item);
          }}
          deleting={remove.pending}
        />
      ) : (
        <WorkForm
          key={`new:${addKey}`}
          course={course}
          reload={() => load()}
          onDone={() => setAddKey((value) => value + 1)}
        />
      )}
      <DeletedItems
        kind="work"
        courseId={course.id}
        refreshKey={deletedKey}
        onRestored={() => load()}
      />
    </section>
  );
}

function WorkRow({
  item,
  onEdit,
  selection,
}: {
  item: Listed;
  onEdit: () => void;
  /** Present while choosing work for a selected change. */
  selection: {
    selected: boolean;
    available: boolean;
    toggle: () => void;
  } | null;
}) {
  const closed = item.status === 'submitted' || item.status === 'cancelled';
  return (
    <li className={selection ? 'work-row work-row--selecting' : 'work-row'}>
      {selection && (
        <input
          type="checkbox"
          aria-label={`Select ${item.title}`}
          checked={selection.selected}
          disabled={!selection.available}
          onChange={selection.toggle}
        />
      )}
      <div className="work-row__body">
        <strong className={closed ? 'work-row__title--closed' : undefined}>
          {item.title}
        </strong>
        <div className="work-row__meta">
          <span>{workKindLabels[item.kind]}</span>
          <span>
            {item.dueDate ? `Due ${formatDate(item.dueDate)}` : 'No deadline'}
          </span>
          <StatusChip>{workStatusLabels[item.status]}</StatusChip>
          <span>Priority {priorityLabel(item.priority)}</span>
          <span>{minutesLabel(item.estimatedMinutes)}</span>
          {item.grade && <span>Score {scoreLabel(item.grade)}</span>}
          {item.sensitivity !== 'unlabeled' && (
            <StatusChip>{labelText[item.sensitivity]}</StatusChip>
          )}
        </div>
      </div>
      {!selection && (
        <button
          type="button"
          className="secondary-button"
          aria-label={`Edit ${item.title}`}
          onClick={onEdit}
        >
          Edit
        </button>
      )}
    </li>
  );
}

type WorkDraft = {
  title: string;
  kind: AcademicWork['kind'];
  dueDate: string;
  estimate: string;
  priority: number;
  status: AcademicWork['status'];
  earned: string;
  possible: string;
  notes: string;
  sensitivity: AcademicWork['sensitivity'];
};
const toWorkDraft = (
  work: AcademicWork | undefined,
  sensitivity: AcademicWork['sensitivity'],
): WorkDraft => ({
  title: work?.title ?? '',
  kind: work?.kind ?? 'assignment',
  dueDate: work?.dueDate ?? '',
  estimate:
    work?.estimatedMinutes === null || work === undefined
      ? ''
      : String(work.estimatedMinutes),
  priority: work?.priority ?? 3,
  status: work?.status ?? 'planned',
  earned: work?.grade ? String(work.grade.earned) : '',
  possible: work?.grade ? String(work.grade.possible) : '',
  notes: work?.notes ?? '',
  sensitivity: work?.sensitivity ?? sensitivity,
});

/** Validated request fields, or a field error. */
function workFields(
  draft: WorkDraft,
  courseId: string,
):
  | { fields: Record<string, unknown> }
  | { field: 'title' | 'estimate' | 'score'; message: string } {
  if (!draft.title.trim()) return { field: 'title', message: 'Enter a title' };
  const estimate = Number(draft.estimate);
  if (
    draft.estimate.trim() &&
    !(Number.isInteger(estimate) && estimate >= 0 && estimate <= 60000)
  )
    return {
      field: 'estimate',
      message: 'Enter whole minutes from 0 to 60000',
    };
  let grade: { earned: number; possible: number } | null = null;
  if (
    draft.status === 'submitted' &&
    (draft.earned.trim() || draft.possible.trim())
  ) {
    const earned = Number(draft.earned);
    const possible = Number(draft.possible);
    if (
      !draft.earned.trim() ||
      !draft.possible.trim() ||
      !(earned >= 0) ||
      !(possible > 0)
    )
      return {
        field: 'score',
        message: 'Enter points earned and points possible, or leave both empty',
      };
    grade = { earned, possible };
  }
  return {
    fields: {
      courseId,
      title: draft.title,
      kind: draft.kind,
      notes: draft.notes,
      dueDate: draft.dueDate || null,
      estimatedMinutes: draft.estimate.trim() ? estimate : null,
      priority: draft.priority,
      status: draft.status,
      grade,
      sensitivity: draft.sensitivity,
    },
  };
}

/** Adds work to a class, or edits `work`. The draft keeps the version it
 *  started from; newer server data is only adopted by "Load latest". */
function WorkForm({
  course,
  work,
  reload,
  onDone,
  onDelete,
  deleting = false,
}: {
  course: Course;
  work?: AcademicWork | undefined;
  reload: () => Promise<readonly AcademicWork[] | undefined>;
  onDone: () => void;
  onDelete?: (work: AcademicWork) => void;
  deleting?: boolean;
}) {
  const [draft, setDraft] = useState(() =>
    toWorkDraft(work, course.sensitivity),
  );
  const [base, setBase] = useState(work?.version ?? 0);
  const [fieldError, setFieldError] = useState<{
    field: string;
    message: string;
  } | null>(null);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const title = useRef<HTMLInputElement>(null);
  const save = useMutation();
  const changedElsewhere = !!work && (work.version !== base || save.conflict);
  const clearsScore = !!work?.grade && draft.status !== 'submitted';
  const id = work ? `work-${work.id}` : 'work-new';
  const update = <K extends keyof WorkDraft>(field: K, value: WorkDraft[K]) => {
    setDraft({ ...draft, [field]: value });
    setMessage('');
    setFieldError(null);
  };
  const errorFor = (field: string) =>
    fieldError?.field === field ? `${id}-error` : undefined;

  async function loadLatest() {
    setLoading(true);
    const fresh = (await reload())?.find((item) => item.id === work?.id);
    setLoading(false);
    if (!fresh) return;
    setBase(fresh.version);
    save.reset();
    setMessage('Latest version loaded. Your edits are kept.');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (changedElsewhere) return;
    const result = workFields(draft, course.id);
    if ('message' in result) {
      setFieldError(result);
      if (result.field === 'title') title.current?.focus();
      return;
    }
    const saved = await save.run(
      academicWorkResponseSchema,
      work ? 'PUT' : 'POST',
      work ? `/api/v1/academic-work/${work.id}` : '/api/v1/academic-work',
      work ? { ...result.fields, expectedVersion: base } : result.fields,
    );
    if (!saved) return;
    await reload();
    onDone();
  }

  return (
    <form
      className="editor-form"
      noValidate
      aria-label={work ? 'Edit work' : 'Add work'}
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <h3>{work ? 'Edit work' : 'Add work'}</h3>
      {changedElsewhere && (
        <ChangedElsewhere
          loading={loading}
          onLoad={() => {
            void loadLatest();
          }}
        />
      )}
      <label>
        Title
        <input
          ref={title}
          value={draft.title}
          maxLength={200}
          aria-invalid={fieldError?.field === 'title'}
          aria-describedby={errorFor('title')}
          onChange={(event) => update('title', event.target.value)}
        />
      </label>
      <div className="form-row">
        <label>
          Type
          <select
            value={draft.kind}
            onChange={(event) =>
              update('kind', event.target.value as AcademicWork['kind'])
            }
          >
            {Object.entries(workKindLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Deadline
          <input
            type="date"
            value={draft.dueDate}
            onChange={(event) => update('dueDate', event.target.value)}
          />
        </label>
      </div>
      <div className="form-row">
        <label>
          Estimate (minutes)
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={60000}
            value={draft.estimate}
            aria-invalid={fieldError?.field === 'estimate'}
            aria-describedby={errorFor('estimate')}
            onChange={(event) => update('estimate', event.target.value)}
          />
        </label>
        <label>
          Priority
          <select
            value={draft.priority}
            onChange={(event) => update('priority', Number(event.target.value))}
          >
            {[5, 4, 3, 2, 1].map((value) => (
              <option key={value} value={value}>
                {priorityLabel(value)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {work && (
        <label>
          Status
          <select
            value={draft.status}
            onChange={(event) =>
              update('status', event.target.value as AcademicWork['status'])
            }
          >
            {Object.entries(workStatusLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      )}
      {draft.status === 'submitted' && (
        <fieldset className="form-row">
          <legend>Score (optional)</legend>
          <label>
            Points earned
            <input
              type="number"
              inputMode="decimal"
              min={0}
              value={draft.earned}
              aria-invalid={fieldError?.field === 'score'}
              aria-describedby={errorFor('score')}
              onChange={(event) => update('earned', event.target.value)}
            />
          </label>
          <label>
            Points possible
            <input
              type="number"
              inputMode="decimal"
              min={0}
              value={draft.possible}
              aria-invalid={fieldError?.field === 'score'}
              aria-describedby={errorFor('score')}
              onChange={(event) => update('possible', event.target.value)}
            />
          </label>
        </fieldset>
      )}
      {clearsScore && (
        <p className="calendar-warning">
          Saving clears the recorded score ({scoreLabel(work.grade!)}).
        </p>
      )}
      {fieldError && (
        <p id={`${id}-error`} className="form-error">
          <span className="visually-hidden">Error: </span>
          {fieldError.message}
        </p>
      )}
      <label>
        Notes
        <textarea
          rows={2}
          value={draft.notes}
          maxLength={10000}
          onChange={(event) => update('notes', event.target.value)}
        />
      </label>
      <LabelSelect
        label="Work content label"
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
          {save.pending ? 'Saving…' : work ? 'Save work changes' : 'Add work'}
        </button>
        {work && (
          <button type="button" className="secondary-button" onClick={onDone}>
            Cancel work edit
          </button>
        )}
        {work && onDelete && (
          <button
            type="button"
            className="danger-button"
            disabled={deleting || save.pending}
            onClick={() => onDelete(work)}
          >
            Delete work
          </button>
        )}
      </div>
    </form>
  );
}
