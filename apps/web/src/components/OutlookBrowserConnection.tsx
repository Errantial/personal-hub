import { useEffect, useRef, useState } from 'react';
import {
  outlookBrowserConnectionSchema,
  outlookBrowserFolderWriteResponseSchema,
  outlookBrowserMessageDetailResponseSchema,
  outlookBrowserMessageWriteResponseSchema,
  outlookBrowserTokenResponseSchema,
} from '@hub/contracts';
import type {
  OutlookBrowserConnection as Connection,
  OutlookBrowserFolder,
  OutlookBrowserMessageDetailResponse,
  OutlookBrowserMessageSummary,
} from '@hub/contracts';
import { requestJson } from '../lib/api';
import { formatInstant } from '../lib/format';
import { Help } from './Help';
import { StatusChip } from './StatusChip';
import './OutlookBrowserConnection.css';

const base = '/api/v1/connections/outlook/browser';

const healthLabels: Record<Connection['healthStatus'], string> = {
  'never-synced': 'Never synced',
  syncing: 'Syncing',
  current: 'Current',
  stale: 'Stale',
  partial: 'Partial',
  'sign-in-required': 'Sign in required',
  'mfa-required': 'MFA required',
  revoked: 'Revoked',
  error: 'Error',
};

function errorHelp(code: Connection['lastErrorCode']) {
  if (code === 'sign-in-required')
    return 'Open the dedicated Outlook browser profile and sign in normally.';
  if (code === 'mfa-required')
    return 'Complete MFA in the dedicated Outlook browser profile before the next run.';
  if (code === 'foreign-origin')
    return 'The browser left the configured Outlook origin. Check the connector origin and the dedicated profile.';
  if (code === 'browser-unavailable')
    return 'The dedicated Chrome or Edge profile could not launch. Close other uses of that profile and try again.';
  if (code === 'outlook-unavailable')
    return 'Outlook Web did not load the requested folder. Retry after the normal sign-in page responds.';
  if (code === 'traversal-limit' || code === 'traversal-failed')
    return 'A folder changed, kept loading or reached its bounded traversal limit. Run the local collector again after confirming the folder layout.';
  return null;
}

const attentionHealth = new Set<Connection['healthStatus']>([
  'stale',
  'partial',
  'sign-in-required',
  'mfa-required',
  'revoked',
  'error',
]);

export function OutlookBrowserConnection() {
  const [data, setData] = useState<Connection | null>(null);
  const [token, setToken] = useState('');
  const [sourceDraft, setSourceDraft] = useState<{
    version: number;
    sensitivity: string;
    dirty: boolean;
  } | null>(null);
  const [folder, setFolder] = useState<{
    item: OutlookBrowserFolder;
    selected: boolean;
    notes: string;
    sensitivity: string;
  } | null>(null);
  const [message, setMessage] = useState<{
    item: OutlookBrowserMessageSummary;
    notes: string;
    sensitivity: string;
  } | null>(null);
  const [detail, setDetail] =
    useState<OutlookBrowserMessageDetailResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [status, setStatus] = useState('');
  const pending = useRef<{ key: string; id: string } | null>(null);

  async function load(signal?: AbortSignal) {
    const connection = await requestJson(
      base,
      outlookBrowserConnectionSchema,
      signal ? { signal } : {},
    );
    if (!signal?.aborted) {
      setLoadError('');
      setData(connection);
      setSourceDraft((previous) =>
        previous?.dirty
          ? previous
          : {
              version: connection.version,
              sensitivity: connection.sensitivity,
              dirty: false,
            },
      );
    }
    return connection;
  }

  useEffect(() => {
    const abort = new AbortController();
    const refresh = () => {
      void load(abort.signal).catch(() => {
        if (!abort.signal.aborted)
          setLoadError(
            'Outlook browser status unavailable. Reload to check freshness.',
          );
      });
    };
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, []);

  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    setLoadError('');
    setStatus('');
    try {
      await action();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Outlook browser request failed.',
      );
    } finally {
      setBusy(false);
    }
  }

  function operation(key: string) {
    if (pending.current?.key !== key)
      pending.current = { key, id: crypto.randomUUID() };
    return pending.current.id;
  }

  async function openMessage(item: OutlookBrowserMessageSummary) {
    setBusy(true);
    setError('');
    setStatus('');
    try {
      setDetail(
        await requestJson(
          `${base}/messages/${item.id}`,
          outlookBrowserMessageDetailResponseSchema,
        ),
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Message detail unavailable.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (!data)
    return (
      <section aria-label="Outlook browser connection" className="panel">
        <h3>Browser collector (read-only)</h3>
        <p role="status">Loading Outlook browser status…</p>
        {loadError && <p role="alert">{loadError}</p>}
        {error && <p role="alert">{error}</p>}
      </section>
    );
  const source = sourceDraft ?? {
    version: data.version,
    sensitivity: data.sensitivity,
    dirty: false,
  };

  return (
    <section aria-label="Outlook browser connection" className="panel">
      <h3>
        Browser collector (read-only){' '}
        <StatusChip
          tone={
            attentionHealth.has(data.healthStatus) ? 'attention' : 'neutral'
          }
        >
          {healthLabels[data.healthStatus]}
        </StatusChip>
      </h3>
      <Help label="Outlook browser collector">
        This local collector uses a dedicated browser profile and your normal
        interactive Outlook Web sign-in. It imports selected folder coverage,
        bounded message metadata and plain text only. It does not use Microsoft
        Graph, export cookies, read hidden API responses, take screenshots,
        download attachments or send, write or change calendar items. No HTML,
        raw headers, cookies or session data are stored. Opening a reading pane
        can follow your account's normal read/unread and read-receipt settings,
        so this is not a guarantee of zero server-side state change. Partial or
        inaccessible folders never remove unseen messages. This is separate from
        the Graph access gate above.
      </Help>
      <p className="meta">
        Last contact:{' '}
        {data.lastContactAt ? formatInstant(data.lastContactAt) : 'Never'}
        {' · '}Complete through:{' '}
        {data.lastCompleteAt ? formatInstant(data.lastCompleteAt) : 'Never'}
      </p>
      {data.lastErrorCode && (
        <p role="status">
          Latest collector result: {data.lastErrorCode}
          {errorHelp(data.lastErrorCode) &&
            ` · ${errorHelp(data.lastErrorCode)}`}
        </p>
      )}
      {loadError && <p role="alert">{loadError}</p>}
      {error && <p role="alert">{error}</p>}
      {status && <p role="status">{status}</p>}

      {token ? (
        <div
          className="editor-form"
          aria-label="Outlook browser collector token"
        >
          <label>
            Collector token
            <input
              readOnly
              value={token}
              aria-label="Outlook browser collector token"
            />
          </label>
          <p>Save this token now. It cannot be shown again.</p>
          <button type="button" onClick={() => setToken('')}>
            I saved it
          </button>
        </div>
      ) : (
        <div className="item-actions">
          <button
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                const key = `token:${data.version}`;
                const result = await requestJson(
                  `${base}/token`,
                  outlookBrowserTokenResponseSchema,
                  {
                    method: 'POST',
                    body: {
                      operationId: operation(key),
                      expectedVersion: data.version,
                    },
                  },
                );
                pending.current = null;
                setToken(result.token);
                setData(result.connection);
                setSourceDraft((previous) =>
                  previous?.dirty
                    ? previous
                    : {
                        version: result.connection.version,
                        sensitivity: result.connection.sensitivity,
                        dirty: false,
                      },
                );
                setStatus(
                  data.configured
                    ? 'Replacement collector token created. Update the local connector before its next run.'
                    : 'Collector token created.',
                );
              })
            }
          >
            {data.configured
              ? 'Replace collector token'
              : 'Create collector token'}
          </button>
          {data.configured && (
            <button
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  const key = `revoke:${data.version}`;
                  const result = await requestJson(
                    `${base}/revoke`,
                    outlookBrowserConnectionSchema,
                    {
                      method: 'POST',
                      body: {
                        operationId: operation(key),
                        expectedVersion: data.version,
                      },
                    },
                  );
                  pending.current = null;
                  setData(result);
                  setSourceDraft((previous) =>
                    previous?.dirty
                      ? previous
                      : {
                          version: result.version,
                          sensitivity: result.sensitivity,
                          dirty: false,
                        },
                  );
                  setStatus(
                    'Outlook browser collector revoked. Retained messages stay available.',
                  );
                })
              }
            >
              Revoke collector
            </button>
          )}
        </div>
      )}

      <form
        className="editor-form"
        aria-label="Outlook browser source settings"
        onSubmit={(event) => {
          event.preventDefault();
          void perform(async () => {
            const key = `source:${source.version}:${source.sensitivity}`;
            const result = await requestJson(
              base,
              outlookBrowserConnectionSchema,
              {
                method: 'PUT',
                body: {
                  operationId: operation(key),
                  expectedVersion: source.version,
                  sensitivity: source.sensitivity,
                },
              },
            );
            pending.current = null;
            setData(result);
            setSourceDraft({
              version: result.version,
              sensitivity: result.sensitivity,
              dirty: false,
            });
            setStatus('Outlook browser source label saved.');
          });
        }}
      >
        <label>
          Imported Outlook label
          <select
            value={source.sensitivity}
            onChange={(event) =>
              setSourceDraft({
                ...source,
                sensitivity: event.target.value,
                dirty: true,
              })
            }
          >
            {['unlabeled', 'personal', 'restricted'].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <button disabled={busy || source.sensitivity === data.sensitivity}>
          Save source label
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              const connection = await load();
              setSourceDraft({
                version: connection.version,
                sensitivity: connection.sensitivity,
                dirty: false,
              });
              setStatus('Outlook browser source version reloaded.');
            })
          }
        >
          Reload source version
        </button>
      </form>

      <h4>Discovered folders</h4>
      <Help label="Outlook folder selection">
        Run the local collector once after saving its token, then explicitly
        select the folders to collect. Coverage is per folder; changing the
        selected set requires a new complete run before the source is current
        again.
      </Help>
      {!data.folders.length && (
        <p>
          No Outlook folders discovered yet. Run the local collector once after
          saving its token; then explicitly select the folders to collect.
        </p>
      )}
      {data.folders.map((item) => {
        return (
          <section
            key={item.id}
            className="canvas-item"
            aria-label={`Outlook browser folder ${item.name}`}
          >
            <h5>{item.name}</h5>
            <p>
              {item.selected ? 'Selected' : 'Not selected'} ·{' '}
              {item.availability}
              {' · '}
              {item.effectiveSensitivity}
            </p>
            <p className="meta">
              Coverage: {item.lastObservationStatus ?? 'Never observed'} ·
              Complete:{' '}
              {item.lastCompleteAt
                ? formatInstant(item.lastCompleteAt)
                : 'Never'}
            </p>
            {item.notes && <p className="canvas-text">{item.notes}</p>}
            <button
              className="text-button"
              disabled={busy}
              onClick={() =>
                setFolder({
                  item,
                  selected: item.selected,
                  notes: item.notes,
                  sensitivity: item.sensitivity,
                })
              }
            >
              Edit browser folder
            </button>
            {folder?.item.id === item.id && (
              <form
                className="editor-form"
                aria-label="Outlook browser folder editor"
                onSubmit={(event) => {
                  event.preventDefault();
                  void perform(async () => {
                    const body = {
                      expectedVersion: folder.item.version,
                      selected: folder.selected,
                      notes: folder.notes,
                      sensitivity: folder.sensitivity,
                    };
                    const key = `folder:${folder.item.id}:${JSON.stringify(body)}`;
                    await requestJson(
                      `${base}/folders/${folder.item.id}`,
                      outlookBrowserFolderWriteResponseSchema,
                      {
                        method: 'PUT',
                        body: { operationId: operation(key), ...body },
                      },
                    );
                    pending.current = null;
                    setFolder(null);
                    await load();
                    setStatus('Outlook browser folder saved.');
                  });
                }}
              >
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={folder.selected}
                    onChange={(event) =>
                      setFolder({ ...folder, selected: event.target.checked })
                    }
                  />{' '}
                  Collect this folder
                </label>
                <label>
                  Personal notes
                  <textarea
                    value={folder.notes}
                    onChange={(event) =>
                      setFolder({ ...folder, notes: event.target.value })
                    }
                    maxLength={10000}
                    rows={2}
                  />
                </label>
                <label>
                  Content label
                  <select
                    value={folder.sensitivity}
                    onChange={(event) =>
                      setFolder({
                        ...folder,
                        sensitivity: event.target.value,
                      })
                    }
                  >
                    {['unlabeled', 'personal', 'restricted'].map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                </label>
                <div className="item-actions">
                  <button disabled={busy}>Save browser folder</button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        const connection = await load();
                        const fresh = connection.folders.find(
                          (value) => value.id === folder.item.id,
                        );
                        if (!fresh) {
                          setFolder(null);
                          throw new Error(
                            'This folder is no longer discovered. Reload status.',
                          );
                        }
                        setFolder({
                          item: fresh,
                          selected: fresh.selected,
                          notes: fresh.notes,
                          sensitivity: fresh.sensitivity,
                        });
                        setStatus('Outlook browser folder version reloaded.');
                      })
                    }
                  >
                    Reload folder version
                  </button>
                  <button type="button" onClick={() => setFolder(null)}>
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </section>
        );
      })}

      <h4>Imported messages</h4>
      <Help label="Imported Outlook messages">
        Shows the 200 most recent retained messages. Message bodies are plain
        text only. Opening a message does not fetch it from Outlook again.
      </Help>
      {data.messagesTruncated && (
        <p role="status">
          Showing the 200 most recent messages. Older retained messages remain
          in export.
        </p>
      )}
      {!data.messages.length && (
        <p>
          No messages imported yet. A complete selected-folder run imports its
          bounded message window.
        </p>
      )}
      {data.messages.map((item) => {
        const folderName = data.folders.find(
          (value) => value.id === item.browserFolderId,
        )?.name;
        return (
          <section
            key={item.id}
            className="canvas-item"
            aria-label={`Outlook browser message ${item.subject}`}
          >
            <h5>{item.subject}</h5>
            <p>
              {item.senderDisplay}
              {item.senderAddress ? ` · ${item.senderAddress}` : ''}
            </p>
            <p className="meta">
              {folderName ?? 'Folder'} ·{' '}
              {item.receivedAt
                ? formatInstant(item.receivedAt)
                : 'No received time'}{' '}
              ·{' '}
              {item.availability === 'missing'
                ? 'Not in latest complete folder observation'
                : 'Available'}{' '}
              · {item.effectiveSensitivity}
            </p>
            <p className="canvas-text">{item.snippet || 'No preview text.'}</p>
            {item.notes && <p className="canvas-text">{item.notes}</p>}
            <div className="item-actions">
              <button
                className="text-button"
                disabled={busy}
                onClick={() => void openMessage(item)}
              >
                Open message
              </button>
              <button
                className="text-button"
                disabled={busy}
                onClick={() =>
                  setMessage({
                    item,
                    notes: item.notes,
                    sensitivity: item.sensitivity,
                  })
                }
              >
                Edit message notes
              </button>
            </div>
            {detail?.message.id === item.id && (
              <section aria-label="Outlook browser message detail">
                <p className="meta">
                  Captured{' '}
                  {detail.message.capturedAt
                    ? formatInstant(detail.message.capturedAt)
                    : 'Unknown'}
                  {' · '}Captures: {detail.captures.length}
                </p>
                <p className="outlook-message-body canvas-text">
                  {detail.message.bodyText || 'No plain-text body captured.'}
                </p>
                <a
                  href={detail.message.canonicalUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open in Outlook
                </a>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setDetail(null)}
                >
                  Close message
                </button>
              </section>
            )}
            {message?.item.id === item.id && (
              <form
                className="editor-form"
                aria-label="Outlook browser message editor"
                onSubmit={(event) => {
                  event.preventDefault();
                  void perform(async () => {
                    const body = {
                      expectedVersion: message.item.version,
                      notes: message.notes,
                      sensitivity: message.sensitivity,
                    };
                    const key = `message:${message.item.id}:${JSON.stringify(body)}`;
                    await requestJson(
                      `${base}/messages/${message.item.id}`,
                      outlookBrowserMessageWriteResponseSchema,
                      {
                        method: 'PUT',
                        body: { operationId: operation(key), ...body },
                      },
                    );
                    pending.current = null;
                    setMessage(null);
                    await load();
                    setStatus('Outlook browser message notes saved.');
                  });
                }}
              >
                <label>
                  Personal notes
                  <textarea
                    value={message.notes}
                    onChange={(event) =>
                      setMessage({ ...message, notes: event.target.value })
                    }
                    maxLength={10000}
                    rows={2}
                  />
                </label>
                <label>
                  Content label
                  <select
                    value={message.sensitivity}
                    onChange={(event) =>
                      setMessage({
                        ...message,
                        sensitivity: event.target.value,
                      })
                    }
                  >
                    {['unlabeled', 'personal', 'restricted'].map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                </label>
                <div className="item-actions">
                  <button disabled={busy}>Save message notes</button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        const connection = await load();
                        const fresh = connection.messages.find(
                          (value) => value.id === message.item.id,
                        );
                        if (!fresh) {
                          setMessage(null);
                          throw new Error(
                            'This message is no longer retained. Reload status.',
                          );
                        }
                        setMessage({
                          item: fresh,
                          notes: fresh.notes,
                          sensitivity: fresh.sensitivity,
                        });
                        setStatus('Outlook browser message version reloaded.');
                      })
                    }
                  >
                    Reload message version
                  </button>
                  <button type="button" onClick={() => setMessage(null)}>
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </section>
        );
      })}

      <h4>Recent collection attempts</h4>
      {!data.attempts.length && <p>No collection attempts yet.</p>}
      {data.attempts.slice(0, 5).map((attempt) => (
        <p key={attempt.id} className="meta">
          {formatInstant(attempt.startedAt)} · {attempt.outcome ?? 'Running'} ·{' '}
          {attempt.completeCount}/{attempt.selectedCount} folders complete
          {attempt.errorCode ? ` · ${attempt.errorCode}` : ''}
        </p>
      ))}
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          void perform(async () => {
            await load();
            setStatus('Outlook browser status reloaded.');
          })
        }
      >
        Reload status
      </button>
      <p className="meta">
        Retry by running the local connector again:{' '}
        <code>npm run sync --workspace @hub/outlook-browser-connector</code>
      </p>
      <p className="meta">
        A read-only collector is not a Microsoft Graph connection and does not
        prove live mailbox coverage.
      </p>
    </section>
  );
}
