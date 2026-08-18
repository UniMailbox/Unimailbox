import { DomainError } from "@unimailbox/contracts";

/**
 * Stable MCP-facing error codes. These codes survive across wire formats
 * (JSON-RPC `error.code`, REST `error.code`, and MCP `tools/call`
 * `isError` payloads) so client retry logic and operator dashboards can
 * rely on them. Add new codes here, never inline.
 */
export const MCP_ERROR_CODES = [
  "unauthorized",
  "forbidden",
  "not_found",
  "invalid_args",
  "rate_limited",
  "confirmation_required",
  "confirmation_invalid",
  "idempotency_conflict",
  "internal",
] as const;

export type McpErrorCode = (typeof MCP_ERROR_CODES)[number];

const DEFAULT_MESSAGES: Record<McpErrorCode, string> = {
  unauthorized: "Authentication is required",
  forbidden: "The requested permission is missing",
  not_found: "Resource not found",
  invalid_args: "The supplied arguments are invalid",
  rate_limited: "Rate limit exceeded",
  confirmation_required: "A two-stage confirmation token is required",
  confirmation_invalid: "The confirmation token is invalid or already used",
  idempotency_conflict:
    "The idempotency key was reused with a different payload",
  internal: "An internal error occurred",
};

const DEFAULT_STATUS: Record<McpErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  invalid_args: 400,
  rate_limited: 429,
  confirmation_required: 409,
  confirmation_invalid: 409,
  idempotency_conflict: 409,
  internal: 500,
};

/**
 * DomainError-shaped wrapper that preserves a stable MCP code on top of the
 * existing HTTP error envelope. The class extends `DomainError` so existing
 * `errorResponse(error)` callers still format it correctly when it escapes
 * into the worker HTTP router; the new `toMcpResult()` method adds the MCP
 * wire shape on top.
 */
export class McpToolError extends DomainError {
  constructor(code: McpErrorCode, message?: string, details?: unknown) {
    super(
      code,
      message ?? DEFAULT_MESSAGES[code],
      DEFAULT_STATUS[code],
      details,
    );
    this.name = "McpToolError";
  }
}

/**
 * Convert an unknown error into the MCP-compliant `CallToolResult` shape.
 *
 * The MCP `tools/call` result is `{ content, isError? }`; we keep
 * `content: [{ type: "text", text: JSON.stringify(...) }]` so a client can
 * always parse the response with the same shape, even for errors. The
 * `structuredContent` field carries a machine-readable envelope with the
 * stable `code` and an optional `details` payload.
 */
export function toMcpResult(error: unknown): {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
  structuredContent: { code: string; message: string; details?: unknown };
} {
  if (error instanceof McpToolError) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            code: error.code,
            message: error.message,
            ...(error.details === undefined ? {} : { details: error.details }),
          }),
        },
      ],
      structuredContent: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    };
  }
  if (error instanceof DomainError) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            code: error.code,
            message: error.message,
            ...(error.details === undefined ? {} : { details: error.details }),
          }),
        },
      ],
      structuredContent: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    };
  }
  const message =
    error instanceof Error ? error.message : "An internal error occurred";
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({ code: "internal", message }),
      },
    ],
    structuredContent: { code: "internal", message },
  };
}
