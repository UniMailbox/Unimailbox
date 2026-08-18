import {
  mutationOptions,
  queryOptions,
  type QueryClient,
} from "@tanstack/react-query";
import {
  administrationEndpoints,
  agentTokenEndpoints,
  authEndpoints,
  mailboxEndpoints,
  type EndpointRequest,
} from "@unimailbox/contracts";
import { apiClient } from "../../lib/api/index";

const adminKeys = {
  domains: ["admin", "domains"] as const,
  providers: ["admin", "provider-connections"] as const,
};

export const settingsKeys = {
  all: ["settings"] as const,
  cloudflare: () => [...settingsKeys.all, "cloudflare"] as const,
  checkpoints: () => [...settingsKeys.cloudflare(), "checkpoints"] as const,
  infrastructure: () => [...settingsKeys.all, "infrastructure"] as const,
  agentTokens: () => [...settingsKeys.all, "agentTokens"] as const,
};

function idempotencyHeaders() {
  return { "idempotency-key": crypto.randomUUID() };
}

async function invalidateCheckpoints(client: QueryClient): Promise<void> {
  await client.invalidateQueries({ queryKey: settingsKeys.checkpoints() });
}

export function cloudflareStatusQueryOptions() {
  return queryOptions({
    queryKey: settingsKeys.checkpoints(),
    queryFn: () =>
      apiClient.request(administrationEndpoints.cloudflareStatus, {}),
  });
}

export function infrastructureQueryOptions() {
  return queryOptions({
    queryKey: settingsKeys.infrastructure(),
    queryFn: () =>
      apiClient.request(administrationEndpoints.infrastructure, {}),
  });
}

export function cloudflareOauthStartMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: () =>
      apiClient.request(administrationEndpoints.cloudflareOauthStart, {
        headers: idempotencyHeaders(),
      }),
    onSuccess: async () => invalidateCheckpoints(queryClient),
  });
}

export function cloudflareOauthRevokeMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: () =>
      apiClient.request(administrationEndpoints.cloudflareOauthRevoke, {
        headers: idempotencyHeaders(),
      }),
    onSuccess: async () => invalidateCheckpoints(queryClient),
  });
}

export function cloudflareVerifyMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (
      body: EndpointRequest<
        typeof administrationEndpoints.cloudflareVerify
      >["body"],
    ) =>
      apiClient.request(administrationEndpoints.cloudflareVerify, {
        headers: idempotencyHeaders(),
        body,
      }),
    onSuccess: async () => invalidateCheckpoints(queryClient),
  });
}

export function cloudflareDomainMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (
      body: EndpointRequest<
        typeof administrationEndpoints.cloudflareDomainCreate
      >["body"],
    ) =>
      apiClient.request(administrationEndpoints.cloudflareDomainCreate, {
        headers: idempotencyHeaders(),
        body,
      }),
    onSuccess: async () => {
      await invalidateCheckpoints(queryClient);
      await queryClient.invalidateQueries({ queryKey: adminKeys.domains });
    },
  });
}

export function cloudflareInboundMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (token?: string) =>
      apiClient.request(administrationEndpoints.cloudflareInboundSmokeTest, {
        headers: idempotencyHeaders(),
        body: token ? { token } : {},
      }),
    onSuccess: async () => invalidateCheckpoints(queryClient),
  });
}

export function cloudflareProviderMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (
      body: Omit<
        EndpointRequest<
          typeof administrationEndpoints.cloudflareBrevoConnect
        >["body"],
        "providerKey"
      >,
    ) =>
      apiClient.request(administrationEndpoints.cloudflareBrevoConnect, {
        headers: idempotencyHeaders(),
        body: { ...body, providerKey: "brevo" },
      }),
    onSuccess: async () => {
      await invalidateCheckpoints(queryClient);
      await queryClient.invalidateQueries({ queryKey: adminKeys.providers });
      await queryClient.invalidateQueries({ queryKey: adminKeys.domains });
    },
  });
}

export function cloudflareOutboundMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (
      body: EndpointRequest<
        typeof administrationEndpoints.cloudflareOutboundSmokeTest
      >["body"],
    ) =>
      apiClient.request(administrationEndpoints.cloudflareOutboundSmokeTest, {
        headers: idempotencyHeaders(),
        body,
      }),
    onSuccess: async () => invalidateCheckpoints(queryClient),
  });
}

export function r2VerifyMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: () =>
      apiClient.request(administrationEndpoints.r2Verify, {
        headers: idempotencyHeaders(),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: settingsKeys.infrastructure(),
      });
      await invalidateCheckpoints(queryClient);
    },
  });
}

export function identityEmailMutationOptions() {
  return mutationOptions({
    mutationFn: (body: EndpointRequest<typeof authEndpoints.email>["body"]) =>
      apiClient.request(authEndpoints.email, { body }),
  });
}

export function identityPasswordMutationOptions() {
  return mutationOptions({
    mutationFn: (
      body: EndpointRequest<typeof authEndpoints.passwordReset>["body"],
    ) => apiClient.request(authEndpoints.passwordReset, { body }),
  });
}

export function mailboxCreateSettingsMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (
      body: EndpointRequest<typeof mailboxEndpoints.create>["body"],
    ) => apiClient.request(mailboxEndpoints.create, { body }),
    onSuccess: async () =>
      queryClient.invalidateQueries({ queryKey: ["mail", "mailboxes"] }),
  });
}

export function mailboxMembersQueryOptions(mailboxId: string) {
  return queryOptions({
    queryKey: ["mail", "mailboxes", mailboxId.trim(), "members"],
    queryFn: () =>
      apiClient.request(mailboxEndpoints.listMembers, {
        params: { mailboxId },
      }),
  });
}

export function mailboxMemberSettingsMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: {
      action: "add" | "update" | "remove";
      mailboxId: string;
      userId: string;
      role?: "viewer" | "sender" | "admin";
    }) =>
      input.action === "add"
        ? apiClient.request(mailboxEndpoints.addMember, {
            params: { mailboxId: input.mailboxId },
            body: { userId: input.userId, role: input.role! },
          })
        : input.action === "update"
          ? apiClient.request(mailboxEndpoints.updateMember, {
              params: { mailboxId: input.mailboxId, userId: input.userId },
              body: { role: input.role! },
            })
          : apiClient.request(mailboxEndpoints.removeMember, {
              params: { mailboxId: input.mailboxId, userId: input.userId },
            }),
    onSuccess: async (_result, input) => {
      await queryClient.invalidateQueries({
        queryKey: ["mail", "mailboxes", input.mailboxId.trim(), "members"],
      });
      await queryClient.invalidateQueries({ queryKey: ["mail", "mailboxes"] });
    },
  });
}

/**
 * PR #8 — agent token management.
 *
 * The create mutation returns a response object that contains a
 * one-time `plaintext_token`; the caller must surface it in the UI and
 * never persist it. We do NOT cache the response in the standard list
 * query — the plaintext leaks if we do — so the caller is responsible
 * for showing it before invalidating the list cache.
 */
export function agentTokenListQueryOptions() {
  return queryOptions({
    queryKey: settingsKeys.agentTokens(),
    queryFn: () => apiClient.request(agentTokenEndpoints.list, {}),
  });
}

export function agentTokenCreateMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (
      body: EndpointRequest<typeof agentTokenEndpoints.create>["body"],
    ) =>
      apiClient.request(agentTokenEndpoints.create, {
        body,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: settingsKeys.agentTokens(),
      });
    },
  });
}

export function agentTokenRevokeMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (tokenId: string) =>
      apiClient.request(agentTokenEndpoints.revoke, {
        params: { tokenId },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: settingsKeys.agentTokens(),
      });
    },
  });
}
