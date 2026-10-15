import {
  Suspense,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { notificationSummarySchema } from '@hub/contracts';
import type { User } from '@hub/contracts';
import {
  applyAppearance,
  readAppearance,
  watchScheme,
  writeAppearance,
} from './lib/appearance';
import { getJson, loadWorkspace } from './lib/api';
import { useResource } from './lib/hooks';
import { routePath, useRoute, viewLabels } from './lib/router';
import type { Route, View } from './lib/router';
import { AuthGate } from './components/AuthGate';
import { Banner } from './components/Banner';
import { Icon } from './components/Icon';
import type { IconName } from './components/Icon';
import { Link } from './components/Link';
import {
  SyncConflicts,
  SyncDetails,
  SyncIndicator,
  useTaskSync,
} from './components/SyncStatus';
import type { StudyDraft } from './lib/calendar';
import type { WorkspaceState } from './views/ConnectionsView';
import {
  AssistantView,
  ClassesView,
  CalendarView,
  InboxView,
  SettingsView,
  TasksView,
  TodayView,
  preloadViews,
} from './views/lazy';

/** Primary destinations stay visible on every screen size; the secondary
 *  ones move into More below 1024 px (docs/ui-guidelines.md §3). */
const primary: { id: View; icon: IconName }[] = [
  { id: 'today', icon: 'today' },
  { id: 'assistant', icon: 'assistant' },
  { id: 'calendar', icon: 'calendar' },
  { id: 'tasks', icon: 'tasks' },
  { id: 'classes', icon: 'classes' },
];
const secondary: { id: View; icon: IconName }[] = [
  { id: 'inbox', icon: 'inbox' },
  { id: 'settings', icon: 'settings' },
];

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
  const shownPath = useRef(routePath(route));
  const [studyDraft, setStudyDraft] = useState<StudyDraft | null>(null);
  const clearStudyDraft = useCallback(() => setStudyDraft(null), []);
  const [appearance, setAppearance] = useState(readAppearance);
  const eink = appearance.eink;
  const setEink = useCallback(
    (value: boolean) =>
      setAppearance((current) => ({ ...current, eink: value })),
    [],
  );
  const [workspace, setWorkspace] = useState<WorkspaceState>({
    status: 'loading',
  });
  const [attempt, setAttempt] = useState(0);
  const sync = useTaskSync();
  const inbox = useResource(
    (signal) =>
      getJson(
        '/api/v1/notifications/summary',
        notificationSummarySchema,
        signal,
      ),
    { failure: '' },
  );
  // The server counts every unread record. If the count cannot be read, the
  // last known value stays (it is never replaced by zero).
  const unread = inbox.data?.unreadCount ?? 0;

  useEffect(() => {
    // Move focus to the new view's heading after in-app or Back navigation,
    // but not on first load (compared by path, so re-runs are harmless).
    const path = routePath(route);
    if (path === shownPath.current) return;
    shownPath.current = path;
    heading.current?.focus();
  }, [route]);
  useEffect(preloadViews, []);
  const reloadInbox = inbox.reload;
  useEffect(() => {
    void reloadInbox();
  }, [view, reloadInbox]);

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
    applyAppearance(appearance);
    writeAppearance(appearance);
    // 'system' follows the device when its light/dark setting changes.
    if (appearance.scheme !== 'system' || appearance.eink) return;
    return watchScheme(() => applyAppearance(appearance));
  }, [appearance]);

  const today = new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(new Date());

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Navigation
        view={view}
        navigate={navigate}
        unread={unread}
        eink={eink}
        onEinkChange={setEink}
      />
      <div className="main-shell">
        <header className="header">
          <div className="header__title">
            <h1 ref={heading} tabIndex={-1}>
              {viewLabels[view]}
            </h1>
            {view === 'today' && <p className="header__date">{today}</p>}
          </div>
          <SyncIndicator state={sync} />
        </header>
        <SyncDetails state={sync} />
        <main id="main" tabIndex={-1}>
          {workspace.status === 'unavailable' && (
            <Banner
              title="The hub server is unavailable."
              actions={
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    setWorkspace({ status: 'loading' });
                    setAttempt((value) => value + 1);
                  }}
                >
                  Retry connection
                </button>
              }
            >
              <p>Cached views remain available; changes to tasks are queued.</p>
            </Banner>
          )}
          <SyncConflicts state={sync} navigate={navigate} />
          <Suspense fallback={<p role="status">Loading…</p>}>
            {view === 'today' && <TodayView navigate={navigate} />}
            {route.name === 'assistant' && (
              <AssistantView
                route={route}
                navigate={navigate}
                onChanged={reloadInbox}
              />
            )}
            {route.name === 'tasks' && (
              <TasksView route={route} navigate={navigate} />
            )}
            {route.name === 'calendar' && (
              <CalendarView
                route={route}
                navigate={navigate}
                studyDraft={studyDraft}
                onStudyUsed={clearStudyDraft}
              />
            )}
            {route.name === 'classes' && (
              <ClassesView
                route={route}
                navigate={navigate}
                onSchedule={(draft) => {
                  setStudyDraft(draft);
                  navigate({ name: 'calendar', editor: { kind: 'new' } });
                }}
              />
            )}
            {route.name === 'inbox' && (
              <InboxView
                route={route}
                navigate={navigate}
                onChanged={reloadInbox}
              />
            )}
            {route.name === 'settings' && (
              <SettingsView
                route={route}
                navigate={navigate}
                workspace={workspace}
                appearance={appearance}
                onAppearanceChange={setAppearance}
                user={user}
                signOut={signOut}
              />
            )}
          </Suspense>
        </main>
      </div>
    </div>
  );
}

function Navigation({
  view,
  navigate,
  unread,
  eink,
  onEinkChange,
}: {
  view: View;
  navigate: (route: Route) => void;
  unread: number;
  eink: boolean;
  onEinkChange: (value: boolean) => void;
}) {
  const [more, setMore] = useState(false);
  const panel = useId();
  const container = useRef<HTMLElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  useEffect(() => setMore(false), [view]);
  useEffect(() => {
    if (!more) return;
    const outside = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setMore(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setMore(false);
      moreButton.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [more]);

  const item = ({ id, icon }: { id: View; icon: IconName }) => (
    <li key={id}>
      <Link
        className="nav__link"
        route={
          id === 'settings' ? { name: id, section: 'account' } : { name: id }
        }
        navigate={navigate}
        current={view === id}
      >
        <Icon name={icon} />
        <span className="nav__label">{viewLabels[id]}</span>
        {id === 'inbox' && unread > 0 && (
          <span className="nav__count">
            {unread}
            <span className="visually-hidden"> unread</span>
          </span>
        )}
      </Link>
    </li>
  );
  const einkToggle = (
    <button
      type="button"
      className="nav__link nav__toggle"
      aria-pressed={eink}
      onClick={() => onEinkChange(!eink)}
    >
      <Icon name="eink" />
      <span className="nav__label">E-ink mode</span>
      <span className="nav__state" aria-hidden="true">
        {eink ? 'On' : 'Off'}
      </span>
    </button>
  );
  const secondaryActive = secondary.some((value) => value.id === view);

  return (
    <nav className="nav" aria-label="Main navigation" ref={container}>
      <Link
        className="nav__brand"
        route={{ name: 'today' }}
        navigate={navigate}
      >
        Personal Hub
      </Link>
      <ul className="nav__list">
        {primary.map(item)}
        <li className="nav__more-item">
          <button
            ref={moreButton}
            type="button"
            className={`nav__link ${secondaryActive ? 'nav__link--active' : ''}`}
            aria-expanded={more}
            aria-controls={panel}
            onClick={() => setMore((value) => !value)}
          >
            <Icon name="more" />
            <span className="nav__label">More</span>
            {unread > 0 && (
              <span className="nav__count">
                {unread}
                <span className="visually-hidden"> unread</span>
              </span>
            )}
          </button>
        </li>
      </ul>
      <ul className="nav__list nav__secondary">
        {secondary.map(item)}
        <li>{einkToggle}</li>
      </ul>
      <div id={panel} className="nav__more" hidden={!more}>
        <ul className="nav__list">
          {secondary.map(item)}
          <li>{einkToggle}</li>
        </ul>
      </div>
    </nav>
  );
}
