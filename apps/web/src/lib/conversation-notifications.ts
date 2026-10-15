import { useEffect, useRef, useState } from 'react';
import {
  notificationHistorySchema,
  notificationsReadResponseSchema,
} from '@hub/contracts';
import { liveRequestJson } from './api';

/** Read only notifications belonging to the conversation actually opened. */
export function useConversationNotifications(
  id: string | undefined,
  finishedAt: string | null | undefined,
  onChanged?: () => void,
) {
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const receipts = useRef(new Map<string, string>());
  const changed = useRef(onChanged);
  changed.current = onChanged;
  useEffect(() => {
    setError('');
    if (!id) return;
    const abort = new AbortController();
    async function read() {
      let before: string | null = null;
      // Bound work on very old histories; do not mark other threads read.
      for (let page = 0; page < 50; page++) {
        const query = new URLSearchParams({ unreadOnly: 'true', limit: '200' });
        if (before) query.set('before', before);
        const result = await liveRequestJson(
          `/api/v1/notifications/history?${query}`,
          notificationHistorySchema,
          { signal: abort.signal },
        );
        const notificationIds = result.notifications
          .filter((item) => item.conversationId === id && !item.readAt)
          .map((item) => item.id)
          .sort();
        if (notificationIds.length) {
          const key = notificationIds.join(',');
          let operationId = receipts.current.get(key);
          if (!operationId) {
            operationId = crypto.randomUUID();
            receipts.current.set(key, operationId);
          }
          await liveRequestJson(
            '/api/v1/notifications/read',
            notificationsReadResponseSchema,
            {
              method: 'POST',
              body: { operationId, notificationIds },
              signal: abort.signal,
            },
          );
          receipts.current.delete(key);
          changed.current?.();
        }
        before = result.nextBefore;
        if (!before) {
          changed.current?.();
          return;
        }
      }
      if (!abort.signal.aborted)
        setError(
          'Some older notifications may remain unread. Open Inbox to review them.',
        );
    }
    void read().catch(() => {
      if (!abort.signal.aborted)
        setError(
          'Could not mark this conversation’s notifications read. Retry when online.',
        );
    });
    return () => abort.abort();
  }, [id, finishedAt, attempt]);
  return { error, retry: () => setAttempt((value) => value + 1) };
}
