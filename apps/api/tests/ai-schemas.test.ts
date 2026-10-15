import { expect, it } from 'vitest';
import {
  liveDestinationApproveSchema,
  liveDestinationStatusSchema,
} from '@hub/contracts';
import { buildAssistantRequest } from '../src/features/assistant.js';
import { buildClassifyRequest } from '../src/features/mail-classify.js';
import { buildTaskSuggestRequest } from '../src/features/mail-task-suggest.js';

// Anthropic structured outputs (served by Vertex) answer 400 to type arrays
// combined with enum, and to array bounds. Keep every wire schema inside the
// subset: objects with additionalProperties false, anyOf for nullable fields.
const model = 'anthropic/claude-haiku-5.5';
const mail = {
  id: 'a',
  version: 1,
  subject: 's',
  from: null,
  receivedAt: '2026-10-13T00:00:00Z',
  sentAt: null,
  body: 'b',
};
const schemas = {
  planner: buildAssistantRequest(
    model,
    { tasks: [], events: [], withheld: 0 },
    'x',
    'UTC',
  ),
  classify: buildClassifyRequest(model, [mail]),
  tasks: buildTaskSuggestRequest(model, mail, 'UTC'),
};

function walk(node: unknown, visit: (node: Record<string, unknown>) => void) {
  if (Array.isArray(node)) return node.forEach((item) => walk(item, visit));
  if (node && typeof node === 'object') {
    visit(node as Record<string, unknown>);
    Object.values(node).forEach((value) => walk(value, visit));
  }
}

for (const [name, request] of Object.entries(schemas))
  it(`${name} schema stays inside the structured-output subset`, () => {
    walk(request.response_format.json_schema.schema, (node) => {
      expect(Array.isArray(node.type)).toBe(false);
      expect(node).not.toHaveProperty('maxItems');
      expect(node).not.toHaveProperty('minItems');
      if (node.type === 'object') expect(node.additionalProperties).toBe(false);
      if (node.enum) expect(node.type).toBe('string');
    });
  });

it('requires a reason exactly when the live destination is blocked', () => {
  const base = {
    approved: null,
    model: 'anthropic/claude-haiku-5.5',
    hosts: ['anthropic', 'google-vertex'],
    personalMail: false,
    version: 0,
  };
  expect(
    liveDestinationStatusSchema.safeParse({
      ...base,
      status: 'blocked',
      reason: 'approval-required',
    }).success,
  ).toBe(true);
  expect(
    liveDestinationStatusSchema.safeParse({
      ...base,
      status: 'blocked',
      reason: null,
    }).success,
  ).toBe(false);
  expect(
    liveDestinationStatusSchema.safeParse({
      ...base,
      status: 'ready',
      reason: 'approval-stale',
    }).success,
  ).toBe(false);
  expect(
    liveDestinationApproveSchema.safeParse({
      model: base.model,
      upstream: 'google-vertex/global',
      expectedVersion: 0,
    }).success,
  ).toBe(false);
});
