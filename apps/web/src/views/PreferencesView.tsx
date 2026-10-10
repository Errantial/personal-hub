import { Help } from '../components/Help';
import { AccountSettings } from '../components/AccountSettings';
import { AIRoutingSettings } from '../components/AIRoutingSettings';
import { AIPreflights } from '../components/AIPreflights';
import { AIBudgetSettings } from '../components/AIBudgetSettings';

export function PreferencesView({
  eink,
  onEinkChange,
}: {
  eink: boolean;
  onEinkChange: (value: boolean) => void;
}) {
  return (
    <div className="preferences-grid">
      <AccountSettings />
      <section className="panel preference-panel">
        <span className="small-label">APPEARANCE</span>
        <h2>Appearance</h2>
        <Help label="E-ink">
          E-ink mode uses crisp black and white, clear borders, and a stable
          layout.
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
      <AIRoutingSettings />
      <AIBudgetSettings />
      <AIPreflights />
    </div>
  );
}
