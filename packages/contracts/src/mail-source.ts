import { z } from 'zod';

export const mailTaskSourceSchema = z.object({
  messageId: z.string().uuid(),
  messageVersion: z.number().int().positive(),
  connectorId: z.string().uuid(),
  connectorVersion: z.number().int().positive(),
  quote: z.string().min(1).max(2000),
  labels: z
    .array(z.enum(['unlabeled', 'personal', 'restricted']))
    .min(1)
    .max(3),
  confirmedDueDate: z.string().nullable(),
  provenance: z.literal('owner-reviewed-mail-body'),
});
