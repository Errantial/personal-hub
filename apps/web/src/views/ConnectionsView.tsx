import type { BootstrapResponse } from '@hub/contracts';
import { Help } from '../components/Help';
import { CanvasConnection } from '../components/CanvasConnection';
import { CanvasLmsConnection } from '../components/CanvasLmsConnection';
import { CanvasReconciliation } from '../components/CanvasReconciliation';

export type WorkspaceState =
  | { status: 'loading' }
  | { status: 'unavailable' }
  | { status: 'ready'; data: BootstrapResponse };

export function ConnectionsView({ workspace }: { workspace: WorkspaceState }) {
  return (
    <section
      className="connections-section"
      aria-labelledby="connections-title"
    >
      <h2 id="connections-title">Your accounts</h2>
      <CanvasConnection />
      <CanvasLmsConnection />
      <CanvasReconciliation />
      <Help label="Connections">
        Email and Proton Calendar connections are not implemented yet.
      </Help>
      {workspace.status === 'ready' ? (
        <div className="connection-grid">
          {workspace.data.connections
            .filter((connection) => connection.id !== 'canvas')
            .map((connection) => (
              <article className="connection-card" key={connection.id}>
                <div className="connection-card-top">
                  <span className="account-icon" aria-hidden="true">
                    {connection.name.charAt(0)}
                  </span>
                  <span className="status-tag">Not connected</span>
                </div>
                <h3>{connection.name}</h3>
                <Help label={connection.name}>{connection.description}</Help>
              </article>
            ))}
        </div>
      ) : (
        <div className="panel connection-placeholder">
          <p>
            {workspace.status === 'loading'
              ? 'Loading connection information…'
              : 'Connect to the hub server to view the planned accounts.'}
          </p>
        </div>
      )}
    </section>
  );
}
