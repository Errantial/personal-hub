import { expect, it } from 'vitest';
import type { Agent } from '@hub/contracts';
import { agentState, runLine } from '../src/lib/agents';

const zone = 'America/Denver';
// Tue 2026-10-13 10:00 in Denver.
const now = new Date('2026-10-13T16:00:00.000Z');
const agent = (fields: Partial<Agent> = {}): Agent => ({
  id: '00000000-0000-4000-8000-000000000001',
  version: 1,
  template: 'daily-plan',
  title: 'Daily plan',
  goal: 'Plan',
  status: 'active',
  pauseReason: null,
  schedule: { frequency: 'daily', times: ['07:00'] },
  useMail: true,
  monthlyCapMicros: 2000000,
  spentMicros: 0,
  timeZone: zone,
  conversationId: '00000000-0000-4000-8000-000000000002',
  nextRunAt: '2026-10-13T19:00:00.000Z',
  lastRun: null,
  ...fields,
});

it('labels agent states, most urgent first', () => {
  expect(
    agentState(agent({ status: 'paused', pauseReason: 'cap-reached' }), now),
  ).toEqual({
    label: 'Cap reached',
    tone: 'warning',
  });
  expect(agentState(agent({ status: 'paused' }), now)).toEqual({
    label: 'Paused',
    tone: 'paused',
  });
  expect(
    agentState(
      agent({
        lastRun: {
          id: '00000000-0000-4000-8000-000000000003',
          status: 'failed',
          outcome: 'failed',
          errorCode: 'PROVIDER_TIMEOUT',
          finishedAt: '2026-10-13T13:00:00.000Z',
          turnId: null,
        },
      }),
      now,
    ),
  ).toEqual({ label: 'Failed', tone: 'warning' });
  expect(agentState(agent(), now).label).toBe('Next 1:00 PM');
  expect(
    agentState(agent({ nextRunAt: '2026-10-14T13:00:00.000Z' }), now).label,
  ).toBe('Next Wed 7:00 AM');
  expect(agentState(agent({ nextRunAt: null }), now).label).toBe(
    'Not scheduled',
  );
});

it('describes run turns by trigger and time', () => {
  expect(runLine('Scheduled run', '2026-10-13T13:00:00.000Z', zone)).toBe(
    'Scheduled run · Tue 7:00 AM',
  );
  expect(runLine('Run now', '2026-10-13T13:00:00.000Z', zone)).toBe(
    'Run now · Tue 7:00 AM',
  );
});
