import { z } from "zod";
import { PERMISSION_KEYS } from "../domain";
import { defineEndpoint } from "./common/endpoint";

/**
 * PR #8 — agent token management.
 *
 * REST surface used by the MCP settings UI to issue, list, and revoke
 * the long-lived credentials that external AI agents present to the
 * first-party MCP server. Distinct from the 15-minute JWT access tokens
 * minted by `authEndpoints.login` — these credentials are bound to the
 * issuing user, scoped to a subset of `PERMISSION_KEYS`, and persisted as
 * SHA-256 hashes in the `agent_tokens` table.
 */

const ScopeSchema = z.enum(PERMISSION_KEYS);

const TimestampSchema = z.union([z.string().min(1), z.number().int()]);

const AgentTokenListItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  scopes: z.array(ScopeSchema),
  created_at: TimestampSchema,
  last_used_at: TimestampSchema.nullable(),
  expires_at: TimestampSchema.nullable(),
  revoked_at: TimestampSchema.nullable(),
});

const AgentTokenCreateInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  scopes: z.array(ScopeSchema).min(1).max(PERMISSION_KEYS.length),
  expires_at: TimestampSchema.nullable().optional(),
});

const AgentTokenCreateResponseSchema = AgentTokenListItemSchema.extend({
  /**
   * Plaintext token. Shown ONCE on creation — the server only stores
   * the SHA-256 hash, so a forgotten token cannot be recovered; the
   * caller must rotate. Clients MUST surface this alongside the
   * standard "you will not see this again" warning.
   */
  plaintext_token: z.string().min(1),
  token: z.string().min(1),
});

const UuidSchema = z.string().trim().min(1).max(64);

const agentTokenErrors = [
  "AUTH_REQUIRED",
  "AUTH_TOKEN_INVALID",
  "PERMISSION_DENIED",
  "VALIDATION_FAILED",
  "AGENT_TOKEN_NOT_FOUND",
  "AGENT_TOKEN_ALREADY_REVOKED",
] as const;

export const agentTokenEndpoints = {
  list: defineEndpoint({
    method: "GET",
    path: "/agent_tokens",
    responses: { 200: z.array(AgentTokenListItemSchema) },
    errors: agentTokenErrors,
    mediaType: "json",
  }),
  create: defineEndpoint({
    method: "POST",
    path: "/agent_tokens",
    request: { body: AgentTokenCreateInputSchema },
    responses: { 201: AgentTokenCreateResponseSchema },
    errors: agentTokenErrors,
    mediaType: "json",
  }),
  revoke: defineEndpoint({
    method: "DELETE",
    path: "/agent_tokens/:tokenId",
    request: { params: z.object({ tokenId: UuidSchema }) },
    responses: { 204: null },
    errors: agentTokenErrors,
    mediaType: "empty",
  }),
} as const;

export type AgentTokenListItem = z.infer<typeof AgentTokenListItemSchema>;
export type AgentTokenCreateInput = z.infer<typeof AgentTokenCreateInputSchema>;
export type AgentTokenCreateResponse = z.infer<
  typeof AgentTokenCreateResponseSchema
>;
