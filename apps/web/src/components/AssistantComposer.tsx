import { useEffect, useRef, useState } from 'react';
import type { FormEvent, RefObject } from 'react';
import {
  assistantRequestResponseSchema,
  assistantSettingsResponseSchema,
  liveDestinationResponseSchema,
} from '@hub/contracts';
import type { AssistantTurn } from '@hub/contracts';
import { destinationReason } from '../lib/assistant';
import { getJson, liveRequestJson } from '../lib/api';
import { useMutation, useOnline, useResource } from '../lib/hooks';
import type { Route } from '../lib/router';
import { Link } from './Link';
import { AssistantAcademicPicker } from './AssistantAcademicPicker';
import type { AcademicSelection } from './AssistantAcademicPicker';
import { AssistantMemoryPicker } from './AssistantMemoryPicker';
import type { MemorySelection } from './AssistantMemoryPicker';

export function useAssistantSettings() {
  return useResource(
    (signal) =>
      getJson(
        '/api/v1/assistant/settings',
        assistantSettingsResponseSchema,
        signal,
      ),
    { failure: 'Assistant status unavailable.' },
  );
}

/**
 * The ask field. Enter asks and Shift+Enter adds a line (not during IME
 * composition). Each ask joins `conversationId`, which may be a new ID.
 * "Use mail" (D56) is remembered in the assistant settings on every device.
 */
export function AssistantComposer({
  conversationId,
  settings,
  placeholder,
  inputRef,
  navigate,
  onAnswered,
  continuation,
  onClearContinuation,
}: {
  conversationId: string;
  settings: ReturnType<typeof useAssistantSettings>;
  placeholder: string;
  /** Lets the page return focus to the Ask field. */
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  navigate: (route: Route) => void;
  onAnswered: (turn: AssistantTurn) => void;
  /** J4: searches older imported mail from the previous answer. */
  continuation?: string | null;
  onClearContinuation?: () => void;
}) {
  const online = useOnline();
  const ask = useMutation();
  const destination = useResource(
    (signal) =>
      getJson(
        '/api/v1/assistant/destination',
        liveDestinationResponseSchema,
        signal,
      ),
    { failure: 'Destination status unavailable.', refreshMs: 15000 },
  );
  const [text, setText] = useState('');
  const [academic, setAcademic] = useState<AcademicSelection[]>([]);
  const [memory, setMemory] = useState<MemorySelection[]>([]);
  useEffect(() => {
    setAcademic([]);
    setMemory([]);
  }, [conversationId]);
  const own = useRef<HTMLTextAreaElement>(null);
  const field = inputRef ?? own;
  const saved = settings.data?.settings;
  const configured = !!saved?.configured;
  const [useMail, setUseMail] = useState(false);
  const [mailError, setMailError] = useState('');
  useEffect(() => setUseMail(!!saved?.useMail), [saved?.useMail]);
  const route = destination.data?.destination;
  const ready =
    online &&
    !ask.pending &&
    configured &&
    !destination.error &&
    route?.status === 'ready';

  /** Saves the box's state; a newer version elsewhere is reloaded. */
  async function rememberMail(value: boolean) {
    setUseMail(value);
    setMailError('');
    if (!saved) return;
    try {
      await liveRequestJson(
        '/api/v1/assistant/settings',
        assistantSettingsResponseSchema,
        {
          method: 'PUT',
          body: {
            model: saved.model,
            expectedVersion: saved.version,
            useMail: value,
          },
        },
      );
    } catch {
      setMailError('Could not remember this choice; it still applies now.');
    }
    void settings.reload();
  }

  // Searching older mail needs mail access, so the switch follows the request.
  useEffect(() => {
    if (continuation && !useMail && saved && online) void rememberMail(true);
  }, [continuation, useMail, saved, online]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready) return;
    if (!text.trim()) {
      field.current?.focus();
      return;
    }
    const result = await ask.run(
      assistantRequestResponseSchema,
      'POST',
      '/api/v1/assistant/requests',
      {
        text,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        conversationId,
        useMail,
        ...(continuation ? { mailContinuation: continuation } : {}),
        academic: academic.map((item) => ({
          id: item.id,
          expectedVersion: item.version,
          expectedCourseVersion: item.courseVersion,
        })),
        memory: memory.map((item) => ({
          id: item.id,
          expectedVersion: item.version,
          expectedSettingsVersion: item.settingsVersion,
        })),
      },
      'Could not send the request. Try again.',
    );
    if (!result) return;
    setText('');
    setAcademic([]);
    setMemory([]);
    onClearContinuation?.();
    onAnswered(result.turn);
  }

  return (
    <>
      {(route?.status === 'blocked' || destination.error || !route) && (
        <p role="status">
          Assistant blocked:{' '}
          {destination.error
            ? 'Status unavailable'
            : route?.reason
              ? destinationReason[route.reason]
              : 'Checking destination'}{' '}
          <Link
            className="link-button"
            route={{ name: 'settings', section: 'ai' }}
            navigate={navigate}
          >
            Settings
          </Link>
          {destination.error && (
            <button
              type="button"
              className="secondary-button"
              disabled={!online}
              onClick={() => void destination.reload()}
            >
              Retry status
            </button>
          )}
        </p>
      )}
      <form
        className="assistant__form"
        aria-label="Ask the assistant"
        noValidate
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        {continuation && (
          <p role="status" className="assistant__continuation">
            The next ask searches older imported mail from the answer above. It
            reads mail again within the same limits.{' '}
            <button
              type="button"
              className="text-button"
              onClick={() => {
                onClearContinuation?.();
              }}
            >
              Cancel
            </button>
          </p>
        )}
        <label>
          <span className="visually-hidden">Ask</span>
          <textarea
            ref={field}
            rows={2}
            maxLength={1000}
            value={text}
            placeholder={placeholder}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key !== 'Enter' ||
                event.shiftKey ||
                event.nativeEvent.isComposing
              )
                return;
              event.preventDefault();
              if (ready) event.currentTarget.form?.requestSubmit();
            }}
          />
        </label>
        <AssistantAcademicPicker
          selected={academic}
          onChange={setAcademic}
          disabled={!online || ask.pending}
        />
        <AssistantMemoryPicker
          selected={memory}
          onChange={setMemory}
          disabled={!online || ask.pending}
        />
        <div className="assistant__actions">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={useMail}
              disabled={!saved || !online}
              onChange={(event) => {
                void rememberMail(event.target.checked);
              }}
            />
            Use mail
          </label>
          <button className="primary-button" disabled={!ready}>
            {ask.pending ? 'Asking…' : 'Ask'}
          </button>
        </div>
      </form>
      {mailError && <p className="meta">{mailError}</p>}
      {!online && configured && (
        <p className="meta">The assistant needs a connection.</p>
      )}
      {ask.error && (
        <div role="alert" className="form-error">
          <p>{ask.error}</p>
          {[
            'BUDGET_UNSET',
            'MONTHLY_BUDGET_EXCEEDED',
            'ASSISTANT_ROUTE_UNSET',
            'ASSISTANT_ROUTE_UNAVAILABLE',
            'MAIL_BROKER_APPROVAL_REQUIRED',
          ].includes(ask.code) && (
            <Link
              route={{ name: 'settings', section: 'ai' }}
              navigate={navigate}
            >
              Open AI settings
            </Link>
          )}
        </div>
      )}
    </>
  );
}
