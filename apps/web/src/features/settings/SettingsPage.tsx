import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  EmailChangeSchema,
  MailboxCreateSchema,
  PasswordResetSchema,
  type EndpointResponse,
  mailboxEndpoints,
} from "@unimailbox/contracts";
import { ErrorState, LoadingState } from "../../components/Status";
import { BidiText } from "../../components/BidiText";
import { PasswordInput } from "../../components/ui/password-input";
import { FieldError, FormRoot, useAppForm } from "../../lib/form/app-form";
import { endSession } from "../../lib/session";
import { DEFAULT_THEME_COLOR } from "../../lib/theme";
import { useUiStore } from "../../lib/ui-store";
import { supportedTimeZones } from "../../i18n/timezone";
import { mailboxesQueryOptions } from "../mail/api";
import { type SettingsSection } from "./sections";
import {
  identityEmailMutationOptions,
  identityPasswordMutationOptions,
  mailboxCreateSettingsMutationOptions,
  mailboxMemberSettingsMutationOptions,
  mailboxMembersQueryOptions,
} from "./api";
import { McpSettingsPage } from "./McpSettingsPage";

export type { SettingsSection } from "./sections";
type Member = EndpointResponse<typeof mailboxEndpoints.listMembers>[number];
const timeZones = supportedTimeZones();

function Submit({
  disabled,
  children,
}: {
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <button className="button primary" disabled={disabled} type="submit">
      {children}
    </button>
  );
}

function MailboxMembers({ mailboxId }: { mailboxId: string }) {
  const { t } = useTranslation("settings");
  const client = useQueryClient();
  const members = useQuery(mailboxMembersQueryOptions(mailboxId));
  const member = useMutation(mailboxMemberSettingsMutationOptions(client));
  const form = useAppForm({
    defaultValues: {
      userId: "",
      role: "viewer" as "viewer" | "sender" | "admin",
    },
    validators: { onSubmit: mailboxEndpoints.addMember.request.body },
    onSubmit: async ({ value }) => {
      await member.mutateAsync({ action: "add", mailboxId, ...value });
      form.reset();
    },
  });
  return (
    <details className="mailbox-members">
      <summary>{t("mailboxes.sharing")}</summary>
      {members.isLoading ? (
        <LoadingState label={t("mailboxes.loadingMembers")} />
      ) : members.error ? (
        <ErrorState error={members.error} />
      ) : (
        <div className="member-list">
          {members.data?.map((item: Member) => (
            <div key={item.user_id}>
              <span>
                <strong>
                  <BidiText>{item.display_name || item.email}</BidiText>
                </strong>
                <small>
                  <BidiText kind="identifier">{item.email}</BidiText>
                </small>
              </span>
              <select
                aria-label={t("mailboxes.roleFor", { email: item.email })}
                onChange={(event) =>
                  member.mutate({
                    action: "update",
                    mailboxId,
                    userId: item.user_id,
                    role: event.target.value as Member["role"],
                  })
                }
                value={item.role}
              >
                <option value="viewer">{t("mailboxes.roles.viewer")}</option>
                <option value="sender">{t("mailboxes.roles.sender")}</option>
                <option value="admin">{t("mailboxes.roles.admin")}</option>
              </select>
              <button
                className="text-button danger"
                onClick={() =>
                  member.mutate({
                    action: "remove",
                    mailboxId,
                    userId: item.user_id,
                  })
                }
                type="button"
              >
                {t("mailboxes.remove")}
              </button>
            </div>
          ))}
        </div>
      )}
      <FormRoot className="member-form" form={form}>
        <form.AppField name="userId">
          {(field) => (
            <label>
              <span className="sr-only">{t("mailboxes.memberUserId")}</span>
              <input
                aria-label={t("mailboxes.memberUserId")}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value)}
                value={field.state.value}
              />
              <FieldError label={t("mailboxes.memberUserId")} />
            </label>
          )}
        </form.AppField>
        <form.AppField name="role">
          {(field) => (
            <label>
              <span className="sr-only">{t("mailboxes.memberRole")}</span>
              <select
                aria-label={t("mailboxes.memberRole")}
                onBlur={field.handleBlur}
                onChange={(event) =>
                  field.handleChange(
                    event.target.value as "viewer" | "sender" | "admin",
                  )
                }
                value={field.state.value}
              >
                <option value="viewer">{t("mailboxes.roles.viewer")}</option>
                <option value="sender">{t("mailboxes.roles.sender")}</option>
                <option value="admin">{t("mailboxes.roles.admin")}</option>
              </select>
              <FieldError label={t("mailboxes.memberRole")} />
            </label>
          )}
        </form.AppField>
        <Submit disabled={member.isPending}>{t("mailboxes.share")}</Submit>
      </FormRoot>
      {member.error ? <ErrorState error={member.error} /> : null}
    </details>
  );
}

function Preferences() {
  const { t, i18n } = useTranslation("settings");
  const themeColor = useUiStore((state) => state.themeColor);
  const timeZone = useUiStore((state) => state.timeZone);
  const setThemeColor = useUiStore((state) => state.setThemeColor);
  const setTimeZone = useUiStore((state) => state.setTimeZone);
  return (
    <section className="settings-card vertical">
      <p>{t("preferences.description")}</p>
      <label className="field" htmlFor="settings-language">
        <span>{t("preferences.language")}</span>
        <select
          id="settings-language"
          onChange={(event) => void i18n.changeLanguage(event.target.value)}
          value={i18n.language}
        >
          <option value="en">{t("preferences.english")}</option>
          <option value="zh-CN">{t("preferences.chinese")}</option>
        </select>
      </label>
      <label className="field" htmlFor="settings-time-zone">
        <span>{t("preferences.timeZone")}</span>
        <select
          aria-label={t("preferences.timeZone")}
          id="settings-time-zone"
          onChange={(event) => setTimeZone(event.target.value)}
          value={timeZone}
        >
          {timeZones.map((value) => (
            <option key={value} value={value}>
              {value.replaceAll("_", " ")}
            </option>
          ))}
        </select>
        <small>{t("preferences.timeZoneDescription")}</small>
      </label>
      <div className="field theme-color-field">
        <label htmlFor="settings-theme-color">
          {t("preferences.themeColor")}
        </label>
        <div className="theme-color-control">
          <input
            aria-label={t("preferences.themeColor")}
            id="settings-theme-color"
            onChange={(event) => setThemeColor(event.target.value)}
            type="color"
            value={themeColor}
          />
          <output htmlFor="settings-theme-color">
            {themeColor.toUpperCase()}
          </output>
          <button
            className="text-button"
            onClick={() => setThemeColor(DEFAULT_THEME_COLOR)}
            type="button"
          >
            {t("preferences.resetThemeColor")}
          </button>
        </div>
        <small>{t("preferences.themeColorDescription")}</small>
      </div>
    </section>
  );
}

export function SettingsPage({ section }: { section: SettingsSection }) {
  const { t } = useTranslation("settings");
  const navigate = useNavigate();
  const client = useQueryClient();
  const email = useMutation(identityEmailMutationOptions());
  const password = useMutation(identityPasswordMutationOptions());
  const mailbox = useMutation(mailboxCreateSettingsMutationOptions(client));
  const mailboxes = useQuery({
    ...mailboxesQueryOptions(),
    enabled: section === "mailboxes",
  });
  const emailForm = useAppForm({
    defaultValues: { currentPassword: "", email: "" },
    validators: { onSubmit: EmailChangeSchema },
    onSubmit: async ({ value }) => {
      await email.mutateAsync(value);
      endSession(client);
      await navigate({ to: "/login", replace: true });
    },
  });
  const passwordForm = useAppForm({
    defaultValues: { currentPassword: "", newPassword: "" },
    validators: { onSubmit: PasswordResetSchema },
    onSubmit: async ({ value }) => {
      await password.mutateAsync(value);
      endSession(client);
      await navigate({ to: "/login", replace: true });
    },
  });
  const mailboxForm = useAppForm({
    defaultValues: { localPart: "", domainId: "", displayName: "" },
    validators: { onSubmit: MailboxCreateSchema as never },
    onSubmit: async ({ value }) => {
      await mailbox.mutateAsync(value);
      mailboxForm.reset();
    },
  });
  return (
    <section className="settings-page">
      <header>
        <div>
          <div className="section-kicker">{t("kicker")}</div>
          <h1>{t(`title.${section}`)}</h1>
        </div>
      </header>
      {section === "preferences" ? (
        <Preferences />
      ) : section === "account" ? (
        <section className="settings-card">
          <ShieldCheck />
          <div>
            <h2>{t("account.heading")}</h2>
            <p>{t("account.description")}</p>
            <div className="account-security-grid">
              <div>
                <h3>{t("account.emailHeading")}</h3>
                <FormRoot className="form-stack" form={emailForm}>
                  <emailForm.AppField name="email">
                    {(field) => (
                      <label className="field">
                        <span>{t("account.email")}</span>
                        <input
                          autoComplete="email"
                          onBlur={field.handleBlur}
                          onChange={(event) =>
                            field.handleChange(event.target.value)
                          }
                          type="email"
                          value={field.state.value}
                        />
                        <FieldError label={t("account.email")} />
                      </label>
                    )}
                  </emailForm.AppField>
                  <emailForm.AppField name="currentPassword">
                    {(field) => (
                      <label className="field">
                        <span>{t("account.currentPassword")}</span>
                        <PasswordInput
                          ariaLabel={t("account.currentPassword")}
                          autoComplete="current-password"
                          onBlur={field.handleBlur}
                          onChange={(value) => field.handleChange(value)}
                          value={field.state.value}
                        />
                        <FieldError label={t("account.currentPassword")} />
                      </label>
                    )}
                  </emailForm.AppField>
                  {email.error ? <ErrorState error={email.error} /> : null}
                  <Submit disabled={email.isPending}>
                    {t("account.updateEmail")}
                  </Submit>
                </FormRoot>
              </div>
              <div>
                <h3>{t("account.passwordHeading")}</h3>
                <FormRoot className="form-stack" form={passwordForm}>
                  <passwordForm.AppField name="currentPassword">
                    {(field) => (
                      <label className="field">
                        <span>{t("account.currentPassword")}</span>
                        <PasswordInput
                          ariaLabel={t("account.currentPassword")}
                          autoComplete="current-password"
                          onBlur={field.handleBlur}
                          onChange={(value) => field.handleChange(value)}
                          value={field.state.value}
                        />
                        <FieldError label={t("account.currentPassword")} />
                      </label>
                    )}
                  </passwordForm.AppField>
                  <passwordForm.AppField name="newPassword">
                    {(field) => (
                      <label className="field">
                        <span>{t("account.newPassword")}</span>
                        <PasswordInput
                          ariaLabel={t("account.newPassword")}
                          autoComplete="new-password"
                          onBlur={field.handleBlur}
                          onChange={(value) => field.handleChange(value)}
                          value={field.state.value}
                        />
                        <FieldError label={t("account.newPassword")} />
                      </label>
                    )}
                  </passwordForm.AppField>
                  {password.error ? (
                    <ErrorState error={password.error} />
                  ) : null}
                  <Submit disabled={password.isPending}>
                    {t("account.updatePassword")}
                  </Submit>
                </FormRoot>
              </div>
            </div>
            <div className="session-warning">
              <ShieldCheck aria-hidden="true" />
              {t("account.warning")}
            </div>
          </div>
        </section>
      ) : section === "mailboxes" ? (
        <div className="settings-grid">
          <section className="settings-card vertical">
            <h2>{t("mailboxes.heading")}</h2>
            {mailboxes.isLoading ? (
              <LoadingState />
            ) : mailboxes.error ? (
              <ErrorState error={mailboxes.error} />
            ) : (
              <div className="simple-list">
                {mailboxes.data?.map((item) => (
                  <div key={item.id}>
                    <strong>
                      <BidiText>{item.display_name || item.address}</BidiText>
                    </strong>
                    <span>
                      <BidiText kind="identifier">{item.address}</BidiText>
                    </span>
                    <MailboxMembers mailboxId={item.id} />
                  </div>
                ))}
              </div>
            )}
          </section>
          <section className="settings-card vertical">
            <h2>{t("mailboxes.createHeading")}</h2>
            <FormRoot className="form-stack" form={mailboxForm}>
              <mailboxForm.AppField name="localPart">
                {(field) => (
                  <label className="field">
                    <span>{t("mailboxes.localPart")}</span>
                    <input
                      onBlur={field.handleBlur}
                      onChange={(event) =>
                        field.handleChange(event.target.value)
                      }
                      value={field.state.value}
                    />
                    <FieldError label={t("mailboxes.localPart")} />
                  </label>
                )}
              </mailboxForm.AppField>
              <mailboxForm.AppField name="domainId">
                {(field) => (
                  <label className="field">
                    <span>{t("mailboxes.domainId")}</span>
                    <input
                      onBlur={field.handleBlur}
                      onChange={(event) =>
                        field.handleChange(event.target.value)
                      }
                      value={field.state.value}
                    />
                    <FieldError label={t("mailboxes.domainId")} />
                  </label>
                )}
              </mailboxForm.AppField>
              <mailboxForm.AppField name="displayName">
                {(field) => (
                  <label className="field">
                    <span>{t("mailboxes.displayName")}</span>
                    <input
                      onBlur={field.handleBlur}
                      onChange={(event) =>
                        field.handleChange(event.target.value)
                      }
                      value={field.state.value}
                    />
                    <FieldError label={t("mailboxes.displayName")} />
                  </label>
                )}
              </mailboxForm.AppField>
              {mailbox.error ? <ErrorState error={mailbox.error} /> : null}
              <Submit disabled={mailbox.isPending}>
                {t("mailboxes.create")}
              </Submit>
            </FormRoot>
          </section>
        </div>
      ) : section === "mcp" ? (
        <McpSettingsPage />
      ) : (
        <Preferences />
      )}
    </section>
  );
}
