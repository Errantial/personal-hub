import { useEffect, useRef, useState } from 'react';
import type { BootstrapResponse } from '@hub/contracts';
import { loadWorkspace } from './lib/api';
import { Help } from './components/Help';
import { SyncStatus } from './components/SyncStatus';
import { AuthGate } from './components/AuthGate';
import { PlannerBoard } from './components/PlannerBoard';
import { CalendarWorkspace } from './components/CalendarWorkspace';
import type { StudyDraft } from './components/CalendarWorkspace';
import { AcademicWorkspace } from './components/AcademicWorkspace';
import { ReminderWorkspace } from './components/ReminderWorkspace';
import { AccountSettings } from './components/AccountSettings';
import { CanvasConnection } from './components/CanvasConnection';
import { CanvasLmsConnection } from './components/CanvasLmsConnection';
import { CanvasReconciliation } from './components/CanvasReconciliation';
import { AIRoutingSettings } from './components/AIRoutingSettings';
import { AIPreflights } from './components/AIPreflights';
import { AIBudgetSettings } from './components/AIBudgetSettings';
import type { User } from '@hub/contracts';
import { useRoute, viewLabels } from './lib/router';
import type { View } from './lib/router';

type WorkspaceState =
  | { status: 'loading' }
  | { status: 'unavailable' }
  | { status: 'ready'; data: BootstrapResponse };
const navigation: { id: View; label: string; icon: string }[] = [
  { id: 'today', label: 'Today', icon: '◷' },
  { id: 'calendar', label: 'Calendar', icon: '\u25a6' },
  { id: 'classes', label: 'Classes', icon: '\u25a4' },
  { id: 'reminders', label: 'Reminders', icon: '\u25f4' },
  { id: 'connections', label: 'Connections', icon: '⌘' },
  { id: 'preferences', label: 'Preferences', icon: '☷' },
];

function readEinkPreference() {
  try {
    return localStorage.getItem('hub:eink') === 'true';
  } catch {
    return false;
  }
}

export function App() {
  return (
    <AuthGate>
      {(user, signOut) => <Workspace user={user} signOut={signOut} />}
    </AuthGate>
  );
}

function Workspace({
  user,
  signOut,
}: {
  user: User;
  signOut: () => Promise<void>;
}) {
  const [route, navigate] = useRoute();
  const view = route.name;
  const heading = useRef<HTMLHeadingElement>(null);
  const navigated = useRef(false);
  const setView = (next: View) => navigate({ name: next });
  useEffect(() => {
    // Move focus to the new view's heading after in-app or Back navigation,
    // but not on first load.
    if (navigated.current) heading.current?.focus();
    navigated.current = true;
  }, [view]);
  const [studyDraft, setStudyDraft] = useState<StudyDraft | null>(null);
  const [eink, setEink] = useState(readEinkPreference);
  const [workspace, setWorkspace] = useState<WorkspaceState>({
    status: 'loading',
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    void loadWorkspace().then(
      ({ bootstrap }) => {
        if (current) setWorkspace({ status: 'ready', data: bootstrap });
      },
      () => {
        if (current) setWorkspace({ status: 'unavailable' });
      },
    );
    return () => {
      current = false;
    };
  }, [attempt]);

  useEffect(() => {
    document.documentElement.dataset.theme = eink ? 'eink' : 'standard';
    try {
      localStorage.setItem('hub:eink', String(eink));
    } catch {
      /* Appearance still works without storage. */
    }
  }, [eink]);

  function retryConnection() {
    setWorkspace({ status: 'loading' });
    setAttempt((value) => value + 1);
  }

  const date = new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(new Date());

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(event) => {
            event.preventDefault();
            setView('today');
          }}
          aria-label="Personal Hub home"
        >
          <span className="brand-mark" aria-hidden="true">
            h
          </span>
          <span>Personal Hub</span>
        </a>
        <nav aria-label="Main navigation">
          <span className="nav-caption">YOUR WORKSPACE</span>
          {navigation.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${view === item.id ? 'active' : ''}`}
              aria-current={view === item.id ? 'page' : undefined}
              onClick={() => setView(item.id)}
            >
              <span className="nav-icon" aria-hidden="true">
                {item.icon}
              </span>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="profile">
          <span className="avatar" aria-hidden="true">
            Y
          </span>
          <span>
            {user.email}
            <small>Personal workspace</small>
          </span>
        </div>
      </aside>

      <div className="main-shell">
        <header className="topbar">
          <span>{viewLabels[view]}</span>
          <div className="topbar-actions">
            <button
              className="text-button"
              onClick={() => {
                void signOut();
              }}
            >
              Sign out
            </button>
            <button
              className="theme-button"
              aria-pressed={eink}
              onClick={() => setEink((value) => !value)}
            >
              E-ink mode <span aria-hidden="true">{eink ? 'On' : 'Off'}</span>
            </button>
          </div>
        </header>

        <main id="main" tabIndex={-1}>
          <div className="page-heading">
            <span className="eyebrow">
              {view === 'today' ? date : 'YOUR PERSONAL HUB'}
            </span>
            <h1 ref={heading} tabIndex={-1}>
              {viewLabels[view]}
            </h1>
          </div>

          {workspace.status === 'unavailable' && (
            <div className="connection-error" role="alert">
              <div>
                <strong>The hub server is unavailable.</strong>
              </div>
              <button className="secondary-button" onClick={retryConnection}>
                Retry connection
              </button>
            </div>
          )}

          <SyncStatus />
          {view === 'today' && (
            <>
              <PlannerBoard />
            </>
          )}

          {view === 'calendar' && <CalendarWorkspace studyDraft={studyDraft} />}
          {view === 'classes' && (
            <AcademicWorkspace
              onSchedule={(draft) => {
                setStudyDraft(draft);
                setView('calendar');
              }}
            />
          )}
          {view === 'reminders' && <ReminderWorkspace />}

          {view === 'connections' && (
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
                        <Help label={connection.name}>
                          {connection.description}
                        </Help>
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
          )}

          {view === 'preferences' && (
            <div className="preferences-grid">
              <AccountSettings />
              <section className="panel preference-panel">
                <span className="small-label">APPEARANCE</span>
                <h2>Appearance</h2>
                <Help label="E-ink">
                  E-ink mode uses crisp black and white, clear borders, and a
                  stable layout.
                </Help>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={eink}
                    onChange={(event) => setEink(event.target.checked)}
                  />
                  Use e-ink mode
                </label>
              </section>
              <AIRoutingSettings />
              <AIBudgetSettings />
              <AIPreflights />
            </div>
          )}

          <footer className="workspace-footer">
            <span className={`api-indicator ${workspace.status}`} role="status">
              <span className="status-dot" aria-hidden="true" />
              {workspace.status === 'ready'
                ? 'Hub API connected'
                : workspace.status === 'loading'
                  ? 'Connecting to hub API…'
                  : 'Hub API unavailable'}
            </span>
          </footer>
        </main>
      </div>
    </div>
  );
}
