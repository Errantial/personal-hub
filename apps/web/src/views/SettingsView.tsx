import { Help } from '../components/Help';
import { AccountSettings } from '../components/AccountSettings';
import { AIRoutingSettings } from '../components/AIRoutingSettings';
import { AIPreflights } from '../components/AIPreflights';
import { AIBudgetSettings } from '../components/AIBudgetSettings';
import { ConnectionsView } from './ConnectionsView';
import type { WorkspaceState } from './ConnectionsView';
import { Link } from '../components/Link';
import type { User } from '@hub/contracts';
import { sectionLabels, settingsSections } from '../lib/router';
import type { Route, SettingsSection } from '../lib/router';

export function SettingsView({
  section,
  navigate,
  workspace,
  eink,
  onEinkChange,
  user,
  signOut,
}: {
  section: SettingsSection;
  navigate: (route: Route) => void;
  workspace: WorkspaceState;
  eink: boolean;
  onEinkChange: (value: boolean) => void;
  user: User;
  signOut: () => Promise<void>;
}) {
  return (
    <div className="settings">
      <nav className="settings__nav" aria-label="Settings sections">
        {settingsSections.map((item) => (
          <Link
            key={item}
            route={{ name: 'settings', section: item }}
            navigate={navigate}
            current={item === section}
          >
            {sectionLabels[item]}
          </Link>
        ))}
      </nav>
      <div className="settings__content">
        {section === 'account' && (
          <div className="preferences-grid">
            <AccountSettings />
            <section className="panel preference-panel">
              <h2>Sign out</h2>
              <p>Signed in as {user.email}</p>
              <Help label="Sign out">
                Queued task changes must be synchronized or discarded first.
                Signing out clears private data stored on this device.
              </Help>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  void signOut();
                }}
              >
                Sign out
              </button>
            </section>
          </div>
        )}
        {section === 'appearance' && (
          <section className="panel preference-panel">
            <h2>E-ink mode</h2>
            <Help label="E-ink">
              Black and white, no animation, larger controls and a stable
              layout. Use it on e-ink displays such as the Mudita Kompakt.
            </Help>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={eink}
                onChange={(event) => onEinkChange(event.target.checked)}
              />
              Use e-ink mode
            </label>
          </section>
        )}
        {section === 'connections' && <ConnectionsView workspace={workspace} />}
        {section === 'ai' && (
          <div className="preferences-grid">
            <AIRoutingSettings />
            <AIBudgetSettings />
            <AIPreflights />
          </div>
        )}
      </div>
    </div>
  );
}
