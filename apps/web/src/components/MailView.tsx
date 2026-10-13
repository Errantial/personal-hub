import { useCallback, useEffect, useRef, useState } from 'react';
import {
  emailConnectorsResponseSchema,
  mailMessageResponseSchema,
  mailPageSchema,
} from '@hub/contracts';
import type { MailMessage, MailSummary } from '@hub/contracts';
import { RequestError, getJson } from '../lib/api';
import { formatInstant } from '../lib/format';
import type { Route } from '../lib/router';
import { Help } from './Help';
import { Link } from './Link';
import { StatusChip } from './StatusChip';

type Navigate = (route: Route) => void;
const mailRoute = (mail?: string): Route => ({
  name: 'inbox',
  section: 'mail',
  ...(mail ? { mail } : {}),
});
const sender = (message: Pick<MailSummary, 'from'>) =>
  message.from ? message.from.name || message.from.address : 'Unknown sender';
const addressList = (list: MailMessage['to']) =>
  list.length
    ? list
        .map((entry) =>
          entry.name ? `${entry.name} <${entry.address}>` : entry.address,
        )
        .join(', ')
    : 'None';

/**
 * Inbox › Mail: messages imported read-only from Proton Bridge. Plain text
 * only; attachments are counted, never stored. Online only.
 */
export function MailView({
  mail,
  navigate,
}: {
  mail: string | undefined;
  navigate: Navigate;
}) {
  const [folder, setFolder] = useState('');
  const [folders, setFolders] = useState<string[]>([]);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [messages, setMessages] = useState<MailSummary[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);

  useEffect(() => {
    void getJson('/api/v1/email/connectors', emailConnectorsResponseSchema)
      .then(({ connectors }) => {
        setConnected(connectors.some((item) => !item.revokedAt));
        setFolders([
          ...new Set(
            connectors.flatMap((item) => item.folders.map((f) => f.path)),
          ),
        ]);
      })
      .catch(() => setConnected(null));
  }, []);

  const load = useCallback(
    async (before?: string) => {
      const current = ++generation.current;
      setLoading(true);
      setError('');
      const query = new URLSearchParams({ limit: '50' });
      if (folder) query.set('folder', folder);
      if (before) query.set('before', before);
      try {
        const page = await getJson(
          `/api/v1/email/messages?${query}`,
          mailPageSchema,
        );
        if (current !== generation.current) return;
        setMessages((previous) =>
          before && previous ? [...previous, ...page.messages] : page.messages,
        );
        setNext(page.nextBefore);
      } catch (caught) {
        if (current !== generation.current) return;
        setError(
          before &&
            caught instanceof RequestError &&
            caught.code === 'NOT_FOUND'
            ? 'The list changed. Reload to see the latest.'
            : 'Mail needs a connection. Reload to try again.',
        );
      } finally {
        if (current === generation.current) setLoading(false);
      }
    },
    [folder],
  );
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section aria-labelledby="mail-title" className="mail-view">
      <h2 id="mail-title">Mail</h2>
      <Help label="Mail">
        Mail imported read-only from Proton Bridge by the connector on your
        computer, from the import start date onward. Only headers and plain text
        are kept; attachments are counted, not stored. Reading here never marks
        mail read in Proton.
      </Help>
      {connected === false && (
        <p>
          No email connector yet.{' '}
          <Link
            className="secondary-button"
            route={{ name: 'settings', section: 'connections' }}
            navigate={navigate}
          >
            Set one up in Connections
          </Link>
        </p>
      )}
      {folders.length > 0 && (
        <label className="mail-filter">
          Folder
          <select
            value={folder}
            onChange={(event) => setFolder(event.target.value)}
          >
            <option value="">All folders</option>
            {folders.map((path) => (
              <option key={path} value={path}>
                {path}
              </option>
            ))}
          </select>
        </label>
      )}
      {error && (
        <div role="alert" className="form-error">
          <p>{error}</p>
          <button
            type="button"
            className="secondary-button"
            disabled={loading}
            onClick={() => void load()}
          >
            Reload mail
          </button>
        </div>
      )}
      {loading && !messages && <p role="status">Loading…</p>}
      {messages && !messages.length && <p>No mail here.</p>}
      <ul className="inbox-list">
        {(messages ?? []).map((message) => (
          <li
            key={message.id}
            aria-current={message.id === mail ? 'true' : undefined}
          >
            <div className="inbox-list__body">
              <Link route={mailRoute(message.id)} navigate={navigate}>
                {message.subject || '(No subject)'}
              </Link>
              <span>
                {sender(message)} · {formatInstant(message.receivedAt)}
              </span>
              <span className="mail-snippet">{message.snippet}</span>
              {message.attachmentCount > 0 && (
                <span className="inbox-list__meta">
                  {message.attachmentCount} attachment
                  {message.attachmentCount === 1 ? '' : 's'} (not imported)
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>
      {next && (
        <button
          type="button"
          className="secondary-button"
          disabled={loading}
          onClick={() => void load(next)}
        >
          {loading ? 'Loading…' : 'Load more mail'}
        </button>
      )}
      {mail && <MailDetail key={mail} id={mail} navigate={navigate} />}
    </section>
  );
}

function MailDetail({ id, navigate }: { id: string; navigate: Navigate }) {
  const [message, setMessage] = useState<MailMessage | null>(null);
  const [error, setError] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    let active = true;
    getJson(`/api/v1/email/messages/${id}`, mailMessageResponseSchema).then(
      (result) => {
        if (!active) return;
        setMessage(result.message);
        requestAnimationFrame(() => heading.current?.focus());
      },
      (caught: unknown) => {
        if (active)
          setError(
            caught instanceof RequestError && caught.code === 'NOT_FOUND'
              ? 'This message is not available.'
              : 'This message needs a connection. Try again.',
          );
      },
    );
    return () => {
      active = false;
    };
  }, [id]);
  if (error)
    return (
      <p role="alert" className="form-error">
        {error}
      </p>
    );
  if (!message) return <p role="status">Loading…</p>;
  return (
    <article className="email-draft" aria-labelledby="mail-subject">
      <Link route={mailRoute()} navigate={navigate}>
        Back to mail
      </Link>
      <h3 id="mail-subject" ref={heading} tabIndex={-1}>
        {message.subject || '(No subject)'}
      </h3>
      <dl className="email-review">
        <dt>From</dt>
        <dd>{message.from ? addressList([message.from]) : 'Unknown sender'}</dd>
        <dt>To</dt>
        <dd>{addressList(message.to)}</dd>
        <dt>Cc</dt>
        <dd>{addressList(message.cc)}</dd>
        <dt>Received</dt>
        <dd>{formatInstant(message.receivedAt)}</dd>
        <dt>Folders</dt>
        <dd>{message.folders.join(', ')}</dd>
        <dt>Attachments</dt>
        <dd>
          {message.attachmentCount
            ? `${message.attachmentCount} (not imported)`
            : 'None'}
        </dd>
        {message.sensitivity !== 'unlabeled' && (
          <>
            <dt>Label</dt>
            <dd>
              <StatusChip>
                {message.sensitivity === 'personal' ? 'Personal' : 'Restricted'}
              </StatusChip>
            </dd>
          </>
        )}
      </dl>
      {/* Plain text only: never rendered as HTML. */}
      <pre className="email-review__body">{message.body || '(Empty)'}</pre>
      {message.bodyTruncated && (
        <p className="meta">Shortened: the full body was not imported.</p>
      )}
    </article>
  );
}
