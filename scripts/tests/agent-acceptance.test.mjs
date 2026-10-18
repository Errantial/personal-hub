import { expect, it } from 'vitest';
import { runAgentAcceptance } from '../run-agent-acceptance.mjs';

it('runs the real autonomous worker startup loop across restarts with synthetic provider I/O only', async () => {
  await expect(runAgentAcceptance()).resolves.toEqual({
    version: 1,
    synthetic: true,
    runCount: 2,
    manualRuns: 1,
    scheduledRuns: 1,
    completedRuns: 2,
    conversationTurns: 2,
    inboxNotifications: 0,
    chatDispatches: 2,
    settledMicros: 246,
    heldMicros: 0,
    uncertainMicros: 0,
    workerHealthy: true,
    scheduleAdvanced: true,
    plannerEffects: 0,
    cleanRestartNoDuplicateDispatch: true,
  });
}, 60000);
