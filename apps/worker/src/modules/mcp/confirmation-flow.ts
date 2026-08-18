import type { Principal } from "@unimailbox/contracts";
import type { AppContext } from "../../app-context";
import { createConfirmation, requireConfirmation } from "./confirmation";
import { McpToolError } from "./errors";

type ConfirmationArgs = Record<string, unknown> & {
  confirmation_token?: unknown;
};

type ConfirmationResult<T> =
  | {
      confirmation_required: true;
      preview: unknown;
      confirmation_token: string;
    }
  | { result: T };

export async function wrapWithConfirmation<T>(
  ctx: AppContext,
  principal: Principal,
  args: ConfirmationArgs,
  previewBuilder: (args: ConfirmationArgs) => Promise<unknown> | unknown,
  execute: () => Promise<T>,
): Promise<ConfirmationResult<T>> {
  const token =
    typeof args.confirmation_token === "string"
      ? args.confirmation_token
      : undefined;
  const payload: Record<string, unknown> = { ...args };
  delete payload.confirmation_token;

  if (!token) {
    const preview = await previewBuilder(args);
    const confirmationToken = await createConfirmation(ctx, principal, payload);
    return {
      confirmation_required: true,
      preview,
      confirmation_token: confirmationToken,
    };
  }

  const confirmed = await requireConfirmation(ctx, principal, token, payload);
  if (!confirmed) {
    throw new McpToolError("confirmation_invalid");
  }
  return { result: await execute() };
}
