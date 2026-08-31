import { z } from 'zod';

/** ADR-005: externally visible identifiers are UUID v4 strings. */
export const uuidSchema = z.string().uuid();

export type Uuid = z.infer<typeof uuidSchema>;
