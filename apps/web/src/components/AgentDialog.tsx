import { useEffect, useId, useRef, useState } from 'react';
import {
  agentCapRange,
  agentResponseSchema,
  agentRunResponseSchema,
  agentTemplates,
  responsibilityMutationResponseSchema,
} from '@hub/contracts';
import type { Agent, AgentSchedule, AgentTemplate } from '@hub/contracts';
import { RequestError, liveRequestJson } from '../lib/api';
import { formatCost } from '../lib/assistant';
import { useOnline } from '../lib/hooks';
import { operationTracker } from '../lib/operations';
import { useConfirm } from './ConfirmDialog';
import { Help } from './Help';
import { TimeZoneInput } from './TimeZoneInput';
import './AgentDialog.css';

const templates: { value: AgentTemplate; label: string }[] = [
  { value: 'daily-plan', label: 'Daily plan' },
  { value: 'mail-triage', label: 'Mail triage' },
  { value: 'deadline-watch', label: 'Deadline watch' },
  { value: 'custom', label: 'Custom' },
];
const weekdays = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];
const deviceZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

type Draft = {
  template: AgentTemplate;
  title: string;
  goal: string;
  frequency: AgentSchedule['frequency'];
  weekday: number;
  times: string[];
  useMail: boolean;
  cap: string;
  timeZone: string;
};
function fromTemplate(template: AgentTemplate, timeZone: string): Draft {
  const preset = template === 'custom' ? null : agentTemplates[template];
  return {
    template,
    title: preset?.title ?? '',
    goal: preset?.goal ?? '',
    frequency: preset?.schedule.frequency ?? 'daily',
    weekday: 1,
    times: preset ? [...preset.schedule.times] : ['09:00'],
    useMail: preset?.useMail ?? false,
    cap: '2.00',
    timeZone,
  };
}
const fromAgent = (agent: Agent): Draft => ({
  template: agent.template,
  title: agent.title,
  goal: agent.goal,
  frequency: agent.schedule.frequency,
  weekday: agent.schedule.weekday ?? 1,
  times: [...agent.schedule.times],
  useMail: agent.useMail,
  cap: (agent.monthlyCapMicros / 1e6).toFixed(2),
  timeZone: agent.timeZone,
});

/** An unused time an hour after the last one. */
function nextTime(times: string[]) {
  let [hour, minute] = (times.at(-1) ?? '08:00').split(':').map(Number) as [
    number,
    number,
  ];
  for (let step = 0; step < 24; step++) {
    hour = (hour + 1) % 24;
    const value = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    if (!times.includes(value)) return value;
  }
  minute = (minute + 30) % 60;
  return `00:${String(minute).padStart(2, '0')}`;
}

/** Why a draft cannot be saved, or null. */
function problem(draft: Draft): string | null {
  if (!draft.title.trim()) return 'Enter a title.';
  if (!draft.goal.trim()) return 'Describe the goal.';
  if (draft.goal.trim().length > 2000) return 'Shorten the goal.';
  if (draft.times.some((time) => !/^\d{2}:\d{2}$/.test(time)))
    return 'Enter every time.';
  if (new Set(draft.times).size !== draft.times.length)
    return 'Each time can appear once.';
  const cap = Math.round(Number(draft.cap) * 1e6);
  if (
    !Number.isFinite(cap) ||
    cap < agentCapRange.min ||
    cap > agentCapRange.max
  )
    return `Set a monthly cap from ${formatCost(agentCapRange.min)} to ${formatCost(agentCapRange.max)}.`;
  if (!draft.timeZone.trim()) return 'Enter a time zone.';
  return null;
}
const saveError = (error: unknown) =>
  error instanceof RequestError
    ? error.code === 'VERSION_CONFLICT'
      ? 'This agent changed on another device. Close and reopen it.'
      : error.message
    : 'Could not reach the server. Your changes are still here; try again.';

/**
 * Create or edit an agent (D57). Template presets fill the fields; editing
 * also offers Pause/Resume, Run now and Delete. Closing returns whether
 * anything changed so the caller can reload.
 */
export function AgentDialog({
  agent,
  onClose,
}: {
  agent?: Agent | undefined;
  onClose: (changed: boolean) => void;
}) {
  const online = useOnline();
  const [confirmDialog, confirm] = useConfirm();
  const ref = useRef<HTMLDialogElement>(null);
  const first = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const [draft, setDraft] = useState<Draft>(() =>
    agent ? fromAgent(agent) : fromTemplate('daily-plan', deviceZone()),
  );
  const [current, setCurrent] = useState(agent);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const changed = useRef(false);
  const operations = useRef(
    new Map<string, ReturnType<typeof operationTracker>>(),
  );
  function tracked(
    method: string,
    path: string,
    body: Record<string, unknown>,
  ) {
    const key = `${method} ${path}`;
    let tracker = operations.current.get(key);
    if (!tracker) {
      tracker = operationTracker();
      operations.current.set(key, tracker);
    }
    return tracker.prepare(method, path, body);
  }
  useEffect(() => {
    const returnFocus = document.activeElement;
    const element = ref.current;
    if (element && !element.open) element.showModal();
    first.current?.focus();
    return () => {
      element?.close();
      if (returnFocus instanceof HTMLElement) returnFocus.focus();
    };
  }, []);
  const set = (fields: Partial<Draft>) =>
    setDraft((value) => ({ ...value, ...fields }));
  const close = () => onClose(changed.current);

  async function run<T>(work: () => Promise<T>) {
    setBusy(true);
    setError('');
    try {
      return await work();
    } catch (failure) {
      setError(saveError(failure));
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    const reason = problem(draft);
    if (reason) return setError(reason);
    const fields = {
      title: draft.title.trim(),
      goal: draft.goal.trim(),
      schedule: {
        frequency: draft.frequency,
        ...(draft.frequency === 'weekly' ? { weekday: draft.weekday } : {}),
        times: draft.times,
      },
      useMail: draft.useMail,
      monthlyCapMicros: Math.round(Number(draft.cap) * 1e6),
      timeZone: draft.timeZone.trim(),
    };
    const saved = await run(() =>
      current
        ? liveRequestJson(`/api/v1/agents/${current.id}`, agentResponseSchema, {
            method: 'PUT',
            body: tracked('PUT', `/api/v1/agents/${current.id}`, {
              ...fields,
              expectedVersion: current.version,
            }),
          })
        : liveRequestJson('/api/v1/agents', agentResponseSchema, {
            method: 'POST',
            body: tracked('POST', '/api/v1/agents', {
              ...fields,
              template: draft.template,
            }),
          }),
    );
    if (!saved) return;
    changed.current = true;
    close();
  }

  async function lifecycle(action: 'pause' | 'resume') {
    if (!current) return;
    const done = await run(() =>
      liveRequestJson(
        `/api/v1/responsibilities/${current.id}/${action}`,
        responsibilityMutationResponseSchema,
        {
          method: 'POST',
          body: tracked(
            'POST',
            `/api/v1/responsibilities/${current.id}/${action}`,
            {
              expectedVersion: current.version,
            },
          ),
        },
      ),
    );
    if (!done) return;
    operations.current.delete(
      `POST /api/v1/responsibilities/${current.id}/${action}`,
    );
    changed.current = true;
    setCurrent({
      ...current,
      version: done.responsibility.version,
      status: action === 'pause' ? 'paused' : 'active',
      pauseReason: null,
    });
  }

  async function runNow() {
    if (!current) return;
    const done = await run(() =>
      liveRequestJson(
        `/api/v1/agents/${current.id}/run`,
        agentRunResponseSchema,
        {
          method: 'POST',
          body: tracked('POST', `/api/v1/agents/${current.id}/run`, {
            expectedVersion: current.version,
          }),
        },
      ),
    );
    if (!done) return;
    changed.current = true;
    close();
  }

  async function remove() {
    if (!current) return;
    if (
      !(await confirm({
        title: `Delete “${current.title}”?`,
        message: 'It stops running. Its conversation is kept.',
        confirmLabel: 'Delete agent',
      }))
    )
      return;
    const done = await run(() =>
      liveRequestJson(
        `/api/v1/responsibilities/${current.id}`,
        responsibilityMutationResponseSchema,
        {
          method: 'DELETE',
          body: tracked('DELETE', `/api/v1/responsibilities/${current.id}`, {
            expectedVersion: current.version,
          }),
        },
      ),
    );
    if (!done) return;
    changed.current = true;
    close();
  }

  const blockedReason = !current
    ? null
    : current.pauseReason === 'cap-reached'
      ? 'Cap reached'
      : current.status === 'paused'
        ? 'Paused'
        : null;
  return (
    <dialog
      ref={ref}
      className="confirm-dialog agent-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
    >
      {confirmDialog}
      <h2 id={titleId}>{current ? current.title : 'New agent'}</h2>
      {!online && <p role="status">Offline. Reconnect to save or run.</p>}
      <form
        className="agent-dialog__form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={busy}>
          {!current && (
            <fieldset>
              <legend>Template</legend>
              <div className="agent-dialog__choices">
                {templates.map((item, index) => (
                  <label key={item.value} className="checkbox-label">
                    <input
                      ref={index === 0 ? first : undefined}
                      type="radio"
                      name="template"
                      checked={draft.template === item.value}
                      onChange={() =>
                        setDraft(fromTemplate(item.value, draft.timeZone))
                      }
                    />
                    {item.label}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <label>
            Title
            <input
              ref={current ? first : undefined}
              value={draft.title}
              maxLength={160}
              onChange={(event) => set({ title: event.target.value })}
            />
          </label>
          <label>
            Goal
            <textarea
              value={draft.goal}
              rows={4}
              maxLength={2000}
              onChange={(event) => set({ goal: event.target.value })}
            />
            {draft.goal.length >= 1800 && (
              <span className="meta">{draft.goal.length} / 2000</span>
            )}
          </label>
          <fieldset>
            <legend>Schedule</legend>
            <div className="agent-dialog__choices">
              {(['daily', 'weekly'] as const).map((value) => (
                <label key={value} className="checkbox-label">
                  <input
                    type="radio"
                    name="frequency"
                    checked={draft.frequency === value}
                    onChange={() => set({ frequency: value })}
                  />
                  {value === 'daily' ? 'Daily' : 'Weekly'}
                </label>
              ))}
            </div>
            {draft.frequency === 'weekly' && (
              <label>
                Weekday
                <select
                  value={draft.weekday}
                  onChange={(event) =>
                    set({ weekday: Number(event.target.value) })
                  }
                >
                  {weekdays.map((name, index) => (
                    <option key={name} value={index + 1}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <ul className="agent-dialog__times">
              {draft.times.map((time, index) => (
                <li key={index}>
                  <label>
                    Time {index + 1}
                    <input
                      type="time"
                      value={time}
                      required
                      onChange={(event) =>
                        set({
                          times: draft.times.map((value, at) =>
                            at === index ? event.target.value : value,
                          ),
                        })
                      }
                    />
                  </label>
                  {draft.times.length > 1 && (
                    <button
                      type="button"
                      className="secondary-button"
                      aria-label={`Remove time ${index + 1}`}
                      onClick={() =>
                        set({
                          times: draft.times.filter((_, at) => at !== index),
                        })
                      }
                    >
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="secondary-button"
              disabled={draft.times.length >= 6}
              onClick={() =>
                set({ times: [...draft.times, nextTime(draft.times)] })
              }
            >
              Add time
            </button>
          </fieldset>
          <label>
            Time zone
            <TimeZoneInput
              value={draft.timeZone}
              onChange={(event) => set({ timeZone: event.target.value })}
            />
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={draft.useMail}
              onChange={(event) => set({ useMail: event.target.checked })}
            />
            Use mail
            <Help label="Use mail">
              Runs may search and read your mail. Restricted mail is never sent,
              and Personal mail only if Settings › AI allows it.
            </Help>
          </label>
          <label>
            Monthly cap ($)
            <input
              type="number"
              inputMode="decimal"
              min={agentCapRange.min / 1e6}
              max={agentCapRange.max / 1e6}
              step="0.01"
              value={draft.cap}
              onChange={(event) => set({ cap: event.target.value })}
            />
          </label>
          {current && (
            <p className="meta">
              Spend this month: {formatCost(current.spentMicros)}
            </p>
          )}
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          {current && (
            <div className="form-actions">
              {current.status === 'paused' ? (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy || !online}
                  onClick={() => void lifecycle('resume')}
                >
                  Resume
                </button>
              ) : (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy || !online}
                  onClick={() => void lifecycle('pause')}
                >
                  Pause
                </button>
              )}
              <button
                type="button"
                className="secondary-button"
                disabled={busy || !online || !!blockedReason}
                onClick={() => void runNow()}
              >
                Run now
              </button>
              {blockedReason && <span className="meta">{blockedReason}</span>}
              <button
                type="button"
                className="danger-button"
                disabled={busy || !online}
                onClick={() => void remove()}
              >
                Delete
              </button>
            </div>
          )}
          <div className="form-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={close}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="primary-button"
              disabled={busy || !online}
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </fieldset>
      </form>
    </dialog>
  );
}
