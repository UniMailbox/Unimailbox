import { z } from 'zod';

/** R-DATA-001: normalized, case-insensitive managed-domain name. */
export const domainNameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(4)
  .max(253)
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/,
    'Invalid domain name',
  );

export type DomainName = z.infer<typeof domainNameSchema>;
