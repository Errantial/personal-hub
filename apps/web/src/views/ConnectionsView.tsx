import {
  canvasConnectionSchema,
  outlookAccessGateSchema,
} from '@hub/contracts';
import type { BootstrapResponse } from '@hub/contracts';
import { Help } from '../components/Help';
import { Link } from '../components/Link';
import { ReadState } from '../components/ReadState';
import { StatusChip } from '../components/StatusChip';
import { CanvasConnection } from '../components/CanvasConnection';
import { CanvasLmsConnection } from '../components/CanvasLmsConnection';
import { CanvasBrowserConnection } from '../components/CanvasBrowserConnection';
import { CanvasReconciliation } from '../components/CanvasReconciliation';
import { EmailConnectors } from '../components/EmailConnectors';
import { OutlookAccessGate } from '../components/OutlookAccessGate';
import { getSnapshot } from '../lib/api';
import { useResource } from '../lib/hooks';
import { canvasTabLabels, canvasTabs } from '../lib/router';
import type { CanvasTab, Route } from '../lib/router';

export type WorkspaceState =
  | { status: 'loading' }
  | { status: 'unavailable' }
  | { status: 'ready'; data: BootstrapResponse };

type SettingsRoute = Extract<Route, { name: 'settings' }>;

/** One line of Canvas feed state for the provider card. */
function feedStatus(
  data: { configured: boolean; enabled: boolean } | undefined,
) {
  if (!data) return null;
  if (!data.configured) return 'Feed not configured';
  return data.enabled ? 'Auto refresh on' : 'Auto refresh paused';
}

function CanvasCard({ navigate }: { navigate: (route: Route) => void }) {
  const canvas = useResource(
    (signal) =>
      getSnapshot('/api/v1/connections/canvas', canvasConnectionSchema, signal),
    { failure: 'Canvas status unavailable. Retry Canvas.' },
  );
  const status = feedStatus(canvas.data?.data);
  return (
    <article className="connection-card panel" aria-label="Canvas">
      <h3>Canvas</h3>
      {status && <StatusChip>{status}</StatusChip>}
      <ReadState resource={canvas} label="Canvas" />
      <Link
        route={{
          name: 'settings',
          section: 'connections',
          connection: 'canvas',
        }}
        navigate={navigate}
        className="link-button"
      >
        Manage Canvas
      </Link>
    </article>
  );
}

const outlookStatusLabel = {
  unknown: 'Access gate not established',
  'ready-for-adapter': 'Ready for delegated adapter work',
  'admin-action-required': 'Admin action required',
  'scope-review-required': 'Mailbox scope review required',
  blocked: 'Access blocked',
} as const;

function OutlookCard({ navigate }: { navigate: (route: Route) => void }) {
  const access = useResource(
    (signal) =>
      getSnapshot(
        '/api/v1/connections/outlook/access',
        outlookAccessGateSchema,
        signal,
      ),
    { failure: 'Outlook access status unavailable. Retry Outlook.' },
  );
  return (
    <article className="connection-card panel" aria-label="School Outlook">
      <h3>School Outlook</h3>
      {access.data?.data && (
        <StatusChip>{outlookStatusLabel[access.data.data.status]}</StatusChip>
      )}
      <ReadState resource={access} label="Outlook" />
      <Help label="School Outlook">
        School mail remains unavailable until the access gate proves the
        Microsoft 365 backend, mailbox scope, app registration and delegated
        consent policy. Reviewing the gate does not sign in or read mail.
      </Help>
      <Link
        route={{
          name: 'settings',
          section: 'connections',
          connection: 'outlook',
        }}
        navigate={navigate}
        className="link-button"
      >
        Review Outlook access
      </Link>
    </article>
  );
}

/** Settings › Connections: one card per provider, Canvas opens its detail. */
export function ConnectionsView({
  workspace,
  route,
  navigate,
}: {
  workspace: WorkspaceState;
  route: SettingsRoute;
  navigate: (route: Route) => void;
}) {
  if (route.connection === 'canvas')
    return <CanvasDetail tab={route.tab ?? 'feed'} navigate={navigate} />;
  if (route.connection === 'outlook')
    return <OutlookDetail navigate={navigate} />;
  return (
    <section
      className="connections-section"
      aria-labelledby="connections-title"
    >
      <h2 id="connections-title">Connections</h2>
      <Help label="Connections">
        Proton Mail is imported read-only through a connector on the computer
        running Proton Bridge. School Outlook has a feasibility/access gate but
        no mailbox adapter yet. Proton Calendar is not implemented yet.
      </Help>
      <div className="connection-grid">
        <CanvasCard navigate={navigate} />
        <OutlookCard navigate={navigate} />
        {workspace.status === 'ready' &&
          workspace.data.connections
            .filter(
              (connection) =>
                !['canvas', 'outlook', 'proton-mail'].includes(connection.id),
            )
            .map((connection) => (
              <article
                className="connection-card panel"
                key={connection.id}
                aria-label={connection.name}
              >
                <h3>{connection.name}</h3>
                <StatusChip>Not available yet</StatusChip>
                <Help label={connection.name}>{connection.description}</Help>
              </article>
            ))}
      </div>
      {workspace.status !== 'ready' && (
        <p role="status">
          {workspace.status === 'loading'
            ? 'Loading other providers…'
            : 'Connect to the hub server to view the other providers.'}
        </p>
      )}
      <EmailConnectors />
    </section>
  );
}

function OutlookDetail({ navigate }: { navigate: (route: Route) => void }) {
  return (
    <section className="connections-section" aria-labelledby="outlook-title">
      <Link
        route={{ name: 'settings', section: 'connections' }}
        navigate={navigate}
        className="link-button"
      >
        Back to connections
      </Link>
      <h2 id="outlook-title">School Outlook</h2>
      <OutlookAccessGate />
    </section>
  );
}

/** Canvas detail: the calendar feed, the course API and entry matching. */
function CanvasDetail({
  tab,
  navigate,
}: {
  tab: CanvasTab;
  navigate: (route: Route) => void;
}) {
  return (
    <section className="connections-section" aria-labelledby="canvas-title">
      <Link
        route={{ name: 'settings', section: 'connections' }}
        navigate={navigate}
        className="link-button"
      >
        Back to connections
      </Link>
      <h2 id="canvas-title">Canvas</h2>
      <nav aria-label="Canvas sections">
        <ul className="canvas-tabs">
          {canvasTabs.map((item) => (
            <li key={item}>
              <Link
                route={{
                  name: 'settings',
                  section: 'connections',
                  connection: 'canvas',
                  ...(item === 'feed' ? {} : { tab: item }),
                }}
                navigate={navigate}
                current={item === tab}
              >
                {canvasTabLabels[item]}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {tab === 'feed' && <CanvasConnection />}
      {tab === 'api' && <CanvasLmsConnection />}
      {tab === 'browser' && <CanvasBrowserConnection />}
      {tab === 'matching' && <CanvasReconciliation />}
    </section>
  );
}
