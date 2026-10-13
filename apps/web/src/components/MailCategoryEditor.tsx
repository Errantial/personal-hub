import { useState } from 'react';
import {
  mailCategoryLabels,
  mailCategorySchema,
  mailCategoryResultSchema,
} from '@hub/contracts';
import type { MailMessage } from '@hub/contracts';
import { useMutation } from '../lib/hooks';
import { Help } from './Help';

export function MailCategoryEditor({
  message,
  onChanged,
  loading,
}: {
  message: MailMessage;
  onChanged: () => void;
  loading: boolean;
}) {
  const [category, setCategory] = useState(message.category ?? '');
  const save = useMutation();
  async function change(mode: 'owner' | 'rules') {
    const result = await save.run(
      mailCategoryResultSchema,
      'PUT',
      `/api/v1/email/messages/${message.id}/category`,
      {
        expectedVersion: message.version,
        mode,
        ...(mode === 'owner' ? { category: category || null } : {}),
      },
    );
    if (result) onChanged();
  }
  return (
    <section aria-label="Mail category">
      <Help label="Mail category">
        Categories organize mail in this hub; they do not change privacy labels,
        Proton mail or AI permissions. Saving a choice, including Uncategorized,
        protects it from rules. Use rules clears that override; preview and
        apply rules to categorize it again.
      </Help>
      <label>
        Category
        <select
          value={category}
          disabled={save.pending || loading}
          onChange={(event) => setCategory(event.target.value)}
        >
          <option value="">Uncategorized</option>
          {mailCategorySchema.options.map((value) => (
            <option key={value} value={value}>
              {mailCategoryLabels[value]}
            </option>
          ))}
        </select>
      </label>
      <p className="meta">
        {message.categorySource === 'owner'
          ? 'Owner choice · Protected from rules'
          : message.categorySource === 'rule'
            ? 'From a mail rule'
            : 'No category yet'}
      </p>
      {message.categoryRuleCapture && (
        <p className="meta">
          Rule “{message.categoryRuleCapture.name}” (version{' '}
          {message.categoryRuleCapture.version}):{' '}
          {message.categoryRuleCapture.field === 'sender'
            ? 'Sender equals'
            : 'Subject contains'}{' '}
          “{message.categoryRuleCapture.match}”.
        </p>
      )}
      {save.error && (
        <p role="alert" className="form-error">
          {save.error} Your choice is kept. Reload the latest message before
          trying again.
        </p>
      )}
      <div className="form-actions">
        <button
          type="button"
          className="primary-button"
          disabled={save.pending || loading}
          onClick={() => void change('owner')}
        >
          {save.pending ? 'Saving…' : 'Save category'}
        </button>
        {message.categorySource === 'owner' && (
          <button
            type="button"
            className="secondary-button"
            disabled={save.pending || loading}
            onClick={() => void change('rules')}
          >
            Use rules
          </button>
        )}
        <button
          type="button"
          className="secondary-button"
          disabled={save.pending || loading}
          onClick={onChanged}
        >
          Reload latest message
        </button>
      </div>
    </section>
  );
}
