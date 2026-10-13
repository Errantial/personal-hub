import { ImapFlow } from 'imapflow';
import type { ConnectorConfig } from './config.js';

/**
 * Read-only access to the local Proton Bridge. Mailboxes are opened with
 * EXAMINE, so flags (read/unread) never change and nothing is moved.
 */
export async function openBridge(config: ConnectorConfig['bridge']) {
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.security === 'ssl',
    ...(config.security === 'starttls' ? { doSTARTTLS: true } : {}),
    // Bridge uses a self-signed certificate; the host is loopback-only.
    tls: { rejectUnauthorized: false },
    auth: { user: config.user, pass: config.password },
    logger: false,
    disableAutoIdle: true,
  });
  await client.connect();
  return client;
}

/** Folders and labels to read: everything except Spam and Trash. */
export async function readableFolders(client: ImapFlow) {
  const folders = await client.list();
  return folders
    .filter(
      (folder) =>
        !folder.flags.has('\\Noselect') &&
        !['\\Junk', '\\Trash'].includes(folder.specialUse ?? '') &&
        !/^(spam|trash)$/i.test(folder.path),
    )
    .map((folder) => ({
      path: folder.path,
      specialUse: folder.specialUse ?? null,
    }));
}

/** Opens one folder read-only for the duration of `work`. */
export async function withFolder<T>(
  client: ImapFlow,
  path: string,
  work: (state: { uidValidity: string; exists: number }) => Promise<T>,
) {
  const lock = await client.getMailboxLock(path, { readOnly: true });
  try {
    const mailbox = client.mailbox;
    if (!mailbox) throw new Error('Mailbox not open');
    return await work({
      uidValidity: String(mailbox.uidValidity),
      exists: mailbox.exists,
    });
  } finally {
    lock.release();
  }
}
