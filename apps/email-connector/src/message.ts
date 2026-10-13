import { createHash } from 'node:crypto';
import { convert } from 'html-to-text';
import { simpleParser } from 'mailparser';
import type { AddressObject } from 'mailparser';

/** Matches the hub's body limit (emailBodyLimit in @hub/contracts). */
export const bodyLimit = 32000;

type Address = { name: string | null; address: string };
export type Upload = {
  uid: number;
  textOrigin: 'message-body-v1';
  messageKey: string;
  from: Address | null;
  to: Address[];
  cc: Address[];
  subject: string;
  sentAt: string | null;
  receivedAt: string;
  body: string;
  bodyTruncated: boolean;
  attachmentCount: number;
};

const addresses = (value: AddressObject | AddressObject[] | undefined) =>
  (Array.isArray(value) ? value : value ? [value] : [])
    .flatMap((group) => group.value)
    // Group syntax nests members; flatten one level.
    .flatMap((entry) => (entry.group ? entry.group : [entry]))
    .filter((entry) => entry.address)
    .slice(0, 500)
    .map((entry) => ({
      name: entry.name ? entry.name.slice(0, 300) : null,
      address: entry.address!.slice(0, 320),
    }));

/**
 * One message as the hub stores it: headers and plain text only. HTML-only
 * mail is converted to text (links and images dropped); attachments are
 * counted, never included.
 */
export async function toUpload(
  source: Buffer,
  uid: number,
  internalDate: Date,
): Promise<Upload> {
  const parsed = await simpleParser(source, {
    skipImageLinks: true,
    skipTextToHtml: true,
    skipTextLinks: true,
  });
  // Prefer the sender's plain-text part; otherwise convert the HTML.
  const plain = parsed.text?.trim()
    ? parsed.text
    : typeof parsed.html === 'string'
      ? convert(parsed.html, {
          wordwrap: false,
          selectors: [
            { selector: 'img', format: 'skip' },
            { selector: 'a', options: { ignoreHref: true } },
          ],
        })
      : '';
  const text = plain.replace(/\r\n/g, '\n').trim();
  const messageId = parsed.messageId?.trim().toLowerCase();
  return {
    uid,
    textOrigin: 'message-body-v1',
    messageKey:
      messageId && messageId.length >= 3 && messageId.length <= 1000
        ? messageId
        : `sha256:${createHash('sha256').update(source).digest('hex')}`,
    from: addresses(parsed.from)[0] ?? null,
    to: addresses(parsed.to),
    cc: addresses(parsed.cc),
    subject: (parsed.subject ?? '').slice(0, 2000),
    sentAt:
      parsed.date && !Number.isNaN(parsed.date.getTime())
        ? parsed.date.toISOString()
        : null,
    receivedAt: internalDate.toISOString(),
    body: text.slice(0, bodyLimit),
    bodyTruncated: text.length > bodyLimit,
    attachmentCount: parsed.attachments.length,
  };
}
