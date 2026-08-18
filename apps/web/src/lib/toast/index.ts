import { useCallback } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { i18n } from "i18next";
import type { UseMutationOptions } from "@tanstack/react-query";
import { ApiClientError } from "../api/errors";
import { captureBrowserError } from "../sentry";
import { apiErrorToast, useApiErrorToast } from "./use-api-error-toast";

let appI18n: i18n | undefined;

export function setToastI18n(instance: i18n): void {
  appI18n = instance;
}

function translate(key: string): string {
  return appI18n?.t(key) ?? key;
}

export function toastApiError(error: unknown): void {
  if (error instanceof ApiClientError) {
    apiErrorToast(error, translate);
    return;
  }
  captureBrowserError(error, "mutation");
  toast.error(translate("toast.title.error"));
}

export function toastSuccess(message?: ReactNode): void {
  toast.success(message ?? translate("toast.title.success"));
}

export function toastInfo(message: ReactNode): void {
  toast.info(message);
}

export function useAppToaster() {
  const { t } = useTranslation("common");
  const toastError = useCallback(
    (error: unknown) => {
      if (error instanceof ApiClientError) apiErrorToast(error, t);
      else {
        captureBrowserError(error, "mutation");
        toast.error(t("toast.title.error"));
      }
    },
    [t],
  );
  const toastSuccessWithTranslation = useCallback(
    (message?: ReactNode) => toast.success(message ?? t("toast.title.success")),
    [t],
  );
  const toastInfoWithTranslation = useCallback(
    (message: ReactNode) => toast.info(message),
    [],
  );
  return {
    toastError,
    toastSuccess: toastSuccessWithTranslation,
    toastInfo: toastInfoWithTranslation,
  };
}

export { useApiErrorToast };

export type ToastMessages<TData = unknown, TVariables = unknown> = {
  success?: ReactNode | ((data: TData, variables: TVariables) => ReactNode);
  error?: ReactNode | ((error: unknown) => ReactNode);
  pending?: ReactNode;
};

export function withToast<
  TData = unknown,
  TError = unknown,
  TVariables = void,
  TOnMutateResult = unknown,
>(
  options: UseMutationOptions<TData, TError, TVariables, TOnMutateResult>,
  messages: ToastMessages<TData, TVariables> = {},
): UseMutationOptions<TData, TError, TVariables, TOnMutateResult> {
  const onMutate = options.onMutate;
  const onSuccess = options.onSuccess;
  const onError = options.onError;
  return {
    ...options,
    onMutate: (variables, context) => {
      const result = onMutate?.(variables, context);
      if (messages.pending) toast.loading(messages.pending);
      return result ?? (undefined as unknown as TOnMutateResult);
    },
    onSuccess: (data, variables, onMutateResult, context) => {
      const result = onSuccess?.(data, variables, onMutateResult, context);
      if (messages.success) {
        const message =
          typeof messages.success === "function"
            ? (
                messages.success as (
                  data: TData,
                  variables: TVariables,
                ) => ReactNode
              )(data, variables)
            : messages.success;
        toast.success(message);
      }
      return result;
    },
    onError: (error, variables, onMutateResult, context) => {
      const result = onError?.(error, variables, onMutateResult, context);
      if (messages.error) {
        const message =
          typeof messages.error === "function"
            ? (messages.error as (error: unknown) => ReactNode)(error)
            : messages.error;
        toast.error(message);
      } else {
        toastApiError(error);
      }
      return result;
    },
  };
}
