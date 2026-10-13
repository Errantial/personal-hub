import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  mailCategoryLabels,
  mailCategorySchema,
  mailRuleResultSchema,
  mailRulesSchema,
  mailRulesPreviewSchema,
  mailRulesApplyResultSchema,
} from '@hub/contracts';
import type { MailRule } from '@hub/contracts';
import { getJson, requestJson } from '../lib/api';
import { useMutation, useResource } from '../lib/hooks';
import { Help } from './Help';
import { useConfirm } from './ConfirmDialog';

type Reference = { id: string; expectedVersion: number };
export function MailRules({
  references,
  subjects,
  onApplied,
  onApplying,
}: {
  references: Reference[];
  subjects: Record<string, string>;
  onApplied: () => void;
  onApplying: (busy: boolean) => void;
}) {
  const list = useResource(
    (signal) => getJson('/api/v1/email/rules', mailRulesSchema, signal),
    { failure: 'Mail rules unavailable. Reload rules.' },
  );
  const [editing, setEditing] = useState<MailRule | 'new' | null>(null);
  const remove = useMutation(),
    apply = useMutation();
  const [dialog, confirm] = useConfirm();
  const [preview, setPreview] = useState<ReturnType<
    typeof mailRulesPreviewSchema.parse
  > | null>(null);
  const [pending, setPending] = useState(false),
    [error, setError] = useState('');
  const generation = useRef(0),
    controller = useRef<AbortController | null>(null);
  const referenceKey = JSON.stringify(references);
  useEffect(() => {
    generation.current++;
    controller.current?.abort();
    setPreview(null);
    setPending(false);
    setError('');
    return () => {
      generation.current++;
      controller.current?.abort();
    };
  }, [referenceKey, list.data?.revision]);
  const changed = () => {
    generation.current++;
    controller.current?.abort();
    setPreview(null);
    setPending(false);
    void list.reload();
  };
  async function previewRules() {
    const current = ++generation.current;
    controller.current?.abort();
    const control = new AbortController();
    controller.current = control;
    setPending(true);
    setError('');
    setPreview(null);
    try {
      const result = await requestJson(
        '/api/v1/email/rules/preview',
        mailRulesPreviewSchema,
        {
          method: 'POST',
          body: { messages: references },
          signal: control.signal,
        },
      );
      if (current !== generation.current) return;
      if (result.revision !== list.data?.revision) {
        setError('Rules changed. Reload rules and preview again.');
        return;
      }
      setPreview(result);
    } catch {
      if (current === generation.current)
        setError(
          'Mail or rules changed, or the connection failed. Reload mail and rules, then preview again.',
        );
    } finally {
      if (current === generation.current) setPending(false);
    }
  }
  async function applyRules() {
    if (!preview) return;
    onApplying(true);
    const result = await apply.run(
      mailRulesApplyResultSchema,
      'POST',
      '/api/v1/email/rules/apply',
      {
        expectedRevision: preview.revision,
        messages: preview.decisions.map((item) => ({
          id: item.id,
          expectedVersion: item.version,
        })),
      },
      'Could not apply rules. Preview again before retrying.',
    );
    onApplying(false);
    if (result) {
      setPreview(null);
      onApplied();
    }
  }
  function edit(rule: MailRule | 'new') {
    generation.current++;
    controller.current?.abort();
    setPreview(null);
    setPending(false);
    setEditing(rule);
  }
  async function deleteRule(rule: MailRule) {
    if (
      !list.data ||
      !(await confirm({
        title: `Delete “${rule.name}”?`,
        message:
          'Existing categories stay until you apply rules again. Owner choices stay protected.',
        confirmLabel: 'Delete rule',
      }))
    )
      return;
    const result = await remove.run(
      mailRuleResultSchema,
      'DELETE',
      `/api/v1/email/rules/${rule.id}`,
      { expectedVersion: rule.version, expectedRevision: list.data.revision },
    );
    if (result) changed();
  }
  return (
    <details className="panel mail-rules">
      <summary>Mail rules</summary>
      <Help label="Mail rules">
        Rules run locally when you preview and apply them to selected messages.
        Sender matches an exact address; Subject matches a literal phrase.
        Matching ignores case. The oldest matching enabled rule wins. Owner
        category choices, including Uncategorized, are protected. Categories do
        not change privacy labels or send mail to AI.
      </Help>
      {list.error && (
        <p role="alert" className="form-error">
          {list.error}
        </p>
      )}
      <button
        type="button"
        className="secondary-button"
        disabled={list.loading || apply.pending}
        onClick={changed}
      >
        Reload rules
      </button>
      {list.data && list.data.rules.length === 0 && <p>No rules yet.</p>}
      <ul className="inbox-list">
        {(list.data?.rules ?? []).map((rule) => (
          <li key={rule.id}>
            <div className="inbox-list__body">
              <strong>{rule.name}</strong>
              <span>
                {rule.field === 'sender' ? 'Sender equals' : 'Subject contains'}{' '}
                “{rule.match}” → {mailCategoryLabels[rule.category]}
                {!rule.enabled && ' · Disabled'}
              </span>
            </div>
            <div className="form-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={apply.pending}
                onClick={() => edit(rule)}
              >
                Edit <span className="visually-hidden">{rule.name}</span>
              </button>
              <button
                type="button"
                className="danger-button"
                disabled={remove.pending || apply.pending}
                onClick={() => void deleteRule(rule)}
              >
                Delete <span className="visually-hidden">{rule.name}</span>
              </button>
            </div>
          </li>
        ))}
      </ul>
      {remove.error && (
        <p role="alert" className="form-error">
          {remove.error}
        </p>
      )}
      {editing && list.data ? (
        <RuleEditor
          key={editing === 'new' ? 'new' : editing.id}
          rule={editing === 'new' ? null : editing}
          revision={list.data.revision}
          onSaved={() => {
            setEditing(null);
            changed();
          }}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <button
          type="button"
          className="secondary-button"
          disabled={!list.data || apply.pending}
          onClick={() => edit('new')}
        >
          Add rule
        </button>
      )}
      <div className="form-actions">
        <button
          type="button"
          className="primary-button"
          disabled={
            !references.length ||
            !list.data ||
            pending ||
            apply.pending ||
            editing !== null
          }
          onClick={() => void previewRules()}
        >
          {pending ? 'Previewing…' : `Preview rules (${references.length})`}
        </button>
      </div>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {preview && (
        <section aria-label="Rule preview">
          <ul className="inbox-list">
            {preview.decisions.map((item) => (
              <li key={item.id}>
                {subjects[item.id] || '(No subject)'}:{' '}
                {item.previousCategory
                  ? mailCategoryLabels[item.previousCategory]
                  : 'Uncategorized'}{' '}
                →{' '}
                {item.category
                  ? mailCategoryLabels[item.category]
                  : 'Uncategorized'}
                {item.protected
                  ? ' · Owner choice preserved'
                  : !item.changed
                    ? ' · Unchanged'
                    : ''}
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="primary-button"
            disabled={
              apply.pending || !preview.decisions.some((item) => item.changed)
            }
            onClick={() => void applyRules()}
          >
            {apply.pending ? 'Applying…' : 'Apply preview'}
          </button>
        </section>
      )}
      {apply.error && (
        <p role="alert" className="form-error">
          {apply.error} Reload mail and rules, then preview again.
        </p>
      )}
      {dialog}
    </details>
  );
}
function RuleEditor({
  rule,
  revision,
  onSaved,
  onCancel,
}: {
  rule: MailRule | null;
  revision: number;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(rule?.name ?? ''),
    [match, setMatch] = useState(rule?.match ?? '');
  const [field, setField] = useState<MailRule['field']>(
    rule?.field ?? 'sender',
  );
  const [category, setCategory] = useState<MailRule['category']>(
    rule?.category ?? 'newsletters',
  );
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const save = useMutation();
  // Pin the original list revision so an intervening reload cannot authorize a stale editor.
  const [expectedRevision] = useState(revision);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const result = await save.run(
      mailRuleResultSchema,
      rule ? 'PUT' : 'POST',
      `/api/v1/email/rules${rule ? `/${rule.id}` : ''}`,
      {
        name,
        match,
        field,
        category,
        enabled,
        expectedRevision,
        ...(rule ? { expectedVersion: rule.version } : {}),
      },
    );
    if (result) onSaved();
  }
  return (
    <form
      className="editor-form"
      aria-label={rule ? 'Edit mail rule' : 'Add mail rule'}
      onSubmit={(event) => void submit(event)}
    >
      <label>
        Name
        <input
          required
          maxLength={100}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label>
        Field
        <select
          value={field}
          onChange={(event) =>
            setField(event.target.value as MailRule['field'])
          }
        >
          <option value="sender">Sender</option>
          <option value="subject">Subject</option>
        </select>
      </label>
      <label>
        Match
        <input
          required
          maxLength={200}
          value={match}
          onChange={(event) => setMatch(event.target.value)}
        />
      </label>
      <label>
        Category
        <select
          value={category}
          onChange={(event) =>
            setCategory(event.target.value as MailRule['category'])
          }
        >
          {mailCategorySchema.options.map((value) => (
            <option key={value} value={value}>
              {mailCategoryLabels[value]}
            </option>
          ))}
        </select>
      </label>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        Enabled
      </label>
      {save.error && (
        <p role="alert" className="form-error">
          {save.error} Your draft is kept; cancel and reopen after reloading
          rules to use the latest version.
        </p>
      )}
      <div className="form-actions">
        <button className="primary-button" disabled={save.pending}>
          {save.pending ? 'Saving…' : 'Save rule'}
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={save.pending}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
