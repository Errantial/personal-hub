import type { ImapFlow } from 'imapflow';
import type { ConnectorConfig } from './config.js';
import { readableFolders, withFolder } from './bridge.js';
import { toUpload } from './message.js';
import type { Upload } from './message.js';

const batchSize = 25;
/** Larger messages are stored with headers only (body marked truncated). */
const maxSourceBytes = 15 * 1024 * 1024;

type State = {
  since: string;
  folders: { path: string; uidValidity: string; lastUid: number }[];
};
type Batch = {
  path: string;
  role: string | null;
  uidValidity: string;
  exists: number;
  inWindow: number;
  lastUid: number;
  messages: Upload[];
};
export type Hub = {
  state: () => Promise<State>;
  upload: (batch: Batch) => Promise<void>;
};

/** Hub client for the connector routes. The token is never printed. */
export function hubClient(config: ConnectorConfig): Hub {
  if (!config.hubUrl || !config.hubToken)
    throw new Error('Invalid connector settings: hubUrl, hubToken');
  const headers = {
    Authorization: `Bearer ${config.hubToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  const url = (path: string) =>
    new URL(`/api/v1/email/connector/${path}`, config.hubUrl).toString();
  const check = async (response: Response) => {
    if (!response.ok) {
      const code = (
        (await response.json().catch(() => null)) as {
          error?: { code?: string };
        } | null
      )?.error?.code;
      throw new Error(
        `Hub refused (${response.status}${code ? ` ${code}` : ''})`,
      );
    }
    return response;
  };
  return {
    state: async () =>
      (await (
        await check(
          await fetch(url('state'), {
            headers,
            signal: AbortSignal.timeout(30000),
          }),
        )
      ).json()) as State,
    upload: async (batch) => {
      await check(
        await fetch(url('batch'), {
          method: 'POST',
          headers,
          body: JSON.stringify(batch),
          signal: AbortSignal.timeout(120000),
        }),
      );
    },
  };
}

/**
 * Uploads new messages from every readable folder, oldest first. The hub
 * advances a folder's position only after storing a batch, so an
 * interrupted run resumes without gaps; repeats de-duplicate on the hub.
 */
export async function sync(client: ImapFlow, hub: Hub) {
  const state = await hub.state();
  const since = new Date(`${state.since}T00:00:00Z`);
  const totals = { folders: 0, messages: 0 };
  for (const folder of await readableFolders(client)) {
    await withFolder(client, folder.path, async (mailbox) => {
      const stored = state.folders.find((row) => row.path === folder.path);
      const start =
        stored && stored.uidValidity === mailbox.uidValidity
          ? stored.lastUid + 1
          : 1;
      const uidNext = client.mailbox ? Number(client.mailbox.uidNext) : 0;
      const inWindow = mailbox.exists
        ? ((await client.search({ since }, { uid: true })) || []).length
        : 0;
      const uids = mailbox.exists
        ? (
            (await client.search(
              { since, uid: `${start}:*` },
              { uid: true },
            )) || []
          )
            // "n:*" always matches the newest message, even below n.
            .filter((uid) => uid >= start)
            .sort((a, b) => a - b)
        : [];
      const base = {
        path: folder.path,
        role: folder.specialUse,
        uidValidity: mailbox.uidValidity,
        exists: mailbox.exists,
        inWindow,
      };
      for (let index = 0; index < uids.length; index += batchSize) {
        const chunk = uids.slice(index, index + batchSize);
        const messages: Upload[] = [];
        for await (const message of client.fetch(
          chunk,
          { uid: true, internalDate: true, size: true, source: true },
          { uid: true },
        )) {
          if (!message.source || !message.internalDate)
            throw new Error('Incomplete IMAP message; retry this sync.');
          const upload = await toUpload(
            message.size && message.size > maxSourceBytes
              ? headersOnly(message.source)
              : message.source,
            message.uid,
            new Date(message.internalDate),
          );
          messages.push(
            message.size && message.size > maxSourceBytes
              ? { ...upload, body: '', bodyTruncated: true }
              : upload,
          );
        }
        if (
          messages.length !== chunk.length ||
          new Set(messages.map((message) => message.uid)).size !==
            chunk.length ||
          messages.some((message) => !chunk.includes(message.uid))
        )
          throw new Error('Incomplete IMAP batch; retry this sync.');
        await hub.upload({ ...base, lastUid: chunk.at(-1)!, messages });
        totals.messages += messages.length;
      }
      // Nothing else below uidNext needs reading next time.
      await hub.upload({
        ...base,
        lastUid: Math.max(start - 1, uidNext - 1, uids.at(-1) ?? 0),
        messages: [],
      });
      totals.folders++;
    });
  }
  return totals;
}

function headersOnly(source: Buffer) {
  const end = source.indexOf('\r\n\r\n');
  return end > 0 ? source.subarray(0, end + 4) : source;
}
