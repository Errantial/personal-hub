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
  if (agent.pauseReason === 'cap-reached')
    return { label: 'Cap reached', tone: 'warning' };
  if (agent.status === 'paused') return { label: 'Paused', tone: 'paused' };
  if (agent.lastRun?.outcome === 'failed')
    return { label: 'Failed', tone: 'warning' };
  if (!agent.nextRunAt) return { label: 'Not scheduled', tone: 'paused' };
  return {
    label: `Next ${when(agent.nextRunAt, agent.timeZone, now)}`,
    tone: 'normal',
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
    if (!agent.lastRun) return;
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
