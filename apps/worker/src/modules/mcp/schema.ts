import { z } from "zod";

/**
 * Tool input schema for the `hello_mcp` placeholder tool. The shape is
 * intentionally small: PR #2 only verifies the Streamable HTTP plumbing,
 * the auth gate, and the audit/observability hooks — business-logic
 * tools land in PR #3+.
 */
export const HelloMcpInputSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe("Optional name to greet; defaults to 'world'."),
});

export type HelloMcpInput = z.infer<typeof HelloMcpInputSchema>;
