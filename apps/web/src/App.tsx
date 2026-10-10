import { useEffect, useState } from 'react';
import type { BootstrapResponse } from '@hub/contracts';
import { loadWorkspace } from './lib/api';
import { AuthGate } from './components/AuthGate';
import { PlannerBoard } from './components/PlannerBoard';
import { CalendarWorkspace } from './components/CalendarWorkspace';
import type { StudyDraft } from './components/CalendarWorkspace';
import { AcademicWorkspace } from './components/AcademicWorkspace';
import { ReminderWorkspace } from './components/ReminderWorkspace';
import type { User } from '@hub/contracts';

type View =
  | 'today'
  | 'calendar'
  | 'classes'
  | 'reminders'
  | 'connections'
  | 'preferences';
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
  const [view, setView] = useState<View>('today');
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
          <span>
            Personal Hub
            <span className="brand-caption">A little more breathing room.</span>
          </span>
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
        <div className="sidebar-note">
          <span className="small-label">SPACE TO FOCUS</span>
          <p>Your plans, classes, and conversations. Together, at your pace.</p>
        </div>
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
          <span>{navigation.find((item) => item.id === view)?.label}</span>
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
            <h1>
              {view === 'today'
                ? 'Make room for what matters.'
                : view === 'connections'
                  ? 'Bring your world together.'
                  : view === 'calendar'
                    ? 'Make time for your plans.'
                    : view === 'classes'
                      ? 'See your learning take shape.'
                      : view === 'reminders'
                        ? 'Keep the next step in sight.'
                        : 'Make yourself at home.'}
            </h1>
            <p>
              {view === 'today'
                ? 'A calm place for your schedule, your next steps, and everything in between.'
                : view === 'connections'
                  ? 'Your existing accounts will meet here, with their sources kept clear.'
                  : view === 'calendar'
                    ? 'Events, repeated commitments, and study time in one calendar.'
                    : view === 'classes'
                      ? 'Your courses, topics, and self-reported progress.'
                      : view === 'reminders'
                        ? 'Scheduled reminders and their delivery history.'
                        : 'Start with a comfortable view. More controls will arrive as the hub grows.'}
            </p>
          </div>

          {workspace.status === 'unavailable' && (
            <div className="connection-error" role="alert">
              <div>
                <strong>The hub server is unavailable.</strong>
                <p>
                  The workspace preview is still here. Live account data has not
                  been connected.
                </p>
              </div>
              <button className="secondary-button" onClick={retryConnection}>
                Retry connection
              </button>
            </div>
          )}

          {view === 'today' && (
            <>
              <section className="welcome-card" aria-labelledby="welcome-title">
                <div>
                  <span className="small-label">A FRESH START</span>
                  <h2 id="welcome-title">Your day starts here.</h2>
                  <p>
                    Add your next steps and reserve time for what matters.
                    Connected accounts will join this view as the hub grows.
                  </p>
                  <button
                    className="primary-button"
                    onClick={() => setView('connections')}
                  >
                    Explore connections <span aria-hidden="true">↗</span>
                  </button>
                </div>
                <div className="welcome-art" aria-hidden="true">
                  <div className="orbit orbit-one" />
                  <div className="orbit orbit-two" />
                  <span className="orbit-center">✳</span>
                </div>
              </section>
              <PlannerBoard />
              <section className="coming-next" aria-labelledby="next-title">
                <span className="small-label">TAKING SHAPE</span>
                <h2 id="next-title">One home for the moving pieces.</h2>
                <div className="feature-grid">
                  <Feature
                    title="Plan your time"
                    description="Calendar, tasks, and gentle reminders."
                  />
                  <Feature
                    title="Keep learning"
                    description="Class progress and study plans that fit."
                  />
                  <Feature
                    title="Find what matters"
                    description="An organized inbox, with you in control."
                  />
                </div>
              </section>
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
              <p className="section-description">
                Connections are planned and are not active yet.
              </p>
              {workspace.status === 'ready' ? (
                <div className="connection-grid">
                  {workspace.data.connections.map((connection) => (
                    <article className="connection-card" key={connection.id}>
                      <div className="connection-card-top">
                        <span className="account-icon" aria-hidden="true">
                          {connection.name.charAt(0)}
                        </span>
                        <span className="status-tag">Not connected</span>
                      </div>
                      <h3>{connection.name}</h3>
                      <p>{connection.description}</p>
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
              <section className="panel preference-panel">
                <span className="small-label">APPEARANCE</span>
                <h2>A quieter screen.</h2>
                <p>
                  E-ink mode uses crisp black and white, clear borders, and a
                  stable layout.
                </p>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={eink}
                    onChange={(event) => setEink(event.target.checked)}
                  />
                  Use e-ink mode
                </label>
              </section>
              <section className="panel preference-panel">
                <span className="small-label">AI & PRIVACY · PLANNED</span>
                <h2>You decide what goes where.</h2>
                <p>
                  Provider routing will follow the sources and content you
                  explicitly label. Sending email will require your approval.
                </p>
                <p className="muted-note">
                  No AI provider is configured and no account content is being
                  processed in this preview.
                </p>
              </section>
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
            <span>A foundation for your everyday.</span>
          </footer>
        </main>
      </div>
    </div>
  );
}

function Feature({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <article className="feature">
      <span className="feature-line" aria-hidden="true" />
      <h3>{title}</h3>
      <p>{description}</p>
    </article>
  );
}
