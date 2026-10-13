import { AIBudgetSettings } from './AIBudgetSettings';
import { AIPreflights } from './AIPreflights';
import { AIProviders } from './AIProviders';
import { AIRoutingSettings } from './AIRoutingSettings';
import { AssistantSettings } from './AssistantSettings';
import { Help } from './Help';
import { StatusChip } from './StatusChip';
import './AIView.css';

const sections = [
  ['ai-assistant', 'Assistant'],
  ['ai-permissions', 'Permissions'],
  ['ai-spending', 'Spending limits'],
  ['ai-providers', 'Providers'],
  ['ai-checks', 'Request checks'],
] as const;

/**
 * Settings › AI. Every section stays mounted on one page so drafts and the
 * "settings changed" reload warnings survive while the owner moves between
 * them; the jump links only scroll.
 */
export function AIView() {
  return (
    <section className="ai-view" aria-label="AI settings">
      <div className="panel preference-panel">
        <h2>
          AI <StatusChip>Assistant only</StatusChip>
        </h2>
        <Help label="AI status">
          Only the Assistant on Today sends requests, to OpenRouter, within your
          spending limits. Its changes are applied only when you choose.
          Permissions, providers and request checks below are saved rules for
          later AI features. A provider that is unavailable blocks a request; it
          never falls back to another one. Email always needs your approval
          before it is sent.
        </Help>
        <nav aria-label="AI sections">
          <ul className="ai-view__jump">
            {sections.map(([id, label]) => (
              <li key={id}>
                <a href={`#${id}`}>{label}</a>
              </li>
            ))}
          </ul>
        </nav>
      </div>
      <div className="preferences-grid">
        <div id="ai-assistant">
          <AssistantSettings />
        </div>
        <div id="ai-permissions">
          <AIRoutingSettings />
        </div>
        <div id="ai-spending">
          <AIBudgetSettings />
        </div>
        <div id="ai-providers">
          <AIProviders />
        </div>
        <div id="ai-checks">
          <AIPreflights />
        </div>
      </div>
    </section>
  );
}
