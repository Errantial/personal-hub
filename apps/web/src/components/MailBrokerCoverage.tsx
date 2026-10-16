import type { z } from 'zod';
import { mailBrokerReceiptSchema } from '@hub/contracts';
import { formatInstant } from '../lib/format';
import { Help } from './Help';

type Receipt = z.infer<typeof mailBrokerReceiptSchema>;

const status: Record<Receipt['status'], string> = {
  pending: 'Mail search has not finished.',
  partial: 'Mail search stopped early.',
  completed: 'Mail search finished.',
  blocked: 'Mail search was blocked.',
  uncertain: 'The mail search result is uncertain. Nothing was resent.',
};
const stop: Record<Receipt['coverage']['stopReason'], string> = {
  page: 'Older mail was not searched.',
  exhausted: 'All imported mail in this window was searched.',
  'candidate-limit':
    'Stopped at the scan limit, so older mail was not searched.',
  'lineage-limit':
    'Stopped at the retained-dependency limit, so older mail was not searched.',
  'result-limit':
    'Stopped after the message limit, so older mail was not searched.',
  'byte-limit': 'Stopped at the size limit, so older mail was not searched.',
  blocked: 'Stopped by a settings or policy change. Nothing more was sent.',
  uncertain: 'The broker call is uncertain. Nothing was resent.',
};

/**
 * What the broker actually searched and sent (J4). Coverage is imported mail
 * only; no claim is made about the real mailbox.
 */
export function MailBrokerCoverage({
  receipt,
  continuation,
  onContinue,
}: {
  receipt: Receipt;
  /** Owner-bound token for a follow-up ask over older imported mail. */
  continuation: string | null;
  onContinue?: ((token: string) => void) | undefined;
}) {
  const { coverage } = receipt;
  const plural = (count: number, word: string) =>
    `${count} ${word}${count === 1 ? '' : 's'}`;
  return (
    <div className="mail-broker-coverage">
      <p role="status">
        {status[receipt.status]} {plural(coverage.judged, 'message')} judged ·{' '}
        {plural(coverage.selected, 'message')} sent
        {coverage.clipped
          ? ` · ${plural(coverage.clipped, 'message')} cut`
          : ''}
        . {stop[coverage.stopReason]}
      </p>
      <Help label="Mail coverage">
        A broker reads imported mail and sends the Assistant only the messages
        it judges relevant, once. This counts inspected, judged and sent
        messages from {plural(coverage.inspected, 'imported record')}.
        Completeness of the mailbox itself is unverified: the connector may not
        have received everything, and archived or filtered mail may be absent.
      </Help>
      <ul className="meta">
        {coverage.connectors.map((item) => (
          <li key={item.id}>
            {item.lastSeenAt
              ? `Imported up to ${formatInstant(item.lastSeenAt)}`
              : 'Never imported'}{' '}
            · importing since {item.importedSince}
          </li>
        ))}
      </ul>
      {continuation && onContinue && (
        <button
          type="button"
          className="secondary-button"
          onClick={() => {
            onContinue(continuation);
          }}
        >
          Search older mail
        </button>
      )}
    </div>
  );
}
