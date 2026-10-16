import { useCallback, useEffect, useState } from 'react';
import {
  Temporal,
  studyPlanSchema,
  studyPlansResponseSchema,
  studyPreviewSchema,
  studyProgressSchema,
  assistantTurnResponseSchema,
} from '@hub/contracts';
import type { StudyPlan, StudyPreview, StudySlot } from '@hub/contracts';
import { getJson, requestJson, liveRequestJson } from '../lib/api';
import { ReadState } from './ReadState';
import { minutesLabel } from '../lib/classes';
import { formatDate, formatInstant } from '../lib/format';
import { useMutation, useResource, useToday } from '../lib/hooks';
import type { Route } from '../lib/router';
import {
  rangeEnd,
  reasonText,
  slotKey,
  slotMinutes,
  slotTime,
  slotsByDay,
  warningText,
} from '../lib/study';
import { useConfirm } from './ConfirmDialog';
import { Help } from './Help';
import { Link } from './Link';
import { StatusChip } from './StatusChip';

type Navigate = (route: Route) => void;
type AssistantRef = { turnId: string; suggestionId: string };
type Range = { from: string; to: string; assistant?: AssistantRef };

const statusText: Record<StudyPlan['status'], string> = {
  draft: 'Draft',
  approved: 'Approved',
  cancelled: 'Cancelled',
};

/** A fresh preview for a range; previews never write anything. */
const preview = (range: Range) =>
  requestJson('/api/v1/study/preview', studyPreviewSchema, {
    method: 'POST',
    body: range,
  });
const errorText = (caught: unknown, fallback: string) =>
  caught instanceof Error && caught.message ? caught.message : fallback;

/**
 * Classes › Study plan: preview suggested study blocks, save a draft, trim
 * it, and approve it into Calendar. Nothing is scheduled until approval.
 * Online only.
 */
export function StudyPlanView({
  navigate,
  assistant,
}: {
  navigate: Navigate;
  assistant?: AssistantRef;
}) {
  return assistant ? (
    <SuggestionPlan
      key={`${assistant.turnId}:${assistant.suggestionId}`}
      navigate={navigate}
      assistant={assistant}
    />
  ) : (
    <StudyPlanEditor navigate={navigate} />
  );
}

function SuggestionPlan({
  navigate,
  assistant,
}: {
  navigate: Navigate;
  assistant: AssistantRef;
}) {
  const resource = useResource(
    (signal) =>
      liveRequestJson(
        `/api/v1/assistant/turns/${assistant.turnId}`,
        assistantTurnResponseSchema,
        { signal },
      ),
    {
      failure: 'The study suggestion needs a connection.',
      key: assistant.turnId,
    },
  );
  const suggestion =
    resource.data?.turn.proposalAccess === 'applicable' &&
    resource.data.turn.trigger === 'owner'
      ? resource.data.turn.studySuggestions?.find(
          (s) => s.id === assistant.suggestionId,
        )
      : undefined;
  return (
    <>
      <ReadState
        resource={{ ...resource, data: undefined }}
        label="Study suggestion"
      />
      {resource.data && !suggestion && (
        <p role="alert">This study suggestion is no longer available.</p>
      )}
      {suggestion && (
        <StudyPlanEditor
          key={suggestion.id}
          navigate={navigate}
          initial={{ from: suggestion.from, to: suggestion.to, assistant }}
        />
      )}
    </>
  );
}

function StudyPlanEditor({
  navigate,
  initial,
}: {
  navigate: Navigate;
  initial?: Range;
}) {
  const today = useToday(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [from, setFrom] = useState(initial?.from ?? today);
  const [days, setDays] = useState(
    initial
      ? Temporal.PlainDate.from(initial.from).until(
          Temporal.PlainDate.from(initial.to),
        ).days
      : 7,
  );
  const range: Range = {
    from,
    to: rangeEnd(from, days),
    ...(initial?.assistant ? { assistant: initial.assistant } : {}),
  };
  const [historyKey, setHistoryKey] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const showPlan = (plan: StudyPlan) => {
    setHistoryKey((value) => value + 1);
    setOpenId(plan.id);
  };

  return (
    <section
      className="panel class-detail study-plan"
      aria-labelledby="study-plan-title"
    >
      <Link
        className="class-detail__back"
        route={{ name: 'classes' }}
        navigate={navigate}
      >
        Back to classes
      </Link>
      <h2 id="study-plan-title">Study plan</h2>
      <Help label="Study plan">
        Suggestions fill your weekly goals inside your study availability,
        around your planner calendar, highest-ranked classes first. Save a
        draft, remove blocks you do not want, then approve it to add the blocks
        to Calendar. Approved blocks are ordinary study events you can edit.
        Weekly goals are set in each class’s Study blocks.
        {initial?.assistant &&
          ' The suggested range stays fixed to its saved answer. Open a manual study plan to choose different dates.'}
      </Help>
      <Link
        className="study-plan__settings"
        route={{ name: 'settings', section: 'study' }}
        navigate={navigate}
      >
        Study availability settings
      </Link>
      <form
        className="form-row study-plan__range"
        aria-label="Plan dates"
        onSubmit={(event) => event.preventDefault()}
      >
        <label>
          Starting
          <input
            disabled={!!initial?.assistant}
            type="date"
            value={from}
            onChange={(event) => {
              if (event.target.value) setFrom(event.target.value);
            }}
          />
        </label>
        <label>
          Length
          <select
            disabled={!!initial?.assistant}
            value={days}
            onChange={(event) => setDays(Number(event.target.value))}
          >
            <option value={7}>7 days</option>
            <option value={14}>14 days</option>
            {days !== 7 && days !== 14 && (
              <option value={days}>
                {days} {days === 1 ? 'day' : 'days'}
              </option>
            )}
          </select>
        </label>
      </form>
      <PreviewSection
        key={`${range.from}:${range.to}`}
        range={range}
        onSaved={showPlan}
      />
      <PlanHistory
        refreshKey={historyKey}
        openId={openId}
        onOpen={setOpenId}
        navigate={navigate}
      />
      <ProgressSection range={range} />
    </section>
  );
}

function PreviewSection({
  range,
  onSaved,
}: {
  range: Range;
  onSaved: (plan: StudyPlan) => void;
}) {
  const [result, setResult] = useState<StudyPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const save = useMutation();

  async function load() {
    setLoading(true);
    setError('');
    save.reset();
    try {
      setResult(await preview(range));
    } catch (caught) {
      setError(errorText(caught, 'Preview needs a connection. Try again.'));
    } finally {
      setLoading(false);
    }
  }

  async function saveDraft() {
    if (!result) return;
    const plan = await save.run(
      studyPlanSchema,
      'POST',
      '/api/v1/study/plans',
      { ...range, expectedContextRevision: result.contextRevision },
      'Could not save the draft. Try again.',
    );
    if (!plan) return;
    setResult(null);
    onSaved(plan);
  }

  return (
    <section aria-labelledby="study-preview-title">
      <h3 id="study-preview-title">
        Preview · {formatDate(range.from)} to{' '}
        {formatDate(
          Temporal.PlainDate.from(range.to).subtract({ days: 1 }).toString(),
        )}
      </h3>
      <button
        type="button"
        className="primary-button"
        disabled={loading}
        onClick={() => {
          void load();
        }}
      >
        {loading ? 'Previewing…' : result ? 'Preview again' : 'Preview plan'}
      </button>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {result && (
        <>
          <PlanContents preview={result} />
          {save.error && (
            <p role="alert" className="form-error">
              {save.code === 'STUDY_CONTEXT_CONFLICT'
                ? 'Something changed since this preview. Preview again before saving.'
                : save.error}
            </p>
          )}
          <button
            type="button"
            className="secondary-button"
            disabled={
              !result.slots.length || save.pending || loading || !!error
            }
            onClick={() => {
              void saveDraft();
            }}
          >
            {save.pending ? 'Saving…' : 'Save as draft'}
          </button>
        </>
      )}
    </section>
  );
}

/** Warnings, ranking and (optionally removable) blocks of a preview. */
function PlanContents({
  preview: shown,
  slots = shown.slots,
  onRemove,
}: {
  preview: StudyPreview;
  slots?: readonly StudySlot[];
  onRemove?: (slot: StudySlot) => void;
}) {
  const names = new Map(
    shown.priorities.map((item) => [item.courseId, item.courseName]),
  );
  const topics = new Map(
    shown.priorities
      .filter((item) => item.topicId)
      .map((item) => [item.topicId!, item.topicName]),
  );
  const ranked = shown.priorities.filter((item) => item.targetMinutes > 0);
  return (
    <div className="study-plan__contents">
      {shown.warnings.length > 0 && (
        <ul className="study-plan__warnings" aria-label="Plan warnings">
          {shown.warnings.map((warning) => (
            <li key={warning} className="calendar-warning">
              {warningText[warning]}
            </li>
          ))}
        </ul>
      )}
      {ranked.length > 0 && (
        <details>
          <summary>Why this order</summary>
          <ol className="study-plan__ranking">
            {ranked.map((item) => (
              <li key={item.courseId}>
                <strong>{item.courseName}</strong>
                {item.topicName && ` · ${item.topicName}`}:{' '}
                {minutesLabel(item.remainingMinutes)} of{' '}
                {minutesLabel(item.targetMinutes)} still to plan.{' '}
                {item.reasons.length > 0 &&
                  `Ranked by ${item.reasons.map((reason) => reasonText[reason]).join(', ')}.`}
              </li>
            ))}
          </ol>
        </details>
      )}
      <p>
        {slots.length
          ? `${slots.length} block${slots.length === 1 ? '' : 's'} · ${minutesLabel(slotMinutes(slots))} · times in ${shown.timeZone}`
          : 'No study blocks fit this range.'}
      </p>
      {slotsByDay(slots, shown.timeZone).map(({ day, slots: items }) => (
        <section key={day} aria-label={formatDate(day)}>
          <h4>{formatDate(day)}</h4>
          <ul className="study-list">
            {items.map((slot) => {
              const label = `${slotTime(slot, shown.timeZone)} ${names.get(slot.courseId) ?? 'Class'}`;
              return (
                <li key={slotKey(slot)} className="study-plan__slot">
                  <span>
                    <strong>{slotTime(slot, shown.timeZone)}</strong>{' '}
                    {names.get(slot.courseId) ?? 'Class'}
                    {slot.topicId && topics.get(slot.topicId)
                      ? ` · ${topics.get(slot.topicId)}`
                      : ''}
                  </span>
                  {onRemove && (
                    <button
                      type="button"
                      className="secondary-button"
                      aria-label={`Remove ${label}`}
                      onClick={() => onRemove(slot)}
                    >
                      Remove
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

function PlanHistory({
  refreshKey,
  openId,
  onOpen,
  navigate,
}: {
  refreshKey: number;
  openId: string | null;
  onOpen: (id: string | null) => void;
  navigate: Navigate;
}) {
  const [plans, setPlans] = useState<StudyPlan[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (before?: string) => {
    setLoading(true);
    setError('');
    try {
      const query = new URLSearchParams({ limit: '20' });
      if (before) query.set('before', before);
      const page = await getJson(
        `/api/v1/study/plans?${query}`,
        studyPlansResponseSchema,
      );
      setPlans((previous) =>
        before ? [...(previous ?? []), ...page.plans] : page.plans,
      );
      setNext(page.nextBefore);
      return page.plans;
    } catch {
      setError('Plans need a connection. Reload to try again.');
      return undefined;
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const open = plans?.find((plan) => plan.id === openId);
  return (
    <section aria-labelledby="study-plans-title">
      <h3 id="study-plans-title">Plans</h3>
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
            Reload plans
          </button>
        </div>
      )}
      {loading && !plans && <p role="status">Loading…</p>}
      {plans && !plans.length && <p>No saved plans.</p>}
      <ul className="study-list">
        {(plans ?? []).map((plan) => (
          <li
            key={plan.id}
            aria-current={plan.id === openId ? 'true' : undefined}
          >
            <button
              type="button"
              className="text-button study-plan__open"
              aria-expanded={plan.id === openId}
              onClick={() => onOpen(plan.id === openId ? null : plan.id)}
            >
              {formatDate(plan.preview.from)} plan
            </button>
            <div className="study-list__meta">
              <StatusChip
                tone={plan.status === 'draft' ? 'attention' : 'neutral'}
              >
                {statusText[plan.status]}
              </StatusChip>
              <span>
                {plan.preview.slots.length} blocks ·{' '}
                {minutesLabel(slotMinutes(plan.preview.slots))}
              </span>
              <span>Saved {formatInstant(plan.updatedAt)}</span>
            </div>
            {plan.id === openId && open && (
              <PlanDetail
                key={`${open.id}:${open.version}`}
                plan={open}
                reload={async () =>
                  (await load())?.find((item) => item.id === open.id)
                }
                onHidden={() => {
                  onOpen(null);
                  void load();
                }}
                navigate={navigate}
              />
            )}
          </li>
        ))}
      </ul>
      {next && (
        <button
          type="button"
          className="secondary-button"
          disabled={loading}
          onClick={() => {
            void load(next);
          }}
        >
          Load more plans
        </button>
      )}
    </section>
  );
}

function PlanDetail({
  plan,
  reload,
  onHidden,
  navigate,
}: {
  plan: StudyPlan;
  reload: () => Promise<StudyPlan | undefined>;
  onHidden: () => void;
  navigate: Navigate;
}) {
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [rechecking, setRechecking] = useState(false);
  const [recheckError, setRecheckError] = useState('');
  const edit = useMutation();
  const action = useMutation();
  const [dialog, confirm] = useConfirm();
  const draft = plan.status === 'draft';
  const slots = plan.preview.slots.filter(
    (slot) => !removed.has(slotKey(slot)),
  );
  const failed = edit.error || action.error || recheckError;
  const failedCode = edit.code || action.code;

  /** Saves the remaining blocks against current calendar, goals and work. */
  async function saveSlots() {
    setRechecking(true);
    setRecheckError('');
    let revision: string;
    try {
      revision = (
        await preview({
          from: plan.preview.from,
          to: plan.preview.to,
          ...(plan.assistant ? { assistant: plan.assistant } : {}),
        })
      ).contextRevision;
    } catch (caught) {
      setRecheckError(errorText(caught, 'Recheck needs a connection.'));
      return;
    } finally {
      setRechecking(false);
    }
    const saved = await edit.run(
      studyPlanSchema,
      'PUT',
      `/api/v1/study/plans/${plan.id}`,
      {
        expectedVersion: plan.version,
        expectedContextRevision: revision,
        slots,
      },
      'Could not save the draft. Try again.',
    );
    if (!saved) return;
    await reload();
  }

  async function act(kind: 'approve' | 'cancel' | 'hide') {
    if (
      kind === 'cancel' &&
      !(await confirm({
        title: 'Cancel this plan?',
        message:
          'Its planned blocks you have not changed are cancelled. Blocks you edited, completed or deleted are kept as they are.',
        confirmLabel: 'Cancel plan',
      }))
    )
      return;
    const result = await action.run(
      studyPlanSchema,
      kind === 'hide' ? 'DELETE' : 'POST',
      `/api/v1/study/plans/${plan.id}${kind === 'hide' ? '' : `/${kind}`}`,
      { expectedVersion: plan.version },
      'Could not update the plan. Try again.',
    );
    if (!result) return;
    if (kind === 'hide') return onHidden();
    await reload();
  }

  return (
    <div className="study-plan__detail">
      {plan.status === 'approved' && (
        <p>
          Added {plan.eventLinks.length} study blocks to{' '}
          <Link
            route={{ name: 'calendar', date: plan.preview.from }}
            navigate={navigate}
          >
            Calendar
          </Link>
          .
        </p>
      )}
      {plan.status === 'cancelled' && plan.eventLinks.length > 0 && (
        <p>
          {plan.preservedEventIds.length
            ? `${plan.preservedEventIds.length} block${plan.preservedEventIds.length === 1 ? ' was' : 's were'} kept because you changed ${plan.preservedEventIds.length === 1 ? 'it' : 'them'}; the rest were cancelled.`
            : 'All of its planned blocks were cancelled.'}
        </p>
      )}
      <PlanContents
        preview={plan.preview}
        slots={slots}
        {...(draft
          ? {
              onRemove: (slot: StudySlot) => {
                setRemoved(new Set([...removed, slotKey(slot)]));
                edit.reset();
                action.reset();
              },
            }
          : {})}
      />
      {failed && (
        <div role="alert" className="form-error">
          <p>{failed}</p>
          {(failedCode === 'VERSION_CONFLICT' ||
            failedCode === 'STUDY_PLAN_STATE') && (
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                edit.reset();
                action.reset();
                void reload();
              }}
            >
              Reload plan
            </button>
          )}
        </div>
      )}
      <div className="form-actions">
        {draft && removed.size > 0 && (
          <button
            type="button"
            className="primary-button"
            disabled={edit.pending || rechecking || !slots.length}
            onClick={() => {
              void saveSlots();
            }}
          >
            {edit.pending || rechecking ? 'Saving…' : 'Save draft changes'}
          </button>
        )}
        {draft && !removed.size && (
          <>
            <button
              type="button"
              className="primary-button"
              disabled={action.pending || !slots.length}
              onClick={() => {
                void act('approve');
              }}
            >
              {action.pending ? 'Approving…' : 'Approve plan'}
            </button>
            {(failedCode === 'STUDY_CONTEXT_CONFLICT' ||
              failedCode === 'STUDY_WORKLOAD_UNCAPTURED') && (
              <button
                type="button"
                className="secondary-button"
                disabled={edit.pending || rechecking}
                onClick={() => {
                  action.reset();
                  void saveSlots();
                }}
              >
                Recheck draft
              </button>
            )}
          </>
        )}
        {plan.status === 'approved' && (
          <button
            type="button"
            className="danger-button"
            disabled={action.pending}
            onClick={() => {
              void act('cancel');
            }}
          >
            Cancel plan
          </button>
        )}
        {plan.status !== 'approved' && (
          <button
            type="button"
            className="secondary-button"
            disabled={action.pending}
            onClick={() => {
              void act('hide');
            }}
          >
            Hide plan
          </button>
        )}
      </div>
      {dialog}
    </div>
  );
}

function ProgressSection({ range }: { range: Range }) {
  const progress = useResource(
    (signal) =>
      getJson(
        `/api/v1/study/progress?${new URLSearchParams({ from: range.from, to: range.to })}`,
        studyProgressSchema,
        signal,
      ),
    {
      failure: 'Progress needs a connection.',
      key: `${range.from}:${range.to}`,
    },
  );
  const courses = (progress.data?.courses ?? []).filter(
    (course) =>
      course.targetMinutes > 0 ||
      course.plannedMinutes > 0 ||
      course.completedMinutes > 0,
  );
  return (
    <section aria-labelledby="study-progress-title">
      <h3 id="study-progress-title">Progress for these dates</h3>
      <Help label="Progress">
        Completed means you marked the study block done; it does not measure
        attendance or mastery. Targets are weekly goals for these dates.
      </Help>
      {progress.error && (
        <p role="alert" className="form-error">
          {progress.error}
        </p>
      )}
      {progress.data && !courses.length && <p>No goals or study time yet.</p>}
      <ul className="study-list">
        {courses.map((course) => (
          <li key={course.courseId}>
            <strong>{course.courseName}</strong>
            <div className="study-list__meta">
              <span>
                Target {minutesLabel(Math.round(course.targetMinutes))}
              </span>
              <span>
                Planned {minutesLabel(Math.round(course.plannedMinutes))}
              </span>
              <span>
                Completed {minutesLabel(Math.round(course.completedMinutes))}
              </span>
              {course.cancelledMinutes > 0 && (
                <span>
                  Cancelled {minutesLabel(Math.round(course.cancelledMinutes))}
                </span>
              )}
              {course.completionPercent !== null && (
                <StatusChip>
                  {Math.round(course.completionPercent)}% done
                </StatusChip>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
