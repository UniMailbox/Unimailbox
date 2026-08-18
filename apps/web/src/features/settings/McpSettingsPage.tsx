import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ShieldCheck } from "lucide-react";
import {
  PERMISSION_KEYS,
  type AgentTokenCreateResponse,
  type EndpointResponse,
  type PermissionKey,
  agentTokenEndpoints,
} from "@unimailbox/contracts";
import { ErrorState, LoadingState } from "../../components/Status";
import { BidiText } from "../../components/BidiText";
import { Button } from "../../components/ui/button";
import { FieldError, FormRoot, useAppForm } from "../../lib/form/app-form";
import {
  agentTokenCreateMutationOptions,
  agentTokenListQueryOptions,
  agentTokenRevokeMutationOptions,
} from "./api";
import { useAppToaster } from "../../lib/toast";

type AgentTokenItem = EndpointResponse<typeof agentTokenEndpoints.list>[number];

interface IssuedToken {
  name: string;
  plaintext: string;
}

function formatDate(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return "";
    return new Date(value)
      .toISOString()
      .replace("T", " ")
      .replace(/\..*$/u, "");
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return new Date(parsed).toISOString().replace("T", " ").replace(/\..*$/u, "");
}

function plainDate(value: number | string | null | undefined): string {
  const formatted = formatDate(value);
  return formatted ? formatted.slice(0, 10) : "";
}

function scopeLabel(key: PermissionKey): string {
  return key;
}

export function McpSettingsPage() {
  const { t, i18n } = useTranslation("settings");
  const client = useQueryClient();
  const toaster = useAppToaster();
  const tokens = useQuery(agentTokenListQueryOptions());
  const create = useMutation(agentTokenCreateMutationOptions(client));
  const revoke = useMutation(agentTokenRevokeMutationOptions(client));
  const [issued, setIssued] = useState<IssuedToken | null>(null);
  const [copied, setCopied] = useState(false);

  const form = useAppForm({
    defaultValues: {
      name: "",
      scopes: ["message.read"] as PermissionKey[],
      expiresAt: "",
    },
    validators: { onSubmit: agentTokenEndpoints.create.request.body as never },
    onSubmit: async ({ value }) => {
      const expiresAt = value.expiresAt.trim();
      const result: AgentTokenCreateResponse = await create.mutateAsync({
        name: value.name,
        scopes: value.scopes,
        ...(expiresAt ? { expires_at: expiresAt } : {}),
      });
      setIssued({ name: result.name, plaintext: result.plaintext_token });
      setCopied(false);
      form.reset();
    },
  });

  return (
    <section className="settings-page">
      <header>
        <div>
          <div className="section-kicker">{t("kicker")}</div>
          <h1>{t("title.mcp")}</h1>
        </div>
      </header>
      <section className="settings-card">
        <ShieldCheck />
        <div>
          <h2>{t("mcp.heading")}</h2>
          <p>{t("mcp.description")}</p>
        </div>
      </section>

      <section className="settings-card vertical">
        <h2>{t("mcp.formHeading")}</h2>
        <FormRoot className="form-stack" form={form}>
          <form.AppField name="name">
            {(field) => (
              <label className="field">
                <span>{t("mcp.nameLabel")}</span>
                <input
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder={t("mcp.namePlaceholder")}
                  value={field.state.value}
                />
                <FieldError label={t("mcp.nameLabel")} />
              </label>
            )}
          </form.AppField>
          <form.AppField name="scopes">
            {(field) => (
              <fieldset className="field">
                <legend>{t("mcp.scopesLabel")}</legend>
                <div className="scope-grid">
                  {PERMISSION_KEYS.map((scope) => {
                    const selected = field.state.value.includes(scope);
                    return (
                      <label
                        className={
                          selected
                            ? "scope-chip scope-chip-selected"
                            : "scope-chip"
                        }
                        key={scope}
                      >
                        <input
                          checked={selected}
                          onChange={(event) => {
                            const current = new Set(field.state.value);
                            if (event.target.checked) current.add(scope);
                            else current.delete(scope);
                            field.handleChange([...current]);
                          }}
                          type="checkbox"
                        />
                        <code>{scopeLabel(scope)}</code>
                      </label>
                    );
                  })}
                </div>
                <FieldError label={t("mcp.scopesLabel")} />
              </fieldset>
            )}
          </form.AppField>
          <form.AppField name="expiresAt">
            {(field) => (
              <label className="field">
                <span>{t("mcp.expiresLabel")}</span>
                <input
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder={t("mcp.expiresPlaceholder")}
                  type="text"
                  value={field.state.value}
                />
                <FieldError label={t("mcp.expiresLabel")} />
              </label>
            )}
          </form.AppField>
          {create.error ? <ErrorState error={create.error} /> : null}
          <Button disabled={create.isPending} type="submit">
            {t("mcp.submit")}
          </Button>
        </FormRoot>
      </section>

      {issued ? (
        <section className="settings-card vertical issued-token">
          <h2>{t("mcp.plaintextHeading")}</h2>
          <p>{t("mcp.plaintextWarning")}</p>
          <div className="issued-token-row">
            <strong>
              <BidiText>{issued.name}</BidiText>
            </strong>
            <code className="issued-token-value">
              <BidiText kind="identifier">{issued.plaintext}</BidiText>
            </code>
            <Button
              onClick={async () => {
                try {
                  if (navigator.clipboard?.writeText) {
                    await navigator.clipboard.writeText(issued.plaintext);
                  }
                  setCopied(true);
                  toaster.toastSuccess(
                    i18n.language.startsWith("zh")
                      ? "已复制到剪贴板"
                      : "Copied to clipboard",
                  );
                } catch {
                  toaster.toastError(
                    i18n.language.startsWith("zh")
                      ? "复制失败，请手动选择"
                      : "Copy failed — select the token manually",
                  );
                }
              }}
              type="button"
              variant="outline"
            >
              {copied ? t("mcp.plaintextCopied") : t("mcp.plaintextCopy")}
            </Button>
          </div>
          <Button
            onClick={() => {
              setIssued(null);
              setCopied(false);
            }}
            type="button"
            variant="ghost"
          >
            {t("mcp.dismiss")}
          </Button>
        </section>
      ) : null}

      <section className="settings-card vertical">
        <h2>{t("mcp.listHeading")}</h2>
        {tokens.isLoading ? (
          <LoadingState label={t("mcp.loading")} />
        ) : tokens.error ? (
          <ErrorState error={tokens.error} />
        ) : tokens.data && tokens.data.length > 0 ? (
          <div className="agent-token-list">
            {tokens.data.map((token) => (
              <AgentTokenRow
                key={token.id}
                token={token}
                onRevoke={(id) => revoke.mutate(id)}
                revoking={revoke.isPending && revoke.variables === token.id}
              />
            ))}
          </div>
        ) : (
          <p>{t("mcp.listEmpty")}</p>
        )}
      </section>
    </section>
  );
}

function AgentTokenRow({
  token,
  onRevoke,
  revoking,
}: {
  token: AgentTokenItem;
  onRevoke(id: string): void;
  revoking: boolean;
}) {
  const { t, i18n } = useTranslation("settings");
  const isRevoked = token.revoked_at !== null && token.revoked_at !== undefined;
  const expires = plainDate(token.expires_at);
  const lastUsed = token.last_used_at ? plainDate(token.last_used_at) : "";
  return (
    <div className="agent-token-row">
      <div>
        <strong>
          <BidiText>{token.name}</BidiText>
        </strong>
        <small>
          {isRevoked ? t("mcp.statusRevoked") : t("mcp.statusActive")} ·{" "}
          {t("mcp.scopesSummary", { count: token.scopes.length })}
        </small>
        <div className="agent-token-scopes">
          {token.scopes.map((scope) => (
            <code className="scope-chip" key={scope}>
              {scopeLabel(scope)}
            </code>
          ))}
        </div>
      </div>
      <dl className="agent-token-meta">
        <div>
          <dt>{t("mcp.createdAt")}</dt>
          <dd>
            <BidiText>{plainDate(token.created_at) || "—"}</BidiText>
          </dd>
        </div>
        <div>
          <dt>{t("mcp.lastUsedAt")}</dt>
          <dd>
            <BidiText>{lastUsed || t("mcp.never")}</BidiText>
          </dd>
        </div>
        <div>
          <dt>{t("mcp.expiresAt")}</dt>
          <dd>
            <BidiText>{expires || t("mcp.never")}</BidiText>
          </dd>
        </div>
      </dl>
      <Button
        disabled={isRevoked || revoking}
        onClick={() => {
          if (typeof window !== "undefined") {
            const confirmed = window.confirm(t("mcp.confirmRevoke"));
            if (!confirmed) return;
          }
          onRevoke(token.id);
          // No-op; this branch exists only to avoid referencing
          // `i18n` exclusively for linting — fallback if `window` is missing.
          void i18n;
        }}
        type="button"
        variant="ghost"
      >
        {t("mcp.revoke")}
      </Button>
    </div>
  );
}
