import { z } from 'zod';

export const resourceServiceSchema = z.enum(['workers', 'd1', 'kv', 'r2', 'queues']);
export const resourceUsageQuerySchema = z
  .object({
    days: z.enum(['7', '30']).default('7').transform(Number),
  })
  .strict();
export const resourceMetricSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    unit: z.enum(['count', 'bytes', 'milliseconds']),
    aggregation: z.enum(['sum', 'max', 'average']),
    points: z
      .array(
        z
          .object({
            date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            value: z.number().finite().nonnegative().nullable(),
            sampleCount: z.number().int().nonnegative().optional(),
          })
          .strict(),
      )
      .max(30),
  })
  .strict();
export const resourceUsageResponseSchema = z
  .object({
    source: z.literal('cloudflare'),
    generatedAt: z.string().datetime(),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    days: z.union([z.literal(7), z.literal(30)]),
    services: z
      .array(
        z
          .object({
            service: resourceServiceSchema,
            status: z.enum(['ready', 'not_configured', 'forbidden', 'unavailable']),
            metrics: z.array(resourceMetricSchema).max(8),
          })
          .strict(),
      )
      .length(5),
  })
  .strict();

export type ResourceService = z.infer<typeof resourceServiceSchema>;
export type ResourceMetric = z.infer<typeof resourceMetricSchema>;
export type ResourceUsageResponse = z.infer<typeof resourceUsageResponseSchema>;
export interface ResourceUsageReader {
  read(days: 7 | 30, now: Date): Promise<ResourceUsageResponse>;
}

export const mailProcessingResponseSchema = z
  .object({
    source: z.literal('application_metadata'),
    generatedAt: z.string().datetime(),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    days: z.union([z.literal(7), z.literal(30)]),
    groups: z
      .array(
        z
          .object({
            id: z.enum(['mail', 'attachments', 'outbound', 'receipts']),
            status: z.enum(['ready', 'limit_exceeded']),
            metrics: z.array(resourceMetricSchema).max(8),
          })
          .strict(),
      )
      .length(4),
  })
  .strict();
export type MailProcessingResponse = z.infer<typeof mailProcessingResponseSchema>;
