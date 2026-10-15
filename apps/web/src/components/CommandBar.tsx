import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  assistantRequestResponseSchema,
  liveDestinationResponseSchema,
  taskResponseSchema,
} from '@hub/contracts';
import { useMutation, useOnline, useResource } from '../lib/hooks';
import { getJson } from '../lib/api';
import { destinationReason } from '../lib/assistant';
import { offlineStatus } from '../lib/offline';
import type { Route } from '../lib/router';
import { useAssistantSettings } from './AssistantComposer';
import { Help } from './Help';
import { Link } from './Link';
import './CommandBar.css';

type Mode = 'task' | 'ask';
const modeKey = 'hub:command-mode';

function readMode(): Mode {
  try {
    return localStorage.getItem(modeKey) === 'ask' ? 'ask' : 'task';
  } catch {
    return 'task';
  }
}

/**
 * Today's one input (D-rework): add a task (works offline, queued through
 * the task transport) or ask the assistant, whose answer opens on the
 * Assistant page. The chosen mode is remembered on this device.
 */
export function CommandBar({
  navigate,
  onTaskSaved,
}: {
  navigate: (route: Route) => void;
  onTaskSaved: () => Promise<unknown>;
}) {
  const settings = useAssistantSettings();
  const online = useOnline();
  const destination = useResource(
    (signal) =>
      getJson(
        '/api/v1/assistant/destination',
        liveDestinationResponseSchema,
        signal,
      ),
    { failure: 'Destination status unavailable.', refreshMs: 15000 },
  );
  const route = destination.data?.destination;
  const routeReady = online && !destination.error && route?.status === 'ready';
  const saved = settings.data?.settings;
  const canAsk = !!saved?.configured;
  const [chosen, setChosen] = useState<Mode>(readMode);
  const mode: Mode = chosen === 'ask' && canAsk ? 'ask' : 'task';
  const [text, setText] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [message, setMessage] = useState('');
  const save = useMutation();
  const ask = useMutation();
  const pending = save.pending || ask.pending;

  function choose(next: Mode) {
    setChosen(next);
    setMessage('');
    try {
      localStorage.setItem(modeKey, next);
    } catch {
      /* Still applies without storage. */
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!text.trim()) return;
    setMessage('');
    if (mode === 'task') {
      const result = await save.run(
        taskResponseSchema,
        'POST',
        '/api/v1/tasks',
        {
          title: text.trim(),
          dueDate: dueDate || null,
          notes: '',
          priority: 'normal',
          completed: false,
          sensitivity: 'unlabeled',
        },
      );
      if (!result) return;
      setText('');
      setDueDate('');
      const state = await offlineStatus().catch(() => null);
      setMessage(
        state?.queued.includes(result.task.id)
          ? 'Task queued for sync.'
          : 'Task saved.',
      );
      await onTaskSaved();
      return;
    }
    if (!routeReady) return;
    const result = await ask.run(
      assistantRequestResponseSchema,
      'POST',
      '/api/v1/assistant/requests',
      {
        text,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        conversationId: crypto.randomUUID(),
        useMail: !!saved?.useMail,
      },
      'Could not send the request. Try again.',
    );
    if (!result) return;
    setText('');
    navigate({ name: 'assistant', id: result.turn.conversationId });
  }

  const error = save.error || ask.error;
  return (
    <section className="panel command-bar" aria-label="Add or ask">
      <form
        className="command-bar__form"
        noValidate
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <fieldset className="command-bar__modes">
          <legend className="visually-hidden">Mode</legend>
          <label>
            <input
              type="radio"
              name="command-mode"
              checked={mode === 'task'}
              onChange={() => choose('task')}
            />
            Add task
          </label>
          <label>
            <input
              type="radio"
              name="command-mode"
              checked={mode === 'ask'}
              disabled={!canAsk}
              onChange={() => choose('ask')}
            />
            Ask assistant
          </label>
          {saved && !canAsk && (
            <Help label="Ask assistant">
              The assistant is not set up: the server has no OpenRouter key.
            </Help>
          )}
        </fieldset>
        <label className="command-bar__field">
          <span className="visually-hidden">
            {mode === 'task' ? 'Add a task' : 'Ask the assistant'}
          </span>
          <input
            type="text"
            maxLength={mode === 'task' ? 200 : 1000}
            value={text}
            placeholder={
              mode === 'task'
                ? 'Call the bank on Friday'
                : 'What is due this week?'
            }
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        {mode === 'task' && (
          <label className="command-bar__date">
            <span className="visually-hidden">Due date</span>
            <input
              type="date"
              value={dueDate}
              onChange={(event) => setDueDate(event.target.value)}
            />
          </label>
        )}
        <button
          className="primary-button"
          disabled={pending || !text.trim() || (mode === 'ask' && !routeReady)}
        >
          {pending ? 'Saving…' : mode === 'task' ? 'Add' : 'Ask'}
        </button>
      </form>
      {mode === 'ask' && (!routeReady || destination.error) && (
        <p role="status">
          Assistant blocked:{' '}
          {!online
            ? 'Offline'
            : destination.error
              ? 'Status unavailable'
              : route?.reason
                ? destinationReason[route.reason]
                : 'Checking destination'}{' '}
          <Link route={{ name: 'settings', section: 'ai' }} navigate={navigate}>
            Settings
          </Link>
        </p>
      )}
      <p role="status" className="meta">
        {message}
      </p>
      {error && (
        <div role="alert" className="form-error">
          <p>{error}</p>
          {['BUDGET_UNSET', 'MONTHLY_BUDGET_EXCEEDED'].includes(ask.code) && (
            <Link
              route={{ name: 'settings', section: 'ai' }}
              navigate={navigate}
            >
              Open AI settings
            </Link>
          )}
        </div>
      )}
    </section>
  );
}
