import { useEffect, useMemo, useRef, useState } from 'react';
import {
  agentRunResponseSchema,
  agentsResponseSchema,
  aiBudgetLiveSettingsSchema,
  assistantConversationDeletedSchema,
  assistantConversationListSchema,
  assistantConversationResponseSchema,
} from '@hub/contracts';
import type { Agent, AssistantTurn } from '@hub/contracts';
import { agentState, useAgentSeen } from '../lib/agents';
import { RequestError, getJson, liveRequestJson } from '../lib/api';
import { formatCost } from '../lib/assistant';
import { formatInstant } from '../lib/format';
import { useOnline, useResource } from '../lib/hooks';
import { operationTracker } from '../lib/operations';
import type { Route } from '../lib/router';
import { assistantHelp, useAssistantSettings } from './AssistantBox';
import { AssistantComposer } from './AssistantComposer';
import { AssistantTurnView } from './AssistantTurn';
import { AgentDialog } from './AgentDialog';
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
  const agents = useResource(
    (signal) => getJson('/api/v1/agents', agentsResponseSchema, signal),
    { failure: 'Agents could not be loaded.', refreshMs: 15000 },
  );
  const seen = useAgentSeen();
  // undefined: closed; null: new agent; an agent: editing it.
  const [editing, setEditing] = useState<Agent | null | undefined>(undefined);
  const [runError, setRunError] = useState('');
  const [retrying, setRetrying] = useState(false);
  const retryOperation = useRef(operationTracker()).current;
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
    {
      failure: 'This conversation could not be loaded.',
      key: route.id ?? '',
      ...(route.id ? { refreshMs: 15000 } : {}),
    },
  );
  const [turns, setTurns] = useState<AssistantTurn[]>([]);
  useEffect(() => setTurns(thread.data?.turns ?? []), [thread.data]);
  const [listOpen, setListOpen] = useState(false);
  useEffect(() => {
    setDeleteError('');
    setRunError('');
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
  const agent = agents.data?.agents.find(
    (item) => item.conversationId === route.id,
  );
  const { markSeen } = seen;
  useEffect(() => {
    if (agent) markSeen(agent);
  }, [agent, markSeen]);
  const latestRun = agent?.lastRun?.id;
  const latestFinish = agent?.lastRun?.finishedAt;
  useEffect(() => {
    if (latestFinish) {
      void thread.reload();
      void budget.reload();
    }
  }, [latestRun, latestFinish, thread.reload, budget.reload]);
  const canRun =
    !!agent &&
    agent.status === 'active' &&
    !agent.pauseReason &&
    !retrying &&
    !['queued', 'running'].includes(agent.lastRun?.status ?? '');
  const runFailure =
    agent?.lastRun?.status === 'failed' && !agent.lastRun.turnId;
  const failureReason =
    agent?.lastRun?.errorCode === 'LEASE_EXPIRED'
      ? 'The run stopped after its lease expired. It was not resent.'
      : agent?.lastRun?.errorCode === 'AGENT_CHANGED'
        ? 'The agent changed before this run could start.'
        : agent?.lastRun?.errorCode === 'AGENT_LABELED'
          ? 'This agent’s privacy label blocks execution.'
          : 'The agent run could not finish. Open agent settings to review it.';

  /** Retry a failed run: queue a Run now. */
  async function retry() {
    if (!agent || retrying) return;
    setRetrying(true);
    setRunError('');
    try {
      await liveRequestJson(
        `/api/v1/agents/${agent.id}/run`,
        agentRunResponseSchema,
        {
          method: 'POST',
          body: retryOperation.prepare(
            'POST',
            `/api/v1/agents/${agent.id}/run`,
            {
              expectedVersion: agent.version,
            },
          ),
        },
      );
      retryOperation.settle();
      void agents.reload();
    } catch (error) {
      setRunError(
        error instanceof RequestError
          ? error.message
          : 'Could not reach the server. Try again.',
      );
    } finally {
      setRetrying(false);
    }
  }
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
      {editing !== undefined && (
        <AgentDialog
          agent={editing ?? undefined}
          onClose={(changed) => {
            setEditing(undefined);
            if (changed) {
              void agents.reload();
              void list.reload();
              void thread.reload();
            }
          }}
        />
      )}
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
        <div
          id="assistant-conversations"
          className={`panel assistant-page__list${listOpen ? ' is-open' : ''}`}
        >
          <nav aria-label="Agents" className="assistant-page__agents">
            <h2>Agents</h2>
            <button
              type="button"
              className="secondary-button"
              disabled={!online}
              onClick={() => setEditing(null)}
            >
              New agent
            </button>
            {agents.error && (
              <>
                <p role="alert" className="form-error">
                  {agents.error}
                </p>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={!online || agents.loading}
                  onClick={() => void agents.reload()}
                >
                  Retry agents
                </button>
              </>
            )}
            <ul>
              {agents.data?.agents.map((item) => {
                const state = agentState(item);
                return (
                  <li key={item.id}>
                    <Link
                      route={{ name: 'assistant', id: item.conversationId }}
                      navigate={navigate}
                      current={item.conversationId === route.id}
                    >
                      {item.title}
                      {seen.unread(item) && (
                        <span
                          className="assistant-page__dot"
                          role="img"
                          aria-label="New run"
                        />
                      )}
                    </Link>
                    <span
                      className={`meta agent-state agent-state--${state.tone}`}
                    >
                      {state.label}
                    </span>
                  </li>
                );
              })}
            </ul>
          </nav>
          <nav aria-label="Conversations">
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
            {list.data &&
              !list.data.conversations.some((item) => !item.agent) && (
                <p className="meta">No conversations yet.</p>
              )}
            <ul>
              {list.data?.conversations
                .filter((item) => !item.agent)
                .map((item) => (
                  <li key={item.id}>
                    <Link
                      route={{ name: 'assistant', id: item.id }}
                      navigate={navigate}
                      current={item.id === route.id}
                    >
                      {item.title || 'Untitled'}
                    </Link>
                    <span className="meta">
                      {formatInstant(item.updatedAt)}
                    </span>
                  </li>
                ))}
            </ul>
          </nav>
        </div>
        <section
          className="panel assistant-page__thread"
          aria-label={conversation ? conversation.title : 'New conversation'}
        >
          <header className="assistant-page__head">
            <h2>{conversation?.title ?? 'New conversation'}</h2>
            {agent && (
              <>
                <span className="meta">{agentState(agent).label}</span>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setEditing(agent)}
                >
                  Agent settings
                </button>
              </>
            )}
            {conversation && !agent && (
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
          {runError && (
            <p role="alert" className="form-error">
              {runError}
            </p>
          )}
          {runFailure && (
            <div>
              <p role="alert" className="form-error">
                {failureReason}
              </p>
              {canRun &&
                agent?.lastRun?.errorCode !== 'LEASE_EXPIRED' &&
                agent?.lastRun?.errorCode !== 'AGENT_RUN_ERROR' && (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void retry()}
                  >
                    Retry
                  </button>
                )}
            </div>
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
                      onRetry={
                        canRun && turn.trigger === 'agent'
                          ? () => void retry()
                          : undefined
                      }
                      timeZone={agent?.timeZone}
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
