import { Suspense, useEffect, useRef, useState } from 'react';
import { loadWorkspace } from './lib/api';
import { SyncStatus } from './components/SyncStatus';
import { AuthGate } from './components/AuthGate';
import { PlannerBoard } from './components/PlannerBoard';
import type { StudyDraft } from './components/CalendarWorkspace';
import type { User } from '@hub/contracts';
import { useRoute, viewLabels } from './lib/router';
import type { View } from './lib/router';
import type { WorkspaceState } from './views/ConnectionsView';
import {
  AcademicWorkspace,
  CalendarWorkspace,
  ConnectionsView,
  PreferencesView,
  ReminderWorkspace,
  preloadViews,
} from './views/lazy';

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
  useEffect(preloadViews, []);
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

          <Suspense fallback={<p role="status">Loading…</p>}>
            {view === 'calendar' && (
              <CalendarWorkspace studyDraft={studyDraft} />
            )}
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
              <ConnectionsView workspace={workspace} />
            )}
            {view === 'preferences' && (
              <PreferencesView eink={eink} onEinkChange={setEink} />
            )}
          </Suspense>

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
