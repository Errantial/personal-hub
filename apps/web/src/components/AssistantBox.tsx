import { useState } from 'react';
import type { AssistantTurn } from '@hub/contracts';
import type { Route } from '../lib/router';
import { AssistantComposer, useAssistantSettings } from './AssistantComposer';
import { AssistantTurnView } from './AssistantTurn';
import { Help } from './Help';
import { Link } from './Link';
import './AssistantBox.css';

export const assistantHelp = `Describe tasks or events to add or change. The assistant proposes changes and nothing is saved until you apply them. It sees the titles and times of your open tasks and one-time events in the next 30 days, not notes, repeating events, source-linked items, unknown label history, or anything you labeled Personal or Restricted. Follow-ups also resend your earlier asks and replies in the conversation. With Use mail ticked, the assistant may search the subjects and senders of mail you allow and read up to five messages; each answer lists what was sent. Restricted mail is never sent, and Personal mail only if allowed in Settings › AI. Such asks can take up to three calls. Requests go to OpenRouter and count against your AI spending limits. Conversations are kept on your server until you delete them.`;

export { useAssistantSettings };

/**
 * Today › Assistant: a quick ask. Asks here start a conversation that
 * continues on the Assistant page.
 */
export function AssistantBox({
  navigate,
  onApplied,
}: {
  navigate: (route: Route) => void;
  /** Reloads the planner lists after changes. */
  onApplied: () => void;
}) {
  const settings = useAssistantSettings();
  const [conversationId, setConversationId] = useState(() =>
    crypto.randomUUID(),
  );
  const [turn, setTurn] = useState<AssistantTurn | null>(null);
  const configured = settings.data?.settings.configured;
  return (
    <section className="panel assistant" aria-labelledby="assistant-title">
      <h2 id="assistant-title">Assistant</h2>
      <Help label="Assistant">{assistantHelp}</Help>
      {settings.error && (
        <p role="alert" className="form-error">
          {settings.error}
        </p>
      )}
      {configured === false ? (
        <p>
          Not set up: the server has no OpenRouter key. See the operating guide.
        </p>
      ) : (
        <AssistantComposer
          conversationId={conversationId}
          settings={settings}
          placeholder="Add a task to call the bank on Friday"
          navigate={navigate}
          onAnswered={setTurn}
        />
      )}
      {turn && (
        <>
          <AssistantTurnView
            key={turn.id}
            turn={turn}
            showAsk={false}
            onTurn={setTurn}
            onApplied={onApplied}
            onStale={() =>
              navigate({ name: 'assistant', id: turn.conversationId })
            }
          />
          <div className="form-actions">
            <Link
              route={{ name: 'assistant', id: turn.conversationId }}
              navigate={navigate}
            >
              Continue in Assistant
            </Link>
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                setTurn(null);
                setConversationId(crypto.randomUUID());
              }}
            >
              New conversation
            </button>
          </div>
        </>
      )}
    </section>
  );
}
