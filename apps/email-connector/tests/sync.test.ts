import { expect, it, vi } from 'vitest';
import type { ImapFlow } from 'imapflow';
import { sync } from '../src/sync.js';
import type { Hub } from '../src/sync.js';

vi.mock('../src/bridge.js', () => ({
  readableFolders: async () => [{ path: 'INBOX', specialUse: '\\Inbox' }],
  withFolder: async (
    _client: unknown,
    _path: string,
    work: (state: unknown) => unknown,
  ) => work({ uidValidity: '1', exists: 2 }),
}));

const source = Buffer.from(
  'Message-ID: <synthetic@example.test>\r\nSubject: Synthetic\r\n\r\nBody',
);
const row = (uid: number) => ({
  uid,
  source,
  internalDate: new Date('2026-10-13T12:00:00Z'),
  size: source.length,
});
const client = (rows: object[]) =>
  ({
    mailbox: { uidNext: 3 },
    search: async () => [1, 2],
    fetch: async function* () {
      for (const item of rows) yield item;
    },
  }) as unknown as ImapFlow;
const hub = () => ({
  state: async () => ({ since: '2026-10-01', folders: [] }),
  upload: vi.fn<Hub['upload']>(async () => undefined),
});

it('does not advance the cursor when IMAP omits a requested message', async () => {
  const target = hub();
  await expect(sync(client([row(1)]), target)).rejects.toThrow(
    'Incomplete IMAP batch',
  );
  expect(target.upload).not.toHaveBeenCalled();
});

it('does not advance the cursor when an IMAP message has no source', async () => {
  const target = hub();
  await expect(
    sync(client([row(1), { ...row(2), source: undefined }]), target),
  ).rejects.toThrow('Incomplete IMAP message');
  expect(target.upload).not.toHaveBeenCalled();
});

it('stores a complete batch before recording the folder high-water mark', async () => {
  const target = hub();
  expect(await sync(client([row(1), row(2)]), target)).toEqual({
    folders: 1,
    messages: 2,
  });
  expect(
    target.upload.mock.calls.map(([batch]) => ({
      lastUid: batch.lastUid,
      count: batch.messages.length,
    })),
  ).toEqual([
    { lastUid: 2, count: 2 },
    { lastUid: 2, count: 0 },
  ]);
});
