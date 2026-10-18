import { expect, it } from 'vitest';
import { runAgentAcceptance } from '../run-agent-acceptance.mjs';

it('runs the real autonomous worker startup loop across restarts with synthetic provider I/O only', async () => {
  await expect(runAgentAcceptance()).resolves.toEqual({
    version: 1,
    synthetic: true,
    runCount: 3,
    manualRuns: 2,
    scheduledRuns: 1,
    completedRuns: 3,
    needsApprovalRuns: 1,
    conversationTurns: 3,
    inboxNotifications: 1,
    chatDispatches: 3,
    settledMicros: 369,
    heldMicros: 0,
    uncertainMicros: 0,
    workerHealthy: true,
    scheduleAdvanced: true,
    plannerEffects: 0,
    cleanRestartNoDuplicateDispatch: true,
    askFirstNotificationBound: true,
  });
}, 60000);
