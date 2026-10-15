import { z } from 'zod';

export const aiActionModeSchema = z.enum([
  'automatic',
  'approval-required',
  'blocked',
]);
export const aiActionPolicySchema = z.strictObject({
  tasks: aiActionModeSchema,
  calendar: aiActionModeSchema,
  email: z.literal('approval-required'),
});
/** For owners who never saved action settings (D57: tasks ask first). */
export const defaultAIActionPolicy = aiActionPolicySchema.parse({
  tasks: 'approval-required',
  calendar: 'automatic',
  email: 'approval-required',
});
export const aiActionSettingsSchema = z.object({
  version: z.number().int().positive(),
  policy: aiActionPolicySchema,
});
export const aiActionWriteSchema = z.strictObject({
  operationId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  policy: aiActionPolicySchema,
});
// An authority preview describes a proposed action, not executable arguments or
// approved source content. Capability is declared by the server, never the client.
export const aiActionSchema = z.union([
  z.strictObject({
    kind: z.enum(['task.create', 'task.update', 'task.delete', 'task.restore']),
    connection: z.literal('hub'),
  }),
  z.strictObject({
    kind: z.enum([
      'calendar.create',
      'calendar.update',
      'calendar.delete',
      'calendar.restore',
    ]),
    connection: z.enum([
      'hub',
      'canvas',
      'proton-calendar',
      'outlook-calendar',
    ]),
    outboundEmail: z
      .enum(['none', 'invitation', 'attendee-update', 'cancellation'])
      .default('none'),
  }),
  z.strictObject({
    kind: z.literal('email.send'),
    connection: z.enum(['proton-mail', 'outlook-mail']),
  }),
]);
export const aiActionPreviewRequestSchema = z.strictObject({
  expectedPolicyVersion: z.number().int().positive(),
  action: aiActionSchema,
});
export const aiActionPreviewResponseSchema = z.object({
  policyVersion: z.number().int().positive(),
  action: aiActionSchema,
  policyDecision: aiActionModeSchema,
  emailApprovalRequired: z.boolean(),
  writeCapability: z.enum(['local', 'read-only', 'unverified']),
  executionEnabled: z.literal(false),
  blockers: z
    .array(
      z.enum([
        'POLICY_BLOCKED',
        'OWNER_APPROVAL_REQUIRED',
        'EMAIL_APPROVAL_REQUIRED',
        'READ_ONLY_TARGET',
        'WRITE_CAPABILITY_UNVERIFIED',
        'OUTBOUND_EMAIL_UNSUPPORTED',
        'ACTION_EXECUTION_UNAVAILABLE',
      ]),
    )
    .min(1)
    .max(7),
});
export type AIActionPolicy = z.infer<typeof aiActionPolicySchema>;
export type AIActionSettings = z.infer<typeof aiActionSettingsSchema>;
export type AIAction = z.infer<typeof aiActionSchema>;
export type AIActionPreview = z.infer<typeof aiActionPreviewResponseSchema>;
