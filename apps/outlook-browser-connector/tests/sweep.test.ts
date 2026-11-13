import { expect, it } from 'vitest';
import { mergeSweeps } from '../src/runtime.js';
import type { SweepResult } from '../src/runtime.js';
import type { MessageRowSnapshot } from '../src/dom.js';

const row = (href: string): MessageRowSnapshot => ({
  href,
  subject: 'Synthetic subject',
  sender: 'Synthetic Advisor',
  senderAddress: null,
  snippet: null,
  receivedAt: null,
  conversationId: null,
  ariaPosition: null,
  ariaSetSize: null,
  rowIndex: null,
});

function sweep(overrides: Partial<SweepResult> = {}): SweepResult {
  return {
    rows: new Map(),
    unresolved: 0,
    loadMore: false,
    next: false,
    collapsed: false,
    totalCount: null,
    setSize: null,
    recycledIndexes: false,
    reachedBottom: true,
    scrollable: false,
    maxOptions: 1,
    ...overrides,
  };
}

it('keeps an unresolved row seen only in the second sweep', () => {
  const first = sweep({
    rows: new Map([
      [
        'https://outlook.office.com/mail/inbox/id/syntheticMessage0001',
        row('/mail/inbox/id/syntheticMessage0001'),
      ],
    ]),
  });
  const second = sweep({
    unresolved: 1,
    rows: new Map([
      [
        'https://outlook.office.com/mail/inbox/id/syntheticMessage0002',
        row('/mail/inbox/id/syntheticMessage0002'),
      ],
    ]),
  });
  const merged = mergeSweeps(first, second);
  expect(merged.unresolved).toBe(1);
  expect(merged.rows.size).toBe(2);
});
