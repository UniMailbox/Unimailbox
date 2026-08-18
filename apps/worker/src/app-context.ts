import {
  BREVO_PROVIDER_KEY,
  RESEND_PROVIDER_KEY,
  type ProviderKey,
  type ProviderPlugin,
} from "@unimailbox/contracts";
import { createBrevoProviderPlugin } from "./integrations/brevo";
import { createResendProviderPlugin } from "./integrations/resend";
import { ProviderRegistry } from "./integrations/providers";
import type { HttpAppContext } from "./http/router";
import { TokenService } from "./modules/identity";
import { IdentityApplicationService } from "./modules/identity/application";
import { AgentTokenApplicationService } from "./modules/agent-tokens";
import { InstallationService } from "./modules/installation";
import { D1InstallationRepository } from "./modules/installation/infrastructure/d1-installation.repository";
import { HealthService } from "./modules/maintenance";
import { MailboxApplicationService } from "./modules/mailboxes";
import { CursorCodec } from "./modules/messages/cursor";
import { MessageApplicationService } from "./modules/messages";
import { DraftApplicationService } from "./modules/messages/drafts";
import { AttachmentApplicationService } from "./modules/attachments";
import { UploadTokenCodec } from "./modules/attachments/upload-token";
import { WebhookApplicationService } from "./modules/provider-sync/webhook";
import { AdminApplicationService } from "./modules/administration";
import { CloudflareSettingsService } from "./modules/administration/cloudflare-settings";
import { InfrastructureSettingsService } from "./modules/administration/infrastructure-settings";
import { resolveRuntimeConfig, type Env } from "./platform/config";
import { CredentialCipher } from "./platform/crypto";
import { StructuredLogger } from "./platform/logger";
import {
  createAttachmentStore,
  detectStorageBackend,
  type AttachmentStore,
  type StorageBackend,
} from "./platform/attachment-store";

export interface AppContext extends HttpAppContext {
  env: Env;
  providers: ProviderRegistry;
  credentials: CredentialCipher;
  attachmentStore: AttachmentStore;
  storageBackend: StorageBackend;
  /**
   * HMAC-signed cursor codec used by both the REST mail list endpoints
   * and the MCP read tools. Exposed so MCP resources can mint cursors
   * that the REST surface will accept verbatim.
   */
  cursors: CursorCodec;
}

export async function createAppContext(
  env: Env,
  _executionContext?: ExecutionContext,
): Promise<AppContext> {
  const runtime = await resolveRuntimeConfig(env);
  const installation = new InstallationService(
    new D1InstallationRepository(env.DB),
  );
  const attachmentStore = createAttachmentStore(env);
  const storageBackend = detectStorageBackend(env).backend;
  const health = new HealthService(env, storageBackend);
  const tokens = new TokenService(runtime.AUTH_SIGNING_KEY);
  const identity = new IdentityApplicationService(env, tokens);
  const mailboxes = new MailboxApplicationService(env);
  const partialContext = {
    env,
    providers: new ProviderRegistry(
      new Map<ProviderKey, ProviderPlugin>([
        [BREVO_PROVIDER_KEY, createBrevoProviderPlugin()],
        [RESEND_PROVIDER_KEY, createResendProviderPlugin()],
      ]),
    ),
    credentials: new CredentialCipher(runtime.CREDENTIAL_ENCRYPTION_KEY),
    logger: new StructuredLogger(),
    attachmentStore,
    storageBackend,
  };
  const cursors = new CursorCodec(runtime.AUTH_SIGNING_KEY);
  const messages = new MessageApplicationService(
    partialContext,
    mailboxes,
    cursors,
  );
  const attachments = new AttachmentApplicationService(
    env,
    new UploadTokenCodec(runtime.AUTH_SIGNING_KEY),
    attachmentStore,
  );
  const drafts = new DraftApplicationService(partialContext, mailboxes);
  const webhooks = new WebhookApplicationService(partialContext);
  const admin = new AdminApplicationService(partialContext, cursors);
  const agentTokens = new AgentTokenApplicationService(env);
  return {
    ...partialContext,
    cursors,
    installation,
    health,
    settings: new CloudflareSettingsService(
      env.KV,
      env.DB,
      partialContext.credentials,
      partialContext.providers,
      {
        clientId: env.CLOUDFLARE_OAUTH_CLIENT_ID,
        clientSecret: env.CLOUDFLARE_OAUTH_CLIENT_SECRET,
        scopes: env.CLOUDFLARE_OAUTH_SCOPES,
      },
    ),
    infrastructure: new InfrastructureSettingsService(env, health),
    auth: {
      verifyAccessToken: (token) => identity.verifyAccessToken(token),
    },
    identity,
    mailboxes,
    messages,
    attachments,
    drafts,
    webhooks,
    admin,
    agentTokens,
  };
}
