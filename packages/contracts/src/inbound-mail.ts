import { z } from 'zod';

export const INBOUND_RAW_MAX_BYTES = 25 * 1024 * 1024;

// Internal, versioned mail-work envelope. Existing {jobId} outbound payloads remain valid.
export const inboundWorkPayloadSchema = z
  .object({ kind: z.literal('inbound'), version: z.literal(1), receiptId: z.string().uuid() })
  .strict();
export type InboundWorkPayload = z.infer<typeof inboundWorkPayloadSchema>;
