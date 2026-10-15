import { useCallback, useState } from 'react';
import type { Agent } from '@hub/contracts';

// Persistent agents in the Assistant page (D57).

const dayKey = (date: Date, timeZone: string) =>
  date.toLocaleDateString('en-CA', { timeZone });
const clock = (date: Date, timeZone: string) =>
  date.toLocaleTimeString('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  });
const weekday = (date: Date, timeZone: string) =>
  date.toLocaleDateString('en-US', { timeZone, weekday: 'short' });

/** "1:00 PM" today, otherwise "Wed 7:00 AM", in the agent's zone. */
function when(instant: string, timeZone: string, now: Date) {
  const date = new Date(instant);
  return dayKey(date, timeZone) === dayKey(now, timeZone)
    ? clock(date, timeZone)
    : `${weekday(date, timeZone)} ${clock(date, timeZone)}`;
}

/** The short state shown beside an agent: problems first, then the next run. */
export function agentState(
  agent: Agent,
  now = new Date(),
): { label: string; tone: 'normal' | 'paused' | 'warning' } {
  if ((agent.activeRun ?? agent.lastRun)?.leaseExpired)
    return { label: 'Deadline passed', tone: 'warning' };
  const state = agent.runState;
  if (state && state !== 'idle') return runStateLabel(state);
  if (agent.pauseReason === 'cap-reached')
    return { label: 'Cap reached', tone: 'warning' };
  if (agent.status === 'paused') return { label: 'Paused', tone: 'paused' };
  if (
    agent.lastRun &&
    ['queued', 'running', 'blocked', 'failed'].includes(agent.lastRun.status)
  )
    return runStateLabel(agent.lastRun.status);
  if (!agent.nextRunAt) return { label: 'Not scheduled', tone: 'paused' };
  return {
    label: `Next ${when(agent.nextRunAt, agent.timeZone, now)}`,
    tone: 'normal',
  };
}

/** Labels describe server states; a timeout never becomes a Retry action. */
export function runStateLabel(state: string): {
  label: string;
  tone: 'normal' | 'paused' | 'warning';
} {
  const label: Record<string, string> = {
    idle: 'Not scheduled',
    paused: 'Paused',
    'cap-paused': 'Cap reached',
    queued: 'Queued',
    running: 'Running',
    'retry-scheduled': 'Retry scheduled',
    blocked: 'Blocked',
    failed: 'Failed',
    uncertain: 'Uncertain',
    completed: 'Completed',
    cancelled: 'Cancelled',
  };
  return {
    label: label[state] ?? 'Status unavailable',
    tone: ['cap-paused', 'blocked', 'failed', 'uncertain'].includes(state)
      ? 'warning'
      : ['paused', 'cancelled'].includes(state)
        ? 'paused'
        : 'normal',
  };
}

/** "Scheduled run · Tue 7:00 AM" for an agent turn. */
export function runLine(ask: string, createdAt: string, timeZone: string) {
  const date = new Date(createdAt);
  return `${ask === 'Run now' ? 'Run now' : 'Scheduled run'} · ${weekday(date, timeZone)} ${clock(date, timeZone)}`;
}

const seenKey = 'hub:agents-seen';
function readSeen(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(seenKey) ?? '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.fromEntries(
          Object.entries(parsed).filter(
            ([, value]) => typeof value === 'string',
          ),
        )
      : {};
  } catch {
    return {};
  }
}

/** Which agents have a finished run the owner has not opened yet (this device). */
export function useAgentSeen() {
  const [seen, setSeen] = useState(readSeen);
  const unread = useCallback(
    (agent: Agent) =>
      !!agent.lastRun?.finishedAt && seen[agent.id] !== agent.lastRun.id,
    [seen],
  );
  const markSeen = useCallback((agent: Agent) => {
    if (!agent.lastRun?.finishedAt) return;
    const next = { ...readSeen(), [agent.id]: agent.lastRun.id };
    try {
      localStorage.setItem(seenKey, JSON.stringify(next));
    } catch {
      /* Storage can be unavailable; the dot then clears for this visit. */
    }
    setSeen(next);
  }, []);
  return { unread, markSeen };
}
