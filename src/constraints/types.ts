import { z } from 'zod';

export const ConstraintSeveritySchema = z.enum(['warn', 'block']);
export type ConstraintSeverity = z.infer<typeof ConstraintSeveritySchema>;

export const ConstraintSchema = z.object({
  id: z.string(),
  rule: z.string(),
  severity: ConstraintSeveritySchema,
  createdBy: z.string(),
  expiresAt: z.string().datetime(),
});

export type Constraint = z.infer<typeof ConstraintSchema>;

export const ConstraintsResponseSchema = z.object({
  constraints: z.array(ConstraintSchema),
});

export type ConstraintsResponse = z.infer<typeof ConstraintsResponseSchema>;

export interface SeparatedConstraints {
  block: Constraint[];
  warn: Constraint[];
}
