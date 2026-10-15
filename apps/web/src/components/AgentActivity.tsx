import { useState } from 'react';
import {
  agentRunSchema,
  agentRunsResponseSchema,
  agentWorkerSchema,
} from '@hub/contracts';
import type { Agent, AgentRun } from '@hub/contracts';
import { getJson } from '../lib/api';
import { formatCost } from '../lib/assistant';
import { formatInstant } from '../lib/format';
import { useOnline, useResource } from '../lib/hooks';
import { runStateLabel } from '../lib/agents';
import { Help } from './Help';
import './AgentActivity.css';

/** Worker liveness is independent of one run's progress or execution lease. */
export function AgentWorkerStatus() {
  const online = useOnline();
  const worker = useResource(
    (signal) => getJson('/api/v1/agents/worker', agentWorkerSchema, signal),
    { failure: 'Scheduler status could not be loaded.', refreshMs: 15000 },
  );
  const labels: Record<string, string> = {
    disabled: 'Scheduler disabled',
    'not-configured': 'Scheduler not configured',
    starting: 'Scheduler starting',
    healthy: 'Scheduler healthy',
    unhealthy: 'Scheduler unhealthy',
  };
  return (
    <div className="agent-worker">
      {worker.error ? (
        <>
          <p role="alert" className="form-error">
            {worker.error}
          </p>
          <button
            type="button"
            className="secondary-button"
            disabled={!online || worker.loading}
            onClick={() => void worker.reload()}
          >
            Reload scheduler
          </button>
        </>
      ) : worker.data ? (
        <p
          className={worker.data.state === 'unhealthy' ? 'form-error' : 'meta'}
        >
          {worker.data.state
            ? labels[worker.data.state]
            : 'Scheduler status unavailable'}
          <Help label="Agent scheduler">
            The heartbeat reports scheduler liveness, not progress or success of
            a run.
            {worker.data.disabledReason === 'missing-key' &&
              ' The server needs an OpenRouter key.'}
            {worker.data.disabledReason === 'config' &&
              ' The worker is disabled in server configuration.'}
            {worker.data.lastTick &&
              ` Last heartbeat: ${formatInstant(worker.data.lastTick)}.`}
          </Help>
        </p>
      ) : (
        <p className="meta" role="status">
          Loading scheduler…
        </p>
      )}
      {!online && <p className="meta">Offline — status may be out of date.</p>}
    </div>
  );
}

export function AgentAllowance({ agent }: { agent: Agent }) {
  const spend = agent.spending;
  if (!spend) return <p className="meta">Allowance details unavailable.</p>;
  return (
    <section aria-label="Agent allowance" className="agent-allowance">
      <h3>
        Monthly allowance{' '}
        <Help label="Agent allowance">
          UTC reservation month: {spend.month}. Held amounts include uncertain
          calls, including requests still in progress. Each call reserves its
          bounded allowance before transmission. Reported charges can exceed
          estimates; the shared owner limit also applies. Paused agents do not
          resume automatically when a new month starts.
        </Help>
      </h3>
      <dl>
        <div>
          <dt>Settled</dt>
          <dd>{formatCost(spend.settledMicros)}</dd>
        </div>
        <div>
          <dt>Held</dt>
          <dd>{formatCost(spend.heldMicros)}</dd>
        </div>
        <div>
          <dt>Uncertain holds</dt>
          <dd>{formatCost(spend.uncertainMicros)}</dd>
        </div>
        <div>
          <dt>Remaining</dt>
          <dd>{formatCost(spend.remainingMicros)}</dd>
        </div>
        <div>
          <dt>Cap</dt>
          <dd>{formatCost(spend.capMicros)}</dd>
        </div>
      </dl>
      <p className="meta">Resets {formatInstant(spend.resetsAt)} (UTC month)</p>
      {spend.overCap && (
        <p className="form-error">
          Charges and holds exceed this cap. Review agent settings.
        </p>
      )}
      {spend.uncertainMicros > 0 && (
        <p className="form-error">
          Unsettled calls retain their holds. Lost responses are not resent.
        </p>
      )}
    </section>
  );
}

const progressLabels: Record<string, string> = {
  claimed: 'Preparing',
  'checking-provider': 'Checking provider',
  'provider-request': 'Waiting for provider',
  applying: 'Applying changes',
};

function runErrorMessage(code: string) {
  if (
    [
      'AGENT_BUDGET_EXCEEDED',
      'REQUEST_BUDGET_EXCEEDED',
      'MONTHLY_BUDGET_EXCEEDED',
    ].includes(code)
  )
    return 'The remaining allowance cannot fund this call. Review spending limits.';
  if (code === 'BUDGET_UNSET')
    return 'Configure spending limits before running this agent.';
  if (code === 'ASSISTANT_NOT_CONFIGURED')
    return 'The server needs an OpenRouter key.';
  if (['AGENT_CHANGED', 'AGENT_PAUSED', 'AGENT_UNAVAILABLE'].includes(code))
    return 'The agent changed or is unavailable. Review its settings.';
  if (code === 'AGENT_LABELED')
    return 'The agent privacy labels block this provider.';
  if (['LEASE_EXPIRED', 'AGENT_LEASE_LOST'].includes(code))
    return 'This run passed its execution deadline. It was not resent.';
  if (
    [
      'PROVIDER_TIMEOUT',
      'PROVIDER_TRANSPORT',
      'PROVIDER_RESPONSE',
      'PROVIDER_BILLING',
    ].includes(code)
  )
    return 'The provider outcome is unknown. This call will not be resent.';
  if (code === 'PROVIDER_RATE_LIMITED')
    return 'The provider is limiting requests.';
  if (
    [
      'ASSISTANT_CATALOG_UNAVAILABLE',
      'ASSISTANT_MODEL_UNAVAILABLE',
      'ASSISTANT_MODEL_NOT_PRIVATE',
      'PROVIDER_UNAVAILABLE',
    ].includes(code)
  )
    return 'An approved provider is unavailable. Review the model settings.';
  return 'This run could not finish. Review agent settings.';
}

function RunDetails({ run }: { run: AgentRun }) {
  const state = run.leaseExpired
    ? { label: 'Deadline passed', tone: 'warning' }
    : runStateLabel(run.state);
  const outcomes: Record<string, string> = {
    quiet: 'No changes',
    applied: 'Changes applied',
    'needs-approval': 'Review required',
    warning: 'Needs attention',
    failed: 'Failed',
  };
  return (
    <>
      <p className={`agent-state--${state.tone}`}>
        <strong>{state.label}</strong> · {formatInstant(run.createdAt)}
      </p>
      {run.state === 'running' && !run.leaseExpired && run.progressStage && (
        <p className="meta">{progressLabels[run.progressStage] ?? 'Working'}</p>
      )}
      {run.leaseExpired && (
        <p role="alert" className="form-error">
          This run passed its execution deadline. Automatic changes are blocked;
          a provider request already sent may still finish.
        </p>
      )}
      {run.outcome && run.outcome !== 'failed' && (
        <p className="meta">{outcomes[run.outcome]}</p>
      )}
      {run.cancelReason && (
        <p className="meta">Reason: {run.cancelReason.replaceAll('-', ' ')}</p>
      )}
      {run.startedAt && (
        <p className="meta">Started {formatInstant(run.startedAt)}</p>
      )}
      {run.progressAt && run.state === 'running' && (
        <p className="meta">Last progress {formatInstant(run.progressAt)}</p>
      )}
      {run.leaseUntil && run.state === 'running' && (
        <p className="meta">
          Execution deadline {formatInstant(run.leaseUntil)}
        </p>
      )}
      {run.finishedAt && (
        <p className="meta">Finished {formatInstant(run.finishedAt)}</p>
      )}
      {run.retryAt && (
        <p className="meta">Retry at {formatInstant(run.retryAt)}</p>
      )}
      <p className="meta">
        Attempts: {run.attempts} · Settled {formatCost(run.settledMicros)} ·
        Held {formatCost(run.heldMicros)}
      </p>
      {run.errorCode && (
        <p className="form-error">
          {runErrorMessage(run.errorCode)}
          <Help label="Run diagnostics">
            Code: {run.errorCode}. Execution deadlines prevent an expired worker
            from applying changes.
          </Help>
        </p>
      )}
      {run.state === 'uncertain' && (
        <p className="form-error">
          The provider outcome is unknown. This call will not be resent.
        </p>
      )}
      {!run.turnId && ['failed', 'blocked'].includes(run.state) && (
        <p className="meta">No answer was saved for this run.</p>
      )}
    </>
  );
}

/** A single bounded page; cursor conflicts always offer a fresh first page. */
function AgentRunHistory({ agent }: { agent: Agent }) {
  const online = useOnline();
  const [cursor, setCursor] = useState<{ id: string; version: number }>();
  const history = useResource(
    (signal) => {
      const query = new URLSearchParams({ limit: '20' });
      if (cursor) {
        query.set('after', cursor.id);
        query.set('expectedCursorVersion', String(cursor.version));
      }
      return getJson(
        `/api/v1/agents/${agent.id}/runs?${query}`,
        agentRunsResponseSchema,
        signal,
      );
    },
    {
      failure:
        'Run history changed or could not be loaded. Reload the newest runs.',
      key: `${agent.id}:${cursor?.id ?? ''}:${cursor?.version ?? ''}:${agent.lastRun?.version ?? ''}`,
    },
  );
  const newest = () => {
    if (cursor) setCursor(undefined);
    else void history.reload();
  };
  return (
    <div className="agent-run-history">
      {history.error && (
        <p role="alert" className="form-error">
          {history.error}
        </p>
      )}
      {history.loading && (
        <p role="status" className="meta">
          Loading runs…
        </p>
      )}
      {!history.loading && history.data && !history.error && (
        <>
          <p className="meta">
            {history.data.totalCount} runs · Updated{' '}
            {formatInstant(history.data.asOf)}
          </p>
          {history.data.runs.length ? (
            <ol aria-label="Agent runs">
              {history.data.runs.map((run) => (
                <li key={run.id}>
                  <RunDetails run={run} />
                </li>
              ))}
            </ol>
          ) : (
            <p className="meta">No runs yet.</p>
          )}
        </>
      )}
      <div className="form-actions">
        <button
          type="button"
          className="secondary-button"
          disabled={!online || history.loading}
          onClick={newest}
        >
          Reload newest runs
        </button>
        {history.data?.nextAfter && !history.error && (
          <button
            type="button"
            className="secondary-button"
            disabled={!online || history.loading}
            onClick={() => setCursor(history.data!.nextAfter!)}
          >
            Older runs
          </button>
        )}
      </div>
    </div>
  );
}

export function AgentActivity({ agent }: { agent: Agent }) {
  const online = useOnline();
  const [open, setOpen] = useState(false);
  const parsed = agentRunSchema.safeParse(agent.activeRun ?? agent.lastRun);
  const run = parsed.success ? parsed.data : null;
  return (
    <div className="agent-activity">
      {!online && (
        <p className="form-error">
          Offline: run and allowance details may be out of date.
        </p>
      )}
      {agent.nextRunAt && (
        <p className="meta">Next scheduled {formatInstant(agent.nextRunAt)}</p>
      )}
      <AgentAllowance agent={agent} />
      {run &&
        [
          'running',
          'queued',
          'retry-scheduled',
          'uncertain',
          'blocked',
        ].includes(run.state) && (
          <section aria-label="Current agent run">
            <RunDetails run={run} />
          </section>
        )}
      <details onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>Run history</summary>
        {open && <AgentRunHistory agent={agent} />}
      </details>
    </div>
  );
}
