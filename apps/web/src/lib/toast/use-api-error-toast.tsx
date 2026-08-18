import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import * as Sentry from "@sentry/react";
import { apiErrorToken } from "../../i18n/errors";
import { ApiClientError } from "../api/errors";
import { shouldCaptureBrowserError } from "../sentry";

export function reportApiError(error: ApiClientError): void {
  console.debug("[api error]", error.code, error.requestId);
  if (!shouldCaptureBrowserError(error)) return;
  Sentry.withScope((scope) => {
    scope.setTag("error.source", "mutation");
    scope.setTag("api.error.code", error.code);
    scope.setTag("http.status_code", String(error.status));
    if (error.requestId) scope.setTag("request.id", error.requestId);
    Sentry.captureException(error);
  });
}

export function useApiErrorToast(
  error: unknown,
  options: { enabled?: boolean } = {},
): void {
  const { t } = useTranslation(["common", "errors"]);
  const enabled = options.enabled ?? true;
  useEffect(() => {
    if (!enabled || !(error instanceof ApiClientError)) return;
    reportApiError(error);
    toast.error(t("toast.title.error"), {
      description: t(apiErrorToken(error).key),
    });
  }, [enabled, error, t]);
}

export function apiErrorToast(
  error: unknown,
  t: (key: string) => string,
): void {
  if (error instanceof ApiClientError) {
    reportApiError(error);
    toast.error(t("toast.title.error"), {
      description: t(apiErrorToken(error).key),
    });
  } else {
    toast.error(t("toast.title.error"));
  }
}
