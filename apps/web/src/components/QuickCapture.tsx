import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { taskResponseSchema } from '@hub/contracts';
import { useMutation } from '../lib/hooks';
import { offlineStatus } from '../lib/offline';
import './QuickCapture.css';

/** Expandable title + optional deadline form. Saves through the task
 *  transport, so it works offline and replays once from the outbox. */
export function QuickCapture({ onSaved }: { onSaved: () => Promise<unknown> }) {
  const [expanded, setExpanded] = useState(false);
  const [message, setMessage] = useState('');
  const title = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const save = useMutation();
  useEffect(() => {
    if (expanded) title.current?.focus();
  }, [expanded]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const element = event.currentTarget;
    const form = new FormData(element);
    const result = await save.run(taskResponseSchema, 'POST', '/api/v1/tasks', {
      title: String(form.get('title')),
      dueDate: form.get('dueDate') || null,
      notes: '',
      priority: 'normal',
      completed: false,
      sensitivity: 'unlabeled',
    });
    if (!result) return;
    element.reset();
    const state = await offlineStatus().catch(() => null);
    setMessage(
      state?.queued.includes(result.task.id)
        ? 'Task queued for sync.'
        : 'Task saved.',
    );
    await onSaved();
    title.current?.focus();
  }
  return (
    <section className="quick-capture" aria-label="Quick task capture">
      <button
        ref={button}
        type="button"
        className="primary-button"
        aria-expanded={expanded}
        aria-controls="quick-task-form"
        onClick={() => {
          setExpanded((value) => !value);
          setMessage('');
        }}
      >
        Add task
      </button>
      <div id="quick-task-form" hidden={!expanded}>
        <form
          className="editor-form"
          onSubmit={(event) => {
            void submit(event);
          }}
        >
          <label>
            Task title
            <input
              ref={title}
              name="title"
              required
              maxLength={200}
              disabled={save.pending}
            />
          </label>
          <label>
            Due date (optional)
            <input name="dueDate" type="date" disabled={save.pending} />
          </label>
          {save.error && (
            <p role="alert" className="form-error">
              {save.error}
            </p>
          )}
          <p role="status">{message}</p>
          <div className="form-actions">
            <button className="primary-button" disabled={save.pending}>
              {save.pending ? 'Saving…' : 'Save task'}
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={save.pending}
              onClick={() => {
                setExpanded(false);
                button.current?.focus();
              }}
            >
              Close
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
