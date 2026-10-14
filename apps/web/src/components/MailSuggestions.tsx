import { useEffect, useRef, useState } from 'react';
import {
  mailCategoryLabels,
  mailCategoryResultSchema,
  mailClassifyLimit,
  mailClassifyResponseSchema,
} from '@hub/contracts';
import type { MailClassifyResponse, MailSuggestion } from '@hub/contracts';
import { RequestError, liveRequestJson } from '../lib/api';
import { formatCost } from '../lib/assistant';
import { useMutation, useOnline } from '../lib/hooks';
import { Help } from './Help';

type Reference = { id: string; expectedVersion: number };
type Item = MailSuggestion & {
  selected: boolean;
  applyId: string;
  state: 'proposed' | 'applied' | 'failed';
  error?: string | undefined;
};
const blockText = {
  restricted: 'labeled Restricted (never sent)',
  'personal-not-allowed':
    'labeled Personal (allow it in Settings › AI › Assistant)',
  provenance: 'imported by an older connector (re-import needed)',
  changed: 'changed since it was loaded (reload mail)',
} as const;

/**
 * AI category suggestions for the selected mail (up to 20). Nothing is
 * categorized until the owner applies suggestions, which are saved as
 * ordinary owner categories with the version the model saw.
 */
export function MailSuggestions({
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
  const online = useOnline();
  const ask = useMutation();
  const [result, setResult] = useState<MailClassifyResponse | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  // A different selection invalidates suggestions shown for the previous
  // one; version changes (such as our own applied categories) do not.
  const referenceKey = references
    .map((reference) => reference.id)
    .sort()
    .join();
  // Mail clears the selection after an apply; keep showing that result.
  const keepResult = useRef(false);
  useEffect(() => {
    if (keepResult.current) {
      keepResult.current = false;
      return;
    }
    if (busy) return;
    setResult(null);
    setItems([]);
    setNotice('');
  }, [referenceKey]);

  async function suggest() {
    setNotice('');
    const response = await ask.run(
      mailClassifyResponseSchema,
      'POST',
      '/api/v1/email/classify',
      { messages: references },
      'Could not get suggestions. Try again.',
    );
    if (!response) return;
    setResult(response);
    setItems(
      (response.request?.suggestions ?? []).map((suggestion) => ({
        ...suggestion,
        selected: true,
        applyId: crypto.randomUUID(),
        state: 'proposed',
      })),
    );
  }

  async function apply() {
    setBusy(true);
    onApplying(true);
    const next = [...items];
    for (const [index, item] of next.entries()) {
      if (!item.selected || item.state !== 'proposed') continue;
      try {
        await liveRequestJson(
          `/api/v1/email/messages/${item.id}/category`,
          mailCategoryResultSchema,
          {
            method: 'PUT',
            body: {
              mode: 'owner',
              category: item.category,
              expectedVersion: item.expectedVersion,
              operationId: item.applyId,
            },
          },
        );
        next[index] = { ...item, state: 'applied', error: undefined };
      } catch (error) {
        next[index] = {
          ...item,
          state: 'failed',
          error:
            error instanceof RequestError &&
            ['VERSION_CONFLICT', 'NOT_FOUND'].includes(error.code)
              ? 'Changed since the suggestion. Ask again.'
              : error instanceof RequestError
                ? error.message
                : 'Could not reach the server. Try again.',
        };
      }
      setItems([...next]);
    }
    const count = next.filter((item) => item.state === 'applied').length;
    setNotice(
      count ? `Applied ${count} categor${count === 1 ? 'y' : 'ies'}.` : '',
    );
    setBusy(false);
    onApplying(false);
    if (count) {
      keepResult.current = true;
      onApplied();
    }
  }

  const request = result?.request;
  const proposed = items.filter((item) => item.state === 'proposed');
  const selected = proposed.filter((item) => item.selected).length;
  const tooMany = references.length > mailClassifyLimit;
  return (
    <section className="mail-suggestions" aria-labelledby="mail-ai-title">
      <h3 id="mail-ai-title">AI suggestions</h3>
      <Help label="AI suggestions">
        Sends the selected mail’s sender, subject, date and the start of its
        text to OpenRouter for category suggestions, within your AI spending
        limits. Restricted mail is never sent; Personal mail only if you allow
        it. Nothing changes until you apply.
      </Help>
      <button
        type="button"
        className="secondary-button"
        disabled={
          !references.length || tooMany || !online || ask.pending || busy
        }
        onClick={() => void suggest()}
      >
        {ask.pending
          ? 'Asking…'
          : `Suggest categories${references.length ? ` for ${references.length}` : ''}`}
      </button>
      {tooMany && (
        <p className="meta">Select at most {mailClassifyLimit} messages.</p>
      )}
      {ask.error && (
        <p role="alert" className="form-error">
          {ask.error}
        </p>
      )}
      {result && result.blocked.length > 0 && (
        <div className="form-error" role="status">
          <p>Not sent:</p>
          <ul>
            {result.blocked.map((block) => (
              <li key={block.id}>
                {subjects[block.id] || '(No subject)'}:{' '}
                {blockText[block.reason]}
              </li>
            ))}
          </ul>
        </div>
      )}
      {request && (
        <p className="meta">
          {request.model}
          {request.costMicros !== null &&
            ` · ${formatCost(request.costMicros)}`}
          {request.status === 'uncertain' &&
            ` · Outcome unknown: up to ${formatCost(request.heldMicros)} held; nothing is resent`}
          {request.reason &&
            request.status !== 'uncertain' &&
            ' · The answer could not be used'}
          {!request.resultAvailable &&
            !request.reason &&
            ' · Already answered; ask again to see suggestions'}
        </p>
      )}
      {items.length > 0 && (
        <fieldset className="assistant__changes" disabled={busy}>
          <legend>Suggested categories</legend>
          <ul>
            {items.map((item, index) => (
              <li key={item.id}>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={item.selected}
                    disabled={item.state !== 'proposed'}
                    onChange={(event) =>
                      setItems(
                        items.map((other, at) =>
                          at === index
                            ? { ...other, selected: event.target.checked }
                            : other,
                        ),
                      )
                    }
                  />
                  {subjects[item.id] || '(No subject)'} →{' '}
                  {mailCategoryLabels[item.category]}
                </label>
                <span className="assistant__state">
                  {item.state === 'applied'
                    ? 'Applied'
                    : item.state === 'failed'
                      ? 'Not applied'
                      : item.reason}
                </span>
                {item.error && <p className="form-error">{item.error}</p>}
              </li>
            ))}
          </ul>
          {proposed.length > 0 && (
            <button
              type="button"
              className="primary-button"
              disabled={!selected || !online}
              onClick={() => void apply()}
            >
              {busy
                ? 'Applying…'
                : `Apply ${selected} categor${selected === 1 ? 'y' : 'ies'}`}
            </button>
          )}
        </fieldset>
      )}
      <p role="status">{notice}</p>
    </section>
  );
}
