import { expect, it } from 'vitest';
import { bodyLimit, toUpload } from '../src/message.js';

const mime = (lines: string[]) => Buffer.from(lines.join('\r\n'));
const received = new Date('2026-10-12T08:00:00Z');

it('keeps headers and plain text, converts HTML-only mail and counts attachments', async () => {
  const upload = await toUpload(
    mime([
      'Message-ID: <ABC@Example.test>',
      'From: "Advisor" <advisor@example.test>',
      'To: owner@example.test, Team: a@example.test, b@example.test;',
      'Subject: Meeting',
      'Date: Sun, 11 Oct 2026 10:00:00 +0000',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="b"',
      '',
      '--b',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>See you <b>Tuesday</b>.</p>',
      '--b',
      'Content-Type: application/pdf; name="agenda.pdf"',
      'Content-Disposition: attachment; filename="agenda.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      'JVBERi0=',
      '--b--',
      '',
    ]),
    5,
    received,
  );
  expect(upload).toMatchObject({
    uid: 5,
    messageKey: '<abc@example.test>',
    from: { name: 'Advisor', address: 'advisor@example.test' },
    to: [
      { name: null, address: 'owner@example.test' },
      { address: 'a@example.test' },
      { address: 'b@example.test' },
    ],
    subject: 'Meeting',
    sentAt: '2026-10-11T10:00:00.000Z',
    receivedAt: '2026-10-12T08:00:00.000Z',
    body: 'See you Tuesday.',
    bodyTruncated: false,
    attachmentCount: 1,
  });
  expect(JSON.stringify(upload)).not.toContain('JVBERi0');
});

it('truncates long bodies and hashes mail without a Message-ID', async () => {
  const upload = await toUpload(
    mime(['Subject: Long', '', 'x'.repeat(bodyLimit + 10)]),
    1,
    received,
  );
  expect(upload.body).toHaveLength(bodyLimit);
  expect(upload.bodyTruncated).toBe(true);
  expect(upload.messageKey).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(upload.from).toBeNull();
});

it('declares message-body origin without importing text attachments or their filenames', async () => {
  const upload = await toUpload(
    mime([
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="c"',
      '',
      '--c',
      'Content-Type: text/plain',
      '',
      'Actual message body',
      '--c',
      'Content-Type: text/plain; name="EXCLUDED_FILENAME.txt"',
      'Content-Disposition: attachment; filename="EXCLUDED_FILENAME.txt"',
      '',
      'EXCLUDED_ATTACHMENT_ONLY',
      '--c--',
      '',
    ]),
    1,
    received,
  );
  expect(upload).toMatchObject({
    textOrigin: 'message-body-v1',
    body: 'Actual message body',
    attachmentCount: 1,
  });
  expect(JSON.stringify(upload)).not.toContain('EXCLUDED_ATTACHMENT_ONLY');
  expect(JSON.stringify(upload)).not.toContain('EXCLUDED_FILENAME');
});
