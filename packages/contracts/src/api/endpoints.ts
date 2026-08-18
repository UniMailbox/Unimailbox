import type { EndpointDefinition } from "./common/endpoint";
import { attachmentEndpoints } from "./attachments";
import { administrationEndpoints } from "./administration";
import { agentTokenEndpoints } from "./agent-tokens";
import { authEndpoints } from "./auth";
import { draftEndpoints } from "./drafts";
import { mailboxEndpoints } from "./mailboxes";
import { messageEndpoints } from "./messages";

/** Endpoint groups are accumulated here as feature contracts are migrated. */
export const endpoints = {
  auth: authEndpoints,
  mailboxes: mailboxEndpoints,
  messages: messageEndpoints,
  drafts: draftEndpoints,
  attachments: attachmentEndpoints,
  administration: administrationEndpoints,
  agentTokens: agentTokenEndpoints,
} as const satisfies Record<string, Record<string, EndpointDefinition>>;
