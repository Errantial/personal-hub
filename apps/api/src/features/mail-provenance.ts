import type { QueryExecutor } from '../db/database.js';

export const mailTaskSourceColumns = `(SELECT jsonb_build_object('messageId',s.message_id,'messageVersion',s.message_version,
  'connectorId',s.connector_id,'connectorVersion',s.connector_version,'quote',s.quote,'labels',s.labels,
  'confirmedDueDate',to_char(s.confirmed_due_date,'YYYY-MM-DD'),'provenance','owner-reviewed-mail-body')
  FROM mail_task_sources s WHERE s.task_id=tasks.id AND s.owner_id=tasks.owner_id) AS "mailSource"`;
export async function mailTaskLabels(
  tx: QueryExecutor,
  owner: string,
  id: string,
) {
  const [source] = await tx.query<{ labels: string[] }>(
    'SELECT labels FROM mail_task_sources WHERE owner_id=$1 AND task_id=$2',
    [owner, id],
  );
  return source?.labels ?? [];
}
