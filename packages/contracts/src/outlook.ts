import { z } from 'zod';

export const outlookBackendSchema = z.enum([
  'unknown',
  'exchange-online',
  'other',
]);
export const outlookTenantSchema = z.enum([
  'unknown',
  'school-managed',
  'other',
]);
export const outlookMailboxScopeSchema = z.enum([
  'unknown',
  'primary-only',
  'shared-required',
]);
export const outlookAppRegistrationSchema = z.enum([
  'unknown',
  'owner-can-register',
  'admin-must-register',
  'registration-blocked',
]);
export const outlookConsentSchema = z.enum([
  'unknown',
  'user-can-consent',
  'admin-consent-required',
  'consent-blocked',
]);
export const outlookAccessStatusSchema = z.enum([
  'unknown',
  'ready-for-adapter',
  'admin-action-required',
  'scope-review-required',
  'blocked',
]);

export const outlookAccessGateSchema = z.object({
  backend: outlookBackendSchema,
  tenant: outlookTenantSchema,
  mailboxScope: outlookMailboxScopeSchema,
  appRegistration: outlookAppRegistrationSchema,
  consent: outlookConsentSchema,
  status: outlookAccessStatusSchema,
  version: z.number().int().positive(),
  checkedAt: z.string().datetime().nullable(),
});

export const outlookAccessGateWriteSchema = z.strictObject({
  operationId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  backend: outlookBackendSchema,
  tenant: outlookTenantSchema,
  mailboxScope: outlookMailboxScopeSchema,
  appRegistration: outlookAppRegistrationSchema,
  consent: outlookConsentSchema,
});

export type OutlookAccessGate = z.infer<typeof outlookAccessGateSchema>;
