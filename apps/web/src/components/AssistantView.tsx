import { useEffect, useMemo, useRef, useState } from 'react';
import {
  aiBudgetLiveSettingsSchema,
  assistantConversationDeletedSchema,
  assistantConversationListSchema,
  assistantConversationResponseSchema,
} from '@hub/contracts';
import type { AssistantTurn } from '@hub/contracts';
import { RequestError, getJson, liveRequestJson } from '../lib/api';
import { formatCost } from '../lib/assistant';
import { formatInstant } from '../lib/format';
import { useOnline, useResource } from '../lib/hooks';
import type { Route } from '../lib/router';
import { assistantHelp, useAssistantSettings } from './AssistantBox';
import { AssistantComposer } from './AssistantComposer';
import { AssistantTurnView } from './AssistantTurn';
import { useConfirm } from './ConfirmDialog';
import { Help } from './Help';
import { Link } from './Link';
import './Assistant.css';

/**
 * Assistant page (D55): conversations kept on the owner's server, so every
 * device shows the same asks, answers and applied changes.
 */
export function AssistantView({
  route,
  navigate,
}: {
  route: Extract<Route, { name: 'assistant' }>;
  navigate: (route: Route) => void;
}) {
  const online = useOnline();
  const settings = useAssistantSettings();
  const [dialog, confirm] = useConfirm();
  const [deleteError, setDeleteError] = useState('');
  const list = useResource(
    (signal) =>
      getJson(
        '/api/v1/assistant/conversations',
        assistantConversationListSchema,
        signal,
      ),
    { failure: 'Conversations could not be loaded.' },
  );
  const budget = useResource(
    (signal) =>
      getJson('/api/v1/ai/budget', aiBudgetLiveSettingsSchema, signal),
    { failure: '' },
  );
  // A new conversation gets its ID on the device; the server creates it on
  // the first ask.
  const fresh = useMemo(() => crypto.randomUUID(), [route.id]);
  const id = route.id ?? fresh;
  const thread = useResource(
    (signal) =>
      route.id
        ? getJson(
            `/api/v1/assistant/conversations/${route.id}`,
            assistantConversationResponseSchema,
            signal,
          )
        : Promise.resolve(null),
    { failure: 'This conversation could not be loaded.', key: route.id ?? '' },
  );
  const [turns, setTurns] = useState<AssistantTurn[]>([]);
  useEffect(() => setTurns(thread.data?.turns ?? []), [thread.data]);
  const [listOpen, setListOpen] = useState(false);
  useEffect(() => {
    setDeleteError('');
    setListOpen(false);
  }, [route.id]);
  // After an answer, bring the newest turn above the composer and return
  // focus to the Ask field.
  const lastTurn = useRef<HTMLLIElement>(null);
  const composer = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const scrollNext = useRef(false);
  useEffect(() => {
    if (!scrollNext.current || !lastTurn.current) return;
    scrollNext.current = false;
    lastTurn.current.style.scrollMarginBottom = `${
      (composer.current?.offsetHeight ?? 0) + 16
    }px`;
    lastTurn.current.scrollIntoView({ block: 'end' });
    input.current?.focus();
  }, [turns]);

  const configured = settings.data?.settings.configured;
  const usage = budget.data?.usage;
  const limit = budget.data?.policy.monthlyLimitMicros;
  const conversation = thread.data?.conversation;
  const missing =
    !!route.id && !thread.loading && !thread.data && !!thread.error;

  function replace(turn: AssistantTurn) {
    setTurns((current) =>
      current.some((item) => item.id === turn.id)
        ? current.map((item) => (item.id === turn.id ? turn : item))
        : [...current, turn],
    );
  }

  async function remove() {
    if (!conversation) return;
    if (
      !(await confirm({
        title: `Delete “${conversation.title}”?`,
        message:
          'Its asks and answers are removed from the server. Changes you applied stay.',
        confirmLabel: 'Delete conversation',
      }))
    )
      return;
    try {
      await liveRequestJson(
        `/api/v1/assistant/conversations/${conversation.id}`,
        assistantConversationDeletedSchema,
        { method: 'DELETE', body: { expectedVersion: conversation.version } },
      );
      void list.reload();
      navigate({ name: 'assistant' });
    } catch (error) {
      setDeleteError(
        error instanceof RequestError && error.code === 'VERSION_CONFLICT'
          ? 'This conversation changed on another device. Reload and try again.'
          : 'Could not delete the conversation. Try again.',
      );
    }
  }

  const spend = [
    settings.data?.settings.model,
    usage &&
      `${formatCost(Number(usage.spentMicros))} this month${
        limit !== null && limit !== undefined ? ` of ${formatCost(limit)}` : ''
      }`,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="assistant-page">
      {dialog}
      <button
        type="button"
        className="secondary-button assistant-page__toggle"
        aria-expanded={listOpen}
        aria-controls="assistant-conversations"
        onClick={() => setListOpen(!listOpen)}
      >
        Conversations
      </button>
      <div className="assistant-page__layout">
        <nav
          id="assistant-conversations"
          className={`panel assistant-page__list${listOpen ? ' is-open' : ''}`}
          aria-label="Conversations"
        >
          <Link
            className="secondary-button"
            route={{ name: 'assistant' }}
            navigate={navigate}
          >
            New conversation
          </Link>
          {list.error && (
            <p role="alert" className="form-error">
              {list.error}
            </p>
          )}
          {list.data && !list.data.conversations.length && (
            <p className="meta">No conversations yet.</p>
          )}
          <ul>
            {list.data?.conversations.map((item) => (
              <li key={item.id}>
                <Link
                  route={{ name: 'assistant', id: item.id }}
                  navigate={navigate}
                  current={item.id === route.id}
                >
                  {item.title || 'Untitled'}
                </Link>
                <span className="meta">{formatInstant(item.updatedAt)}</span>
              </li>
            ))}
          </ul>
        </nav>
        <section
          className="panel assistant-page__thread"
          aria-label={conversation ? conversation.title : 'New conversation'}
        >
          <header className="assistant-page__head">
            <h2>{conversation?.title ?? 'New conversation'}</h2>
            {conversation && (
              <button
                type="button"
                className="secondary-button"
                disabled={!online}
                onClick={() => {
                  void remove();
                }}
              >
                Delete
              </button>
            )}
            <p className="meta assistant-page__spend">
              {spend}
              <Help label="Assistant">{assistantHelp}</Help>
            </p>
          </header>
          {settings.error && (
            <p role="alert" className="form-error">
              {settings.error}
            </p>
          )}
          {deleteError && (
            <p role="alert" className="form-error">
              {deleteError}
            </p>
          )}
          {missing ? (
            <p role="alert">
              This conversation no longer exists or could not be loaded.{' '}
              <Link route={{ name: 'assistant' }} navigate={navigate}>
                Start a new one
              </Link>
            </p>
          ) : (
            <>
              {!route.id && (
                <p className="meta">
                  Ask about your tasks and events, or ask for changes. You
                  review every change before it is saved.
                </p>
              )}
              <ol className="assistant-page__turns">
                {turns.map((turn, index) => (
                  <li
                    key={turn.id}
                    ref={index === turns.length - 1 ? lastTurn : undefined}
                  >
                    <AssistantTurnView
                      turn={turn}
                      onTurn={replace}
                      onApplied={() => undefined}
                      onStale={() => void thread.reload()}
                    />
                  </li>
                ))}
              </ol>
              {configured === false ? (
                <p>
                  Not set up: the server has no OpenRouter key. See the
                  operating guide.
                </p>
              ) : (
                <div className="assistant-page__composer" ref={composer}>
                  <AssistantComposer
                    conversationId={id}
                    settings={settings}
                    inputRef={input}
                    placeholder={
                      turns.length
                        ? 'Ask a follow-up'
                        : 'Move my essay to Friday and add a reminder to print it'
                    }
                    navigate={navigate}
                    onAnswered={(turn) => {
                      scrollNext.current = true;
                      replace(turn);
                      void list.reload();
                      void budget.reload();
                      if (!route.id)
                        navigate({
                          name: 'assistant',
                          id: turn.conversationId,
                        });
                    }}
                  />
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
