import { z } from 'zod';

// Organization categories never determine sensitivity or provider routing.
export const mailCategorySchema = z.enum([
  'actionable',
  'academic',
  'personal',
  'receipts',
  'newsletters',
  'possible-spam',
]);
export type MailCategory = z.infer<typeof mailCategorySchema>;
export const mailCategoryLabels: Record<MailCategory, string> = {
  actionable: 'Actionable',
  academic: 'Academic',
  personal: 'Personal',
  receipts: 'Receipts',
  newsletters: 'Newsletters',
  'possible-spam': 'Possible spam',
};
export const mailCategoryFieldsSchema = z.object({
  category: mailCategorySchema.nullable().default(null),
  categorySource: z.enum(['owner', 'rule']).nullable().default(null),
  categoryRuleId: z.string().uuid().nullable().default(null),
});
const mutation = {
  operationId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
};
export const mailCategoryWriteSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    ...mutation,
    mode: z.literal('owner'),
    category: mailCategorySchema.nullable(),
  }),
  z.strictObject({ ...mutation, mode: z.literal('rules') }),
]);
export const mailCategoryResultSchema = mailCategoryFieldsSchema.extend({
  id: z.string().uuid(),
  version: z.number().int().positive(),
});
export const mailRuleCaptureSchema = z.strictObject({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  name: z.string().max(100),
  field: z.enum(['sender', 'subject']),
  match: z.string().max(200),
  category: mailCategorySchema,
});
const fields = {
  name: z.string().trim().min(1).max(100),
  field: z.enum(['sender', 'subject']),
  match: z.string().trim().min(1).max(200),
  category: mailCategorySchema,
  enabled: z.boolean(),
};
export const mailRuleSchema = z.object({
  ...fields,
  id: z.string().uuid(),
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  deletedAt: z.string().datetime().nullable(),
});
export type MailRule = z.infer<typeof mailRuleSchema>;
export const mailRulesSchema = z.object({
  revision: z.number().int().positive(),
  rules: z.array(mailRuleSchema),
});
export const mailRuleCreateSchema = z.strictObject({
  ...fields,
  operationId: z.string().uuid(),
  expectedRevision: z.number().int().positive(),
});
export const mailRuleUpdateSchema = mailRuleCreateSchema.extend({
  expectedVersion: z.number().int().positive(),
});
export const mailRuleDeleteSchema = z.strictObject({
  ...mutation,
  expectedRevision: z.number().int().positive(),
});
export const mailRuleResultSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  revision: z.number().int().positive(),
});
const references = z
  .array(
    z.strictObject({
      id: z.string().uuid(),
      expectedVersion: z.number().int().positive(),
    }),
  )
  .min(1)
  .max(100)
  .refine(
    (refs) =>
      new Set(refs.map((ref) => ref.id.toLowerCase())).size === refs.length,
    'Select unique messages.',
  );
export const mailRulesPreviewInputSchema = z.strictObject({
  messages: references,
});
export const mailRulesApplyInputSchema = z.strictObject({
  messages: references,
  expectedRevision: z.number().int().positive(),
  operationId: z.string().uuid(),
});
export const mailRuleDecisionSchema = mailCategoryResultSchema.extend({
  previousCategory: mailCategorySchema.nullable(),
  protected: z.boolean(),
  changed: z.boolean(),
  ruleVersion: z.number().int().positive().nullable(),
});
export const mailRulesPreviewSchema = z.object({
  revision: z.number().int().positive(),
  decisions: z.array(mailRuleDecisionSchema).max(100),
});
export const mailRulesApplyResultSchema = z.object({
  changed: z.number().int().nonnegative(),
  messages: z.array(mailCategoryResultSchema).max(100),
});
