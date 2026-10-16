import { expect, it } from 'vitest';
import {
  assistantRequestInputSchema,
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

it('academic selection pins both versions and unique work items', () => {
  const base = {
    operationId: '00000000-0000-4000-8000-000000000000',
    text: 'plan my week',
    timeZone: 'UTC',
  };
  // Omitted selection defaults to none.
  expect(assistantRequestInputSchema.parse(base).academic).toEqual([]);
  const id = '11111111-1111-4111-8111-111111111111';
  expect(
    assistantRequestInputSchema.safeParse({
      ...base,
      academic: [{ id, expectedVersion: 2, expectedCourseVersion: 3 }],
    }).success,
  ).toBe(true);
  // The class version is required for academic selection.
  expect(
    assistantRequestInputSchema.safeParse({
      ...base,
      academic: [{ id, expectedVersion: 2 }],
    }).success,
  ).toBe(false);
  // Each work item is selected once.
  expect(
    assistantRequestInputSchema.safeParse({
      ...base,
      academic: [
        { id, expectedVersion: 2, expectedCourseVersion: 3 },
        { id, expectedVersion: 2, expectedCourseVersion: 3 },
      ],
    }).success,
  ).toBe(false);
});

it('memory selection pins both versions and unique memory items', () => {
  const base = {
    operationId: '00000000-0000-4000-8000-000000000000',
    text: 'plan my week',
    timeZone: 'UTC',
  };
  // Omitted selection defaults to none.
  expect(assistantRequestInputSchema.parse(base).memory).toEqual([]);
  const id = '11111111-1111-4111-8111-111111111111';
  expect(
    assistantRequestInputSchema.safeParse({
      ...base,
      memory: [{ id, expectedVersion: 2, expectedSettingsVersion: 3 }],
    }).success,
  ).toBe(true);
  // The settings version is required for memory selection.
  expect(
    assistantRequestInputSchema.safeParse({
      ...base,
      memory: [{ id, expectedVersion: 2 }],
    }).success,
  ).toBe(false);
  // Each memory item is selected once.
  expect(
    assistantRequestInputSchema.safeParse({
      ...base,
      memory: [
        { id, expectedVersion: 2, expectedSettingsVersion: 3 },
        { id, expectedVersion: 2, expectedSettingsVersion: 3 },
      ],
    }).success,
  ).toBe(false);
  // At most 10 memory items allowed.
  expect(
    assistantRequestInputSchema.safeParse({
      ...base,
      memory: Array.from({ length: 11 }, (_, i) => ({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        expectedVersion: 1,
        expectedSettingsVersion: 1,
      })),
    }).success,
  ).toBe(false);
});
