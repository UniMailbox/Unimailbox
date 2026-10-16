import { resourceUsageResponseSchema, type ResourceUsageReader } from '@unimailbox/contracts';

/** Permission checks live at the transport boundary; no private mail is queried. */
export async function readResourceUsage(reader: ResourceUsageReader, days: 7 | 30, now: Date) {
  return resourceUsageResponseSchema.parse(await reader.read(days, now));
}
