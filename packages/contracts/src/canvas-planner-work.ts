import { z } from 'zod';
import { taskSchema } from './core.js';
import { calendarRecordSchema } from './features.js';
export const canvasPlannerWorkQuerySchema = z.strictObject({
  kind: z.enum(['calendar', 'assignment-api']),
  itemId: z.string().uuid(),
});
export const canvasPlannerWorkSchema = z.object({
  tasks: z.array(taskSchema),
  studies: z.array(calendarRecordSchema),
});
