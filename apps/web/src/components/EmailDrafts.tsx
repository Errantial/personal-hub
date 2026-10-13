import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  emailApprovalResponseSchema,
  emailDraftPageSchema,
  emailDraftResponseSchema,
  emailSendPreviewSchema,
} from '@hub/contracts';
import type { EmailDraft, EmailMessage } from '@hub/contracts';
import type { z } from 'zod';
import { RequestError, getJson, requestJson } from '../lib/api';
import { formatInstant } from '../lib/format';
import { useMutation } from '../lib/hooks';
import type { Route } from '../lib/router';
import { ChangedElsewhere, LabelSelect } from './ClassForms';
import { useConfirm } from './ConfirmDialog';
import { Help } from './Help';
import { Link } from './Link';
import { StatusChip } from './StatusChip';

type Navigate = (route: Route) => void;
type Page = z.infer<typeof emailDraftPageSchema>;
type Blocker = z.infer<typeof emailSendPreviewSchema>['blockers'][number];

const connectionLabels: Record<EmailMessage['connection'], string> = {
  'proton-mail': 'Proton Mail',
  'outlook-mail': 'Outlook',
};
const purposeLabels: Record<EmailMessage['purpose'], string> = {
  email: 'Email',
  'calendar-invitation': 'Calendar invitation',
  'calendar-attendee-update': 'Calendar attendee update',
  'calendar-cancellation': 'Calendar cancellation',
};
const statusLabels: Record<EmailDraft['status'], string> = {
  pending: 'Not approved',
  approved: 'Approved',
  deleted: 'Deleted',
};
const blockerText: Record<Blocker, string> = {
  EMAIL_APPROVAL_REQUIRED: 'This exact message is not approved.',
  APPROVAL_REVOKED: 'The approval was revoked.',
  APPROVAL_STALE: 'The message changed after approval.',
  DRAFT_DELETED: 'The draft is deleted.',
  SENDER_UNVERIFIED: 'The sender address is not verified.',
  SEND_CAPABILITY_UNVERIFIED: 'No mail connection can send yet.',
  EMAIL_EXECUTION_UNAVAILABLE: 'Sending is not available in this app yet.',
  EMAIL_ATTEMPT_EXISTS: 'This revision was already used for an attempt.',
  EMAIL_DELIVERY_UNCERTAIN: 'An earlier attempt has an unknown outcome.',
};
const labelText = {
  unlabeled: 'Unlabeled',
  personal: 'Personal',
  restricted: 'Restricted',
} as const;
const draftsRoute = (draft?: string): Route => ({
  name: 'inbox',
  section: 'drafts',
  ...(draft ? { draft } : {}),
});

/**
 * Inbox › Email drafts: plain-text drafts and exact-message approval. No
 * mail is sent; sending stays blocked until a verified mail connection
 * exists. Online only.
 */
export function EmailDrafts({
  draft,
  navigate,
}: {
  draft: string | undefined;
  navigate: Navigate;
}) {
  const [deleted, setDeleted] = useState(false);
  const [page, setPage] = useState<Page | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const generation = useRef(0);

  const load = useCallback(
    async (after?: Page['nextAfter']) => {
      const current = ++generation.current;
      setLoading(true);
      setError('');
      const query = new URLSearchParams({
        deleted: String(deleted),
        limit: '25',
      });
      if (after) {
        query.set('after', after.id);
        query.set('expectedCursorVersion', String(after.version));
      }
      try {
        const result = await getJson(
          `/api/v1/email/drafts?${query}`,
          emailDraftPageSchema,
        );
        if (current !== generation.current) return;
        setPage((previous) =>
          after && previous
            ? { ...result, drafts: [...previous.drafts, ...result.drafts] }
            : result,
        );
      } catch (caught) {
        if (current !== generation.current) return;
        setError(
          after &&
            caught instanceof RequestError &&
            ['VERSION_CONFLICT', 'NOT_FOUND'].includes(caught.code)
            ? 'The list changed. Reload to see the latest.'
            : 'Drafts need a connection. Reload to try again.',
        );
      } finally {
        if (current === generation.current) setLoading(false);
      }
    },
    [deleted],
  );
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section aria-labelledby="email-drafts-title" className="email-drafts">
      <h2 id="email-drafts-title">Email drafts</h2>
      <Help label="Email drafts">
        Write plain-text emails and approve the exact message. Nothing is sent:
        no mail connection can send yet. Any change after approval needs a new
        approval.
      </Help>
      <div className="email-drafts__controls">
        <Link
          className="email-drafts__new"
          route={draftsRoute('new')}
          navigate={navigate}
          current={draft === 'new'}
        >
          New draft
        </Link>
        <label>
          Show
          <select
            value={deleted ? 'deleted' : 'current'}
            onChange={(event) => setDeleted(event.target.value === 'deleted')}
          >
            <option value="current">Current drafts</option>
            <option value="deleted">Deleted drafts</option>
          </select>
        </label>
      </div>
      {error && (
        <div role="alert" className="form-error">
          <p>{error}</p>
          <button
            type="button"
            className="secondary-button"
            disabled={loading}
            onClick={() => {
              void load();
            }}
          >
            Reload drafts
          </button>
        </div>
      )}
      {loading && !page && <p role="status">Loading…</p>}
      {page && !page.drafts.length && (
        <p>{deleted ? 'No deleted drafts.' : 'No drafts.'}</p>
      )}
      <ul className="inbox-list">
        {(page?.drafts ?? []).map((item) => (
          <li
            key={item.id}
            aria-current={item.id === draft ? 'true' : undefined}
          >
            <div className="inbox-list__body">
              <Link route={draftsRoute(item.id)} navigate={navigate}>
                {item.subject || '(No subject)'}
              </Link>
              <span className="inbox-list__meta">
                <StatusChip
                  tone={item.status === 'approved' ? 'neutral' : 'attention'}
                >
                  {statusLabels[item.status]}
                </StatusChip>
                <span>
                  {item.recipientCount} recipient
                  {item.recipientCount === 1 ? '' : 's'}
                </span>
                {item.purpose !== 'email' && (
                  <span>{purposeLabels[item.purpose]}</span>
                )}
                <span>Saved {formatInstant(item.updatedAt)}</span>
              </span>
            </div>
          </li>
        ))}
      </ul>
      {page?.nextAfter && (
        <button
          type="button"
          className="secondary-button"
          disabled={loading}
          onClick={() => {
            void load(page.nextAfter);
          }}
        >
          {loading ? 'Loading…' : 'Load more drafts'}
        </button>
      )}
      {draft === 'new' && (
        <DraftForm
          key="new"
          onSaved={(saved) => {
            void load();
            navigate(draftsRoute(saved.id));
          }}
          onCancel={() => navigate(draftsRoute())}
        />
      )}
      {draft && draft !== 'new' && (
        <DraftDetail
          key={draft}
          id={draft}
          onChanged={() => void load()}
          navigate={navigate}
        />
      )}
    </section>
  );
}

/** Loads one draft and shows review, approval and editing. */
function DraftDetail({
  id,
  onChanged,
  navigate,
}: {
  id: string;
  onChanged: () => void;
  navigate: Navigate;
}) {
  const [draft, setDraft] = useState<EmailDraft | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState('');
  const [dialog, confirm] = useConfirm();
  const approve = useMutation();
  const revoke = useMutation();
  const remove = useMutation();
  const heading = useRef<HTMLHeadingElement>(null);

  const reload = useCallback(async () => {
    try {
      const fresh = (
        await getJson(`/api/v1/email/drafts/${id}`, emailDraftResponseSchema)
      ).draft;
      setDraft(fresh);
      setError('');
      return fresh;
    } catch (caught) {
      setError(
        caught instanceof RequestError && caught.code === 'NOT_FOUND'
          ? 'This draft is not available.'
          : 'This draft needs a connection. Try again.',
      );
      return undefined;
    }
  }, [id]);
  useEffect(() => {
    void reload();
  }, [reload]);

  if (error && !draft)
    return (
      <div role="alert" className="form-error">
        <p>{error}</p>
        <Link route={draftsRoute()} navigate={navigate}>
          Back to drafts
        </Link>
      </div>
    );
  if (!draft) return <p role="status">Loading…</p>;

  const changed = async (text: string) => {
    setNotice(text);
    setEditing(false);
    approve.reset();
    revoke.reset();
    remove.reset();
    await reload();
    onChanged();
    heading.current?.focus();
  };

  async function approveExact() {
    if (!draft) return;
    const result = await approve.run(
      emailApprovalResponseSchema,
      'POST',
      `/api/v1/email/drafts/${draft.id}/approve`,
      {
        expectedVersion: draft.version,
        reviewedContentHash: draft.contentHash,
        decision: 'approve-exact-message',
      },
      'Could not approve. Nothing was changed.',
    );
    if (result) await changed('Approved this exact message. Nothing was sent.');
  }

  async function revokeApproval() {
    if (!draft?.approval) return;
    const result = await revoke.run(
      emailApprovalResponseSchema,
      'POST',
      `/api/v1/email/drafts/${draft.id}/approvals/${draft.approval.id}/revoke`,
      { expectedVersion: draft.approval.version },
      'Could not revoke. Try again.',
    );
    if (result) await changed('Approval revoked.');
  }

  async function deleteOrRestore(restore: boolean) {
    if (!draft) return;
    if (
      !restore &&
      !(await confirm({
        title: 'Delete this draft?',
        message:
          'It is hidden and any approval is revoked. Its text, recipients and history stay in private storage and exports; permanent erasure is not available.',
        confirmLabel: 'Delete draft',
      }))
    )
      return;
    const result = await remove.run(
      emailDraftResponseSchema,
      restore ? 'POST' : 'DELETE',
      `/api/v1/email/drafts/${draft.id}${restore ? '/restore' : ''}`,
      { expectedVersion: draft.version },
      restore
        ? 'Could not restore. Try again.'
        : 'Could not delete. Try again.',
    );
    if (result)
      await changed(
        restore ? 'Draft restored. It needs a new approval.' : 'Draft deleted.',
      );
  }

  const failure = approve.error || revoke.error || remove.error;
  const reviewConflict = [approve.code, revoke.code, remove.code].some((code) =>
    [
      'VERSION_CONFLICT',
      'EMAIL_REVIEW_CONFLICT',
      'DRAFT_STATE_CONFLICT',
    ].includes(code),
  );
  const message = draft.message;
  const pending = approve.pending || revoke.pending || remove.pending;
  return (
    <section className="email-draft" aria-labelledby="email-draft-title">
      <h3 id="email-draft-title" ref={heading} tabIndex={-1}>
        {message.subject || '(No subject)'}
      </h3>
      <p role="status">{notice}</p>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {failure && (
        <div role="alert" className="form-error">
          <p>
            {reviewConflict
              ? 'This draft changed since you opened it. Review it again before approving.'
              : failure}
          </p>
          {reviewConflict && (
            <button
              type="button"
              className="secondary-button"
              onClick={() => void changed('')}
            >
              Reload draft
            </button>
          )}
        </div>
      )}
      {editing ? (
        <DraftForm
          draft={draft}
          reload={reload}
          onSaved={() => void changed('Draft saved. It needs a new approval.')}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          <MessageReview draft={draft} />
          <SendStatus draft={draft} />
          <div className="form-actions">
            {draft.status === 'pending' && (
              <button
                type="button"
                className="primary-button"
                disabled={pending}
                onClick={() => {
                  void approveExact();
                }}
              >
                {approve.pending ? 'Approving…' : 'Approve this exact message'}
              </button>
            )}
            {draft.status === 'approved' && (
              <button
                type="button"
                className="secondary-button"
                disabled={pending}
                onClick={() => {
                  void revokeApproval();
                }}
              >
                Revoke approval
              </button>
            )}
            {draft.status !== 'deleted' && (
              <button
                type="button"
                className="secondary-button"
                disabled={pending}
                onClick={() => {
                  setNotice('');
                  setEditing(true);
                }}
              >
                Edit draft
              </button>
            )}
            {draft.status === 'deleted' ? (
              <button
                type="button"
                className="secondary-button"
                disabled={pending}
                onClick={() => {
                  void deleteOrRestore(true);
                }}
              >
                Restore draft
              </button>
            ) : (
              <button
                type="button"
                className="danger-button"
                disabled={pending}
                onClick={() => {
                  void deleteOrRestore(false);
                }}
              >
                Delete draft
              </button>
            )}
          </div>
        </>
      )}
      {dialog}
    </section>
  );
}

/** The stored message exactly as the server normalized it. */
function MessageReview({ draft }: { draft: EmailDraft }) {
  const message = draft.message;
  const list = (addresses: string[]) =>
    addresses.length ? addresses.join(', ') : 'None';
  return (
    <dl className="email-review" aria-label="Message to approve">
      <dt>Status</dt>
      <dd>
        {statusLabels[draft.status]}
        {draft.approval &&
          !draft.approval.revokedAt &&
          ` · approved ${formatInstant(draft.approval.approvedAt)}`}
      </dd>
      <dt>Account</dt>
      <dd>{connectionLabels[message.connection]}</dd>
      <dt>Purpose</dt>
      <dd>{purposeLabels[message.purpose]}</dd>
      <dt>From</dt>
      <dd>{message.sender}</dd>
      <dt>To</dt>
      <dd>{list(message.to)}</dd>
      <dt>Cc</dt>
      <dd>{list(message.cc)}</dd>
      <dt>Bcc</dt>
      <dd>{list(message.bcc)}</dd>
      <dt>Subject</dt>
      <dd>{message.subject || '(No subject)'}</dd>
      <dt>Body</dt>
      <dd>
        <pre className="email-review__body">{message.body || '(Empty)'}</pre>
      </dd>
      <dt>Attachments</dt>
      <dd>None</dd>
      <dt>Content label</dt>
      <dd>{labelText[message.sensitivity]}</dd>
    </dl>
  );
}

/** What would block sending, as reported by the server (always blocked). */
function SendStatus({ draft }: { draft: EmailDraft }) {
  const [blockers, setBlockers] = useState<Blocker[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setBlockers(null);
    setFailed(false);
    requestJson(
      `/api/v1/email/drafts/${draft.id}/send-preview`,
      emailSendPreviewSchema,
      { method: 'POST', body: { expectedVersion: draft.version } },
    ).then(
      (preview) => {
        if (active) setBlockers(preview.blockers);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [draft.id, draft.version, draft.status]);
  return (
    <div className="email-send-status">
      <p>
        <strong>Sending: not available.</strong> Nothing is sent from this app.
      </p>
      {failed && <p className="meta">Send status could not be checked.</p>}
      {blockers && (
        <ul aria-label="Why sending is blocked">
          {blockers.map((blocker) => (
            <li key={blocker}>{blockerText[blocker]}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

type Draft = {
  connection: EmailMessage['connection'];
  purpose: EmailMessage['purpose'];
  sender: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  sensitivity: EmailMessage['sensitivity'];
};
const toDraft = (message?: EmailMessage): Draft => ({
  connection: message?.connection ?? 'proton-mail',
  purpose: message?.purpose ?? 'email',
  sender: message?.sender ?? '',
  to: message?.to.join(', ') ?? '',
  cc: message?.cc.join(', ') ?? '',
  bcc: message?.bcc.join(', ') ?? '',
  subject: message?.subject ?? '',
  body: message?.body ?? '',
  sensitivity: message?.sensitivity ?? 'unlabeled',
});
/** Addresses separated by commas, semicolons or new lines. */
const addressesOf = (text: string) =>
  text
    .split(/[,;\n]/)
    .map((value) => value.trim())
    .filter(Boolean);
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Checks a draft the way the server will, or returns the first problem. */
function draftMessage(
  draft: Draft,
): { message: EmailMessage } | { field: string; error: string } {
  if (!emailPattern.test(draft.sender.trim()))
    return { field: 'sender', error: 'Enter the sender address' };
  const lists = {
    to: addressesOf(draft.to),
    cc: addressesOf(draft.cc),
    bcc: addressesOf(draft.bcc),
  };
  for (const [field, values] of Object.entries(lists)) {
    const bad = values.find((value) => !emailPattern.test(value));
    if (bad) return { field, error: `Not an email address: ${bad}` };
  }
  const all = [...lists.to, ...lists.cc, ...lists.bcc];
  if (!all.length) return { field: 'to', error: 'Add at least one recipient' };
  if (all.length > 50)
    return { field: 'to', error: 'Use at most 50 recipients' };
  if (new Set(all.map((value) => value.toLowerCase())).size !== all.length)
    return { field: 'to', error: 'Use each recipient once' };
  if (/[\r\n]/.test(draft.subject))
    return { field: 'subject', error: 'Use a single-line subject' };
  return {
    message: {
      connection: draft.connection,
      purpose: draft.purpose,
      sender: draft.sender.trim(),
      ...lists,
      subject: draft.subject,
      body: draft.body,
      attachments: [],
      sensitivity: draft.sensitivity,
    },
  };
}

/** Creates a draft, or replaces an existing draft's whole message. */
function DraftForm({
  draft,
  reload,
  onSaved,
  onCancel,
}: {
  draft?: EmailDraft;
  reload?: () => Promise<EmailDraft | undefined>;
  onSaved: (draft: EmailDraft) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState(() => toDraft(draft?.message));
  const [base, setBase] = useState(draft?.version ?? 0);
  const [fieldError, setFieldError] = useState<{
    field: string;
    error: string;
  } | null>(null);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const save = useMutation();
  const update = (changes: Partial<Draft>) => {
    setValues({ ...values, ...changes });
    setFieldError(null);
    setMessage('');
  };
  const describe = (field: string) =>
    fieldError?.field === field ? 'email-draft-error' : undefined;

  async function loadLatest() {
    if (!reload) return;
    setLoading(true);
    const fresh = await reload();
    setLoading(false);
    if (!fresh) return;
    setBase(fresh.version);
    save.reset();
    setMessage('Latest version loaded. Your edits are kept.');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (save.conflict) return;
    const checked = draftMessage(values);
    if ('error' in checked) return setFieldError(checked);
    const result = await save.run(
      emailDraftResponseSchema,
      draft ? 'PUT' : 'POST',
      draft ? `/api/v1/email/drafts/${draft.id}` : '/api/v1/email/drafts',
      draft
        ? { message: checked.message, expectedVersion: base }
        : { message: checked.message },
      'Could not save the draft. Your text is still here.',
    );
    if (result) onSaved(result.draft);
  }

  const address = (field: 'to' | 'cc' | 'bcc', label: string) => (
    <label>
      {label}
      <textarea
        rows={1}
        value={values[field]}
        aria-invalid={fieldError?.field === field}
        aria-describedby={describe(field)}
        onChange={(event) => update({ [field]: event.target.value })}
      />
    </label>
  );
  return (
    <form
      className="editor-form"
      noValidate
      aria-label={draft ? 'Edit draft' : 'New draft'}
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <h3>{draft ? 'Edit draft' : 'New draft'}</h3>
      {draft?.status === 'approved' && (
        <p className="calendar-warning">
          Saving changes removes the current approval.
        </p>
      )}
      {save.conflict && (
        <ChangedElsewhere
          loading={loading}
          onLoad={() => {
            void loadLatest();
          }}
        />
      )}
      <div className="form-row">
        <label>
          Account
          <select
            value={values.connection}
            onChange={(event) =>
              update({
                connection: event.target.value as Draft['connection'],
              })
            }
          >
            {Object.entries(connectionLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Purpose
          <select
            value={values.purpose}
            onChange={(event) =>
              update({ purpose: event.target.value as Draft['purpose'] })
            }
          >
            {Object.entries(purposeLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label>
        From
        <input
          type="email"
          autoComplete="email"
          value={values.sender}
          aria-invalid={fieldError?.field === 'sender'}
          aria-describedby={describe('sender')}
          onChange={(event) => update({ sender: event.target.value })}
        />
      </label>
      {address('to', 'To')}
      {address('cc', 'Cc')}
      {address('bcc', 'Bcc')}
      <Help label="Recipients">
        Separate addresses with commas or new lines. Up to 50 in total, each
        once.
      </Help>
      <label>
        Subject
        <input
          maxLength={200}
          value={values.subject}
          aria-invalid={fieldError?.field === 'subject'}
          aria-describedby={describe('subject')}
          onChange={(event) => update({ subject: event.target.value })}
        />
      </label>
      <label>
        Body
        <textarea
          rows={8}
          maxLength={12000}
          value={values.body}
          onChange={(event) => update({ body: event.target.value })}
        />
      </label>
      <LabelSelect
        label="Draft content label"
        value={values.sensitivity}
        onChange={(sensitivity) => update({ sensitivity })}
      />
      {fieldError && (
        <p id="email-draft-error" className="form-error">
          <span className="visually-hidden">Error: </span>
          {fieldError.error}
        </p>
      )}
      {save.error && !save.conflict && (
        <p role="alert" className="form-error">
          {save.error}
        </p>
      )}
      <p role="status">{message}</p>
      <div className="form-actions">
        <button
          className="primary-button"
          disabled={save.pending || save.conflict}
        >
          {save.pending ? 'Saving…' : 'Save draft'}
        </button>
        <button type="button" className="secondary-button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
