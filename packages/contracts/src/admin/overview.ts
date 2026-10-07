import { z } from 'zod';
import { uuidSchema } from '../ids';

export const adminOverviewQuerySchema = z
  .object({
    domainId: uuidSchema.optional(),
  })
  .strict();

export const adminOverviewStatsSchema = z
  .object({
    totalMessages: z.number().int().nonnegative(),
    unreadMessages: z.number().int().nonnegative(),
    receivedMessages: z.number().int().nonnegative(),
    sentMessages: z.number().int().nonnegative(),
    draftMessages: z.number().int().nonnegative(),
    mailboxCount: z.number().int().nonnegative(),
    domainCount: z.number().int().nonnegative(),
  })
  .strict();

export const adminOverviewResponseSchema = z
  .object({
    scope: z
      .object({
        domainId: uuidSchema.nullable(),
        domainName: z.string().min(1).nullable(),
      })
      .strict(),
    stats: adminOverviewStatsSchema,
  })
  .strict();

export type AdminOverviewQuery = z.infer<typeof adminOverviewQuerySchema>;
export type AdminOverviewStats = z.infer<typeof adminOverviewStatsSchema>;
export type AdminOverviewResponse = z.infer<typeof adminOverviewResponseSchema>;
