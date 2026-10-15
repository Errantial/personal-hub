import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueryExecutor } from '../src/db/database.js';
import {
  historySourcesEligible,
  readBoundHistory,
} from '../src/ai/live-history.js';
import {
  maxHistorySources,
  maxHistoryTurns,
  historyRefs,
  turnDigest,
} from '../src/ai/live-manifest.js';
import type { LiveManifest } from '../src/ai/live-manifest.js';
import { startHarness } from './helpers/openrouter.js';
import type { Harness } from './helpers/openrouter.js';

const owner = randomUUID();
const conversation = randomUUID();
const rules = { allowed: ['unlabeled'] as const, useMail: false };
const allowed = () => ({ allowed: [...rules.allowed], useMail: rules.useMail });
const bound = (ask = 'Synthetic ask', reply = 'Synthetic reply') => {
  const id = randomUUID();
  return {
    id,
    ask,
    reply,
    inference_history: 'bound',
    inference_digest: turnDigest(owner, id, ask, reply),
    inference_sources: [],
    answeredCount: 1,
  };
};
const reader = (rows: object[]) => {
  const query = vi.fn(async () => rows);
  return { tx: { query } as unknown as QueryExecutor, query };
};

describe('bound history', () => {
  it('checks exact retained ask and reply before resending and bounds the database read', async () => {
    const row = bound();
    const { tx, query } = reader([row]);
    expect(
      (await readBoundHistory(tx, owner, conversation, allowed())).history,
    ).toEqual([{ ask: row.ask, reply: row.reply }]);
    expect(query.mock.calls[0]).toEqual(
      expect.arrayContaining([
        expect.stringContaining('LIMIT $3'),
        [owner, conversation, maxHistoryTurns],
      ]),
    );
    row.reply = 'Changed after binding';
    expect(
      await readBoundHistory(tx, owner, conversation, allowed()),
    ).toMatchObject({ history: [], withheld: 1 });
  });

  it.each([
    'not-json',
    JSON.stringify([{ secret: 'Synthetic private invalid value' }]),
    null,
  ])(
    'withholds malformed stored source references without surfacing their values',
    async (value) => {
      const { tx } = reader([{ ...bound(), inference_sources: value }]);
      await expect(
        readBoundHistory(tx, owner, conversation, allowed()),
      ).resolves.toMatchObject({ history: [], sources: [], withheld: 1 });
    },
  );

  it('rejects an oversized source array before resolving any sources and preserves total withheld count', async () => {
    const ref = { kind: 'task', id: randomUUID(), labels: ['unlabeled'] };
    const { tx, query } = reader([
      {
        ...bound(),
        inference_sources: Array.from(
          { length: maxHistorySources + 1 },
          () => ref,
        ),
        answeredCount: 25,
      },
    ]);
    expect(
      await readBoundHistory(tx, owner, conversation, allowed()),
    ).toMatchObject({ history: [], withheld: 25 });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('requires connector identity even when the replacement has the same version and labels', async () => {
    const id = randomUUID();
    const connector = randomUUID();
    const { tx } = reader([
      {
        id,
        sensitivity: 'unlabeled',
        text_origin: 'message-body-v1',
        connectorSensitivity: 'unlabeled',
        connectorId: connector,
        connectorVersion: 1,
      },
    ]);
    const refs = [
      {
        kind: 'mail-message' as const,
        id,
        labels: ['unlabeled' as const],
        connector: { id: connector, version: 1 },
      },
    ];
    expect(
      await historySourcesEligible(tx, owner, refs, {
        allowed: ['unlabeled'],
        useMail: true,
      }),
    ).toBe(true);
    refs[0]!.connector.id = randomUUID();
    expect(
      await historySourcesEligible(tx, owner, refs, {
        allowed: ['unlabeled'],
        useMail: true,
      }),
    ).toBe(false);
  });

  it('stops before a second turn would exceed the transitive source union bound', async () => {
    const connector = { id: randomUUID(), version: 1 };
    const refs = Array.from({ length: 1001 }, () => ({
      kind: 'mail-message' as const,
      id: randomUUID(),
      labels: ['unlabeled' as const],
      connector,
    }));
    const recent = {
      ...bound(),
      inference_sources: refs.slice(0, 600),
      answeredCount: 2,
    };
    const older = {
      ...bound(),
      inference_sources: refs.slice(600),
      answeredCount: 2,
    };
    const query = vi
      .fn()
      .mockResolvedValueOnce([recent, older])
      .mockResolvedValue(
        refs
          .slice(0, 600)
          .map((ref) => ({
            id: ref.id,
            sensitivity: 'unlabeled',
            text_origin: 'message-body-v1',
            connectorId: connector.id,
            connectorVersion: 1,
            connectorSensitivity: 'unlabeled',
          })),
      );
    const result = await readBoundHistory(
      { query } as unknown as QueryExecutor,
      owner,
      conversation,
      { allowed: ['unlabeled'], useMail: true },
    );
    expect(result.sources).toHaveLength(600);
    expect(result.turns.map((turn) => turn.id)).toEqual([recent.id]);
    expect(result.withheld).toBe(1);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('keeps every inherited label when direct and history sources overlap', () => {
    const id = randomUUID();
    const refs = historyRefs({
      history: { sources: [{ kind: 'task', id, labels: ['unlabeled'] }] },
      sources: [{ kind: 'task', id, labels: ['restricted'] }],
    } as unknown as LiveManifest);
    expect(refs).toEqual([
      { kind: 'task', id, labels: ['unlabeled', 'restricted'] },
    ]);
  });
});

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.app.close();
  harness = undefined;
});

describe('history planner provenance', () => {
  it('allows ordinary content edits but withholds inherited academic labels and deleted sources', async () => {
    harness = await startHarness();
    const event = (
      await harness.call('POST', '/api/v1/calendar', {
        title: 'Synthetic event',
        startsAt: '2026-10-20T14:00:00Z',
        endsAt: '2026-10-20T15:00:00Z',
        timeZone: 'UTC',
        operationId: randomUUID(),
      })
    ).json().event;
    const refs = [
      { kind: 'event' as const, id: event.id, labels: ['unlabeled' as const] },
    ];
    const eligible = () =>
      historySourcesEligible(
        harness!.database,
        harness!.owner,
        refs,
        allowed(),
      );
    expect(await eligible()).toBe(true);
    await harness.database.query(
      "UPDATE events SET title='Ordinary changed title',version=version+1 WHERE id=$1",
      [event.id],
    );
    expect(await eligible()).toBe(true);
    await harness.database.query(
      "UPDATE events SET academic_labels=ARRAY['restricted']::text[] WHERE id=$1",
      [event.id],
    );
    expect(await eligible()).toBe(false);
    await harness.database.query(
      'UPDATE events SET academic_labels=ARRAY[]::text[],deleted_at=CURRENT_TIMESTAMP WHERE id=$1',
      [event.id],
    );
    expect(await eligible()).toBe(false);
  });
});
