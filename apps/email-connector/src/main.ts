import { readConnectorConfig } from './config.js';
import { openBridge, readableFolders, withFolder } from './bridge.js';
import { hubClient, sync } from './sync.js';
import type { Hub } from './sync.js';

const days = 30;

/**
 * `check`: proves what Bridge exposes, read-only, printing folder names and
 * counts only — never addresses, subjects or bodies.
 */
async function check() {
  const config = await readConnectorConfig();
  const client = await openBridge(config.bridge);
  try {
    const since = new Date(Date.now() - days * 86400000);
    const folders = await readableFolders(client);
    const distinct = new Set<string>();
    let missingIds = 0;
    const rows = [];
    for (const folder of folders) {
      const row = await withFolder(client, folder.path, async (state) => {
        const uids = state.exists
          ? (await client.search({ since }, { uid: true })) || []
          : [];
        if (uids.length)
          for await (const message of client.fetch(
            uids,
            { uid: true, headers: ['message-id'] },
            { uid: true },
          )) {
            const id = /message-id:\s*(<[^>\r\n]+>)/i.exec(
              message.headers?.toString('utf8') ?? '',
            )?.[1];
            if (id) distinct.add(id.toLowerCase());
            else missingIds++;
          }
        return {
          folder: folder.path,
          role: folder.specialUse ?? '',
          total: state.exists,
          [`last ${days} days`]: uids.length,
        };
      });
      rows.push(row);
    }
    console.table(rows);
    console.log(
      `Distinct messages in the last ${days} days across these folders: ${distinct.size}` +
        (missingIds ? ` (+${missingIds} without a Message-ID)` : ''),
    );
    console.log('Read-only check: nothing was changed or uploaded.');
  } finally {
    await client.logout().catch(() => undefined);
  }
}

/**
 * `sync`: uploads new mail to the hub. `sync --dry-run` reads and parses the
 * same messages locally and prints counts only; nothing is uploaded.
 */
async function runSync() {
  const config = await readConnectorConfig();
  const dryRun = process.argv.includes('--dry-run');
  const counts = { parsed: 0, keyed: 0, truncated: 0, withAttachments: 0 };
  const seen = new Set<string>();
  const hub: Hub = dryRun
    ? {
        state: () =>
          Promise.resolve({
            since: new Date(Date.now() - days * 86400000)
              .toISOString()
              .slice(0, 10),
            folders: [],
          }),
        upload: (batch) => {
          for (const message of batch.messages) {
            counts.parsed++;
            seen.add(message.messageKey);
            if (!message.messageKey.startsWith('sha256:')) counts.keyed++;
            if (message.bodyTruncated) counts.truncated++;
            if (message.attachmentCount) counts.withAttachments++;
          }
          return Promise.resolve();
        },
      }
    : hubClient(config);
  const client = await openBridge(config.bridge);
  try {
    const totals = await sync(client, hub);
    console.log(
      dryRun
        ? `Dry run: parsed ${counts.parsed} folder entries (${seen.size} distinct messages, ${counts.keyed} with a Message-ID, ${counts.truncated} truncated, ${counts.withAttachments} with attachments) in ${totals.folders} folders. Nothing was uploaded.`
        : `Synced ${totals.messages} new folder entries from ${totals.folders} folders.`,
    );
  } finally {
    await client.logout().catch(() => undefined);
  }
}

const command = process.argv[2];
const commands: Record<string, () => Promise<void>> = { check, sync: runSync };
const run = commands[command ?? ''];
if (!run) {
  console.error('Usage: npm run check|sync --workspace @hub/email-connector');
  process.exit(2);
}
run().catch((error: unknown) => {
  // Error messages from IMAP can echo server text; print only our own.
  console.error(
    error instanceof Error &&
      /^(No connector settings|Invalid connector|Hub refused)/.test(
        error.message,
      )
      ? error.message
      : `Failed: ${error instanceof Error ? error.name : 'unknown error'}${
          (error as { authenticationFailed?: boolean })?.authenticationFailed
            ? ' (Bridge rejected the username or password)'
            : ''
        }`,
  );
  process.exit(1);
});
