/**
 * @unimailbox/contracts
 *
 * Shared types and zod schemas. The only types that cross module boundaries.
 *
 * CAP-001 lays rails — this file holds a single sample schema so the build
 * pipeline has something to type-check. Real contracts land with CAP-004+.
 */
import { z } from 'zod';

// R-DATA-001 — email addresses are compared and stored case-insensitively.
export const emailAddressSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email()
  .max(254);

/**
 * Sample contract — a UUIDv4 string. The shape every other ID contract will
 * follow once CAP-004 lands the schema.
 *
 * Per ADR-005: all externally visible IDs are UUID v4 strings.
 */
export const uuidSchema = z.string().uuid();

export type Uuid = z.infer<typeof uuidSchema>;
export type EmailAddress = z.infer<typeof emailAddressSchema>;