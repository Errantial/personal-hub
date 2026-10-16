import type { QueryExecutor } from '../db/database.js';
import { strongest } from './common.js';

// Assistant mail reading (docs/ai-assistant.md, D56): local search over
// subjects and senders, then up to five bodies. The same rules as mail
// suggestions apply: the strongest of the message and connector labels
// decides, Restricted is never sent, Personal only with the owner's switch,
// and only bodies with a verified origin.

export const maxSearchTerms = 3;
export const maxResults = 20;
export const maxReads = 5;
export const bodyLimit = 6000;

export type MailHit = {
  id: string;
  subject: string;
  from: string | null;
  receivedAt: string;
};
type Row = Record<string, unknown>;

const columns = `m.id,m.subject,m.from_address AS "from",to_char(m.received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "receivedAt",m.text_origin,m.sensitivity,c.sensitivity AS "connectorSensitivity"`;
const source = `email_messages m JOIN email_connectors c ON c.id=m.connector_id AND c.owner_id=m.owner_id`;

const allowed = (row: Row, allowPersonalMail: boolean) => {
  const label = strongest(
    String(row.sensitivity),
    String(row.connectorSensitivity),
  );
  return (
    label !== 'restricted' &&
    (label !== 'personal' || allowPersonalMail) &&
    row.text_origin === 'message-body-v1'
  );
};
const sender = (value: unknown) => {
  const from = value as { name: string | null; address: string } | null;
  return from ? from.name || from.address : null;
};
const hit = (row: Row): MailHit => ({
  id: row.id as string,
  subject: String(row.subject),
  from: sender(row.from),
  receivedAt: row.receivedAt as string,
});

/** A literal, case-insensitive LIKE pattern for one term. */
const pattern = (term: string) => `%${term.replace(/[\\%_]/g, '\\$&')}%`;

/**
 * Newest eligible messages whose subject or sender contains any term.
 * `withheld` counts matches the owner's labels keep out.
 */
export async function searchMail(
  tx: QueryExecutor,
  owner: string,
  terms: string[],
  allowPersonalMail: boolean,
) {
  const patterns = terms
    .map((term) => term.trim().slice(0, 60))
    .filter((term) => term.length >= 2)
    .slice(0, maxSearchTerms)
    .map(pattern);
  if (!patterns.length) return { hits: [] as MailHit[], withheld: 0 };
  const rows = await tx.query(
    `SELECT ${columns} FROM ${source}
     WHERE m.owner_id=$1 AND (m.subject ILIKE ANY($2::text[]) OR m.from_address::text ILIKE ANY($2::text[]))
     ORDER BY m.received_at DESC,m.id DESC LIMIT 100`,
    [owner, patterns],
  );
  const open = rows.filter((row) => allowed(row, allowPersonalMail));
  return {
    hits: open.slice(0, maxResults).map(hit),
    withheld: rows.length - open.length,
  };
}

/**
 * Bodies for chosen search hits, checked again at read time; anything no
 * longer allowed is skipped. Bodies are cut to `bodyLimit` characters.
 */
export async function readMail(
  tx: QueryExecutor,
  owner: string,
  ids: string[],
  allowPersonalMail: boolean,
) {
  if (!ids.length) return [];
  const rows = await tx.query(
    `SELECT ${columns},m.body,m.body_truncated FROM ${source} WHERE m.owner_id=$1 AND m.id=ANY($2::uuid[])`,
    [owner, ids],
  );
  return ids.flatMap((id) => {
    const row = rows.find((item) => item.id === id);
    return row && allowed(row, allowPersonalMail)
      ? [
          {
            ...hit(row),
            body: String(row.body)
              .slice(0, bodyLimit)
              .replace(/[\uD800-\uDBFF]$/, ''),
            truncated:
              row.body_truncated === true ||
              String(row.body).length > bodyLimit,
          },
        ]
      : [];
  });
}

/** The exact header/body fields used by Assistant follow-up envelopes. */
export const projectMailHeader = (item: MailHit, ref: string) => ({
  ref,
  from: item.from,
  subject: item.subject,
  received: item.receivedAt.slice(0, 10),
});
export const projectMailBody = (
  item: MailHit & { body: string },
  ref: string,
) => ({ ...projectMailHeader(item, ref), body: item.body });

export async function reprojectAssistantMail(
  tx: QueryExecutor,
  owner: string,
  sources: import('../ai/live-manifest.js').LiveSource[],
  allowPersonalMail: boolean,
) {
  const messages = await readMail(
    tx,
    owner,
    sources.map((s) => s.id),
    allowPersonalMail,
  );
  return new Map(
    sources.map((source) => {
      const item = messages.find((item) => item.id === source.id);
      return [
        `${source.projection}:${source.id}`,
        item
          ? {
              projection: source.projection as
                'mail-header-v1' | 'mail-body-v1',
              id: item.id,
              ref: source.ref,
              projected:
                source.projection === 'mail-header-v1'
                  ? projectMailHeader(item, source.ref)
                  : projectMailBody(item, source.ref),
              ...(source.projection === 'mail-body-v1'
                ? { truncated: item.truncated }
                : {}),
            }
          : null,
      ];
    }),
  );
}
