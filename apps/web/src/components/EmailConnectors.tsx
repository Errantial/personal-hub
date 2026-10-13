import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  emailConnectorCreatedSchema,
  emailConnectorsResponseSchema,
} from '@hub/contracts';
import type { EmailConnector } from '@hub/contracts';
import { getJson } from '../lib/api';
import { formatDate, formatInstant } from '../lib/format';
import { useMutation, useResource } from '../lib/hooks';
import { LabelSelect } from './ClassForms';
import { useConfirm } from './ConfirmDialog';
import { Help } from './Help';
import { StatusChip } from './StatusChip';
import './EmailConnectors.css';

/**
 * Settings › Connections › Email: tokens for the read-only Proton Bridge
 * connector, and per-folder import counts that show completeness.
 */
export function EmailConnectors() {
  const list = useResource(
    (signal) =>
      getJson(
        '/api/v1/email/connectors',
        emailConnectorsResponseSchema,
        signal,
      ),
    { failure: 'Email connectors unavailable. Retry.' },
  );
  const [token, setToken] = useState('');
  const [adding, setAdding] = useState(false);
  const connectors = list.data?.connectors ?? [];
  return (
    <section
      className="panel preference-panel"
      aria-labelledby="email-connectors-title"
    >
      <h2 id="email-connectors-title">Email (Proton Bridge)</h2>
      <Help label="Email connector">
        A small program on the computer running Proton Bridge reads mail
        read-only (nothing is marked read or moved) and uploads headers and
        plain text from every folder except Spam and Trash, starting 30 days
        before the connector was added. Attachments are counted, never uploaded.
        The label you choose applies to all imported mail. Revoking stops
        uploads; imported mail stays.
      </Help>
      {list.error && (
        <p role="alert" className="form-error">
          {list.error}
        </p>
      )}
      <button
        type="button"
        className="secondary-button"
        disabled={list.loading}
        onClick={() => void list.reload()}
      >
        Reload connectors
      </button>
      {list.data && !connectors.length && <p>No connector yet.</p>}
      {connectors.map((connector) => (
        <ConnectorRow
          key={connector.id}
          connector={connector}
          onChanged={() => void list.reload()}
        />
      ))}
      {token && (
        <div className="email-token" role="status">
          <p>
            <strong>Connector token (shown once).</strong> Put it in the
            connector settings file on the Bridge computer as{' '}
            <code>hubToken</code>, with <code>hubUrl</code> set to this site. Do
            not share it.
          </p>
          <input
            readOnly
            aria-label="Connector token"
            value={token}
            onFocus={(event) => event.target.select()}
          />
          <button
            type="button"
            className="secondary-button"
            onClick={() => setToken('')}
          >
            I saved it
          </button>
        </div>
      )}
      {adding ? (
        <AddConnector
          onCancel={() => setAdding(false)}
          onCreated={(value) => {
            setToken(value);
            setAdding(false);
            void list.reload();
          }}
        />
      ) : (
        <button
          type="button"
          className="primary-button"
          onClick={() => setAdding(true)}
        >
          Add connector
        </button>
      )}
    </section>
  );
}

function AddConnector({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (token: string) => void;
}) {
  const [name, setName] = useState('Proton Bridge');
  const [sensitivity, setSensitivity] =
    useState<EmailConnector['sensitivity']>('personal');
  const save = useMutation();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = await save.run(
      emailConnectorCreatedSchema,
      'POST',
      '/api/v1/email/connectors',
      { name: name.trim(), sensitivity },
      'Could not add the connector. Try again.',
    );
    if (result) onCreated(result.token);
  }
  return (
    <form
      className="editor-form"
      aria-label="Add email connector"
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <label>
        Name
        <input
          required
          maxLength={100}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <LabelSelect
        label="Imported mail label"
        value={sensitivity}
        onChange={setSensitivity}
      />
      {save.error && (
        <p role="alert" className="form-error">
          {save.error}
        </p>
      )}
      <div className="form-actions">
        <button
          className="primary-button"
          disabled={save.pending || !name.trim()}
        >
          {save.pending ? 'Adding…' : 'Add connector'}
        </button>
        <button type="button" className="secondary-button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function ConnectorRow({
  connector,
  onChanged,
}: {
  connector: EmailConnector;
  onChanged: () => void;
}) {
  const revoke = useMutation();
  const [dialog, confirm] = useConfirm();
  const labels = {
    unlabeled: 'Unlabeled',
    personal: 'Personal',
    restricted: 'Restricted',
  };
  async function revokeConnector() {
    if (
      !(await confirm({
        title: `Revoke “${connector.name}”?`,
        message:
          'Its token stops working at once. Imported mail stays. To resume, add a new connector.',
        confirmLabel: 'Revoke connector',
      }))
    )
      return;
    const result = await revoke.run(
      emailConnectorsResponseSchema,
      'POST',
      `/api/v1/email/connectors/${connector.id}/revoke`,
      { expectedVersion: connector.version },
      'Could not revoke. Try again.',
    );
    if (result) onChanged();
  }
  return (
    <article className="email-connector" aria-label={connector.name}>
      <h3>
        {connector.name}{' '}
        <StatusChip tone={connector.revokedAt ? 'attention' : 'neutral'}>
          {connector.revokedAt
            ? 'Revoked'
            : connector.lastSeenAt
              ? 'Connected'
              : 'Waiting for first sync'}
        </StatusChip>
      </h3>
      <p className="meta">
        Label: {labels[connector.sensitivity]} · Importing from{' '}
        {formatDate(connector.since)}
        {connector.lastSeenAt &&
          ` · Last sync ${formatInstant(connector.lastSeenAt)}`}
      </p>
      {connector.folders.length > 0 && (
        <div className="table-scroll">
          <table className="email-folders">
            <caption className="visually-hidden">
              Folders for {connector.name}
            </caption>
            <thead>
              <tr>
                <th scope="col">Folder</th>
                <th scope="col">On Bridge</th>
                <th scope="col">Since start</th>
                <th scope="col">Imported</th>
              </tr>
            </thead>
            <tbody>
              {connector.folders.map((folder) => (
                <tr key={folder.path}>
                  <th scope="row">{folder.path}</th>
                  <td>{folder.exists}</td>
                  <td>{folder.inWindow}</td>
                  <td>
                    {folder.imported}
                    {folder.imported < folder.inWindow && (
                      <span> (incomplete)</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {revoke.error && (
        <p role="alert" className="form-error">
          {revoke.error}
        </p>
      )}
      {!connector.revokedAt && (
        <button
          type="button"
          className="danger-button"
          disabled={revoke.pending}
          onClick={() => void revokeConnector()}
        >
          Revoke connector
        </button>
      )}
      {dialog}
    </article>
  );
}
