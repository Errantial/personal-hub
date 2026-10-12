import { canvasConnectionSchema } from '@hub/contracts';
import type { BootstrapResponse } from '@hub/contracts';
import { Help } from '../components/Help';
import { Link } from '../components/Link';
import { ReadState } from '../components/ReadState';
import { StatusChip } from '../components/StatusChip';
import { CanvasConnection } from '../components/CanvasConnection';
import { CanvasLmsConnection } from '../components/CanvasLmsConnection';
import { CanvasReconciliation } from '../components/CanvasReconciliation';
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
  return (
    <section
      className="connections-section"
      aria-labelledby="connections-title"
    >
      <h2 id="connections-title">Connections</h2>
      <Help label="Connections">
        Email and Proton Calendar connections are not implemented yet.
      </Help>
      <div className="connection-grid">
        <CanvasCard navigate={navigate} />
        {workspace.status === 'ready' &&
          workspace.data.connections
            .filter((connection) => connection.id !== 'canvas')
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
      {tab === 'matching' && <CanvasReconciliation />}
    </section>
  );
}
