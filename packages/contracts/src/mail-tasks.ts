import { z } from 'zod';
import { createTaskSchema } from './core.js';

export const createMailTaskSchema = createTaskSchema
  .pick({
    title: true,
    notes: true,
    dueDate: true,
    priority: true,
    operationId: true,
    clientId: true,
  })
  .extend({
    expectedVersion: z.number().int().positive(),
    quote: z
      .string()
      .min(1)
      .max(2000)
      .refine((value) => value.trim().length > 0),
    deadlineConfirmed: z.boolean().default(false),
  })
  .refine((input) => input.dueDate === null || input.deadlineConfirmed, {
    message: 'Confirm the deadline or leave it empty.',
    path: ['deadlineConfirmed'],
  });
export const mailTaskResultSchema = z.object({
  taskId: z.string().uuid(),
  taskVersion: z.number().int().positive(),
  messageId: z.string().uuid(),
});
