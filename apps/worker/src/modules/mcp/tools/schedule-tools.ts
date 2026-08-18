import { z } from "zod";
import type { McpToolContext } from "../context";
import { McpToolError } from "../errors";
import { wrapWithConfirmation } from "../confirmation-flow";
import { idempotencyForMcp } from "../idempotency";
import {
  SCHEDULE_MAX_LEAD_SECONDS,
  SCHEDULE_MIN_LEAD_SECONDS,
  resolveScheduleInstant,
  systemClock,
  type Clock,
} from "../../messages/schedule";
import type { WriteToolDef } from "./write-common";

/**
 * First-party MCP scheduled-send tools.
 *
 * PR #5 of the email-mcp-server rollout. Two tools land here:
 *
 *   - `schedule_message`: write a future send into `outbound_jobs` with
 *     `created_via_schedule = 1` and `available_at = scheduled_at`. Two-stage
 *     confirmation matches the existing `send_message` flow.
 *   - `cancel_scheduled`: revoke a previously scheduled send. Idempotent —
 *     a second call against the same `job_id` returns the same status.
 *
 * Design notes:
 *
 *   - `cancel_scheduled` deliberately DELETEs the `outbound_jobs` row rather
 *     than flipping `status = 'cancelled'`. The schema's CHECK constraint
 *     (`status IN ('pending','enqueued','processing','succeeded','failed')`,
 *     migrations/0001_initial.sql:182) does not allow 'cancelled', and the
 *     existing draft-schedule path cancels via DELETE (see
 *     `DraftApplicationService.cancelSchedule`). Cancelling via DELETE also
 *     keeps the row count aligned with what the cron dispatcher can observe.
 *   - Window validation reuses `resolveScheduleInstant` from
 *     `apps/worker/src/modules/messages/schedule.ts` so the 90s–30d window
 *     stays in lockstep with the REST schedule endpoint. The dispatcher
 *     calls `resolveScheduleInstant` directly (not through the draft
 *     service) so PR #5 does not have to depend on a draft row existing
 *     first.
 */

const RecipientListSchema = z.array(z.string().email()).max(100).default([]);
const IdempotencyKeySchema = z.string().min(1).max(255);

export const ScheduleMessageInputSchema = z.object({
  mailbox_id: z.string().min(1),
  to: z.array(z.string().email()).min(1).max(100),
  cc: RecipientListSchema,
  bcc: RecipientListSchema,
  subject: z.string().max(998).default(""),
  text_body: z.string().max(2_000_000).default(""),
  html_body: z.string().max(2_000_000).optional(),
  // Attachment IDs are accepted so the scheduled row mirrors the user's
  // intent, but PR #5 resolves them eagerly — the upload must be in
  // `status = 'uploaded'` before the schedule call succeeds. A future PR
  // can switch to lazy attachment resolution when the cron dispatcher
  // fetches the row at fire time.
  attachments: z.array(z.string().min(1)).max(25).default([]),
  scheduled_at: z.string().min(1),
  confirmation_token: z.string().min(1).optional(),
  idempotency_key: IdempotencyKeySchema,
});

export const CancelScheduledInputSchema = z.object({
  job_id: z.string().min(1),
  idempotency_key: IdempotencyKeySchema,
});

export type ScheduleMessageInput = z.infer<typeof ScheduleMessageInputSchema>;
export type CancelScheduledInput = z.infer<typeof CancelScheduledInputSchema>;

const scheduleMessageJsonSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    mailbox_id: { type: "string", description: "Sender mailbox id." },
    to: { type: "array", items: { type: "string", format: "email" } },
    cc: { type: "array", items: { type: "string", format: "email" } },
    bcc: { type: "array", items: { type: "string", format: "email" } },
    subject: { type: "string", maxLength: 998 },
    text_body: { type: "string", maxLength: 2_000_000 },
    html_body: { type: "string", maxLength: 2_000_000 },
    attachments: {
      type: "array",
      items: { type: "string" },
      maxItems: 25,
    },
    scheduled_at: {
      type: "string",
      description:
        "ISO 8601 instant with explicit UTC offset. Must be ≥90s and ≤30d from now.",
    },
    confirmation_token: { type: "string" },
    idempotency_key: { type: "string", minLength: 1, maxLength: 255 },
  },
  required: ["mailbox_id", "to", "scheduled_at", "idempotency_key"],
  additionalProperties: false,
};

const cancelScheduledJsonSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    job_id: {
      type: "string",
      description: "Outbound job id returned by schedule_message.",
    },
    idempotency_key: { type: "string", minLength: 1, maxLength: 255 },
  },
  required: ["job_id", "idempotency_key"],
  additionalProperties: false,
};

interface SenderRow {
  id: string;
  domain_id: string;
  address: string;
  display_name: string;
  outbound_connection_id: string | null;
  domain_status: string;
  mailbox_status: string;
}

interface JobOwnershipRow {
  id: string;
  message_id: string;
  created_by_user_id: string;
}

function invalidArgs(error: z.ZodError): McpToolError {
  return new McpToolError("invalid_args", undefined, error.flatten());
}

/**
 * Resolved schedule window — exposed so the integration tests can pin
 * `now` without monkey-patching `Date`.
 */
export interface ScheduleWindow {
  minLeadSeconds: number;
  maxLeadSeconds: number;
}

export const SCHEDULE_WINDOW: ScheduleWindow = {
  minLeadSeconds: SCHEDULE_MIN_LEAD_SECONDS,
  maxLeadSeconds: SCHEDULE_MAX_LEAD_SECONDS,
};

interface ScheduleDependencies {
  clock?: Clock;
}

async function requireActiveMailbox(
  ctx: McpToolContext,
  userId: string,
  mailboxId: string,
): Promise<SenderRow> {
  const access = await ctx.modules.mailboxes.findAccess(userId, mailboxId);
  if (!access) {
    throw new McpToolError("not_found", "Mailbox not found");
  }
  const sender = await ctx.env.DB.prepare(
    `SELECT m.id, m.domain_id, m.address, m.display_name,
            d.outbound_connection_id,
            d.status AS domain_status, m.status AS mailbox_status
     FROM mailboxes m
     JOIN domains d ON d.id = m.domain_id
     WHERE m.id = ?`,
  )
    .bind(mailboxId)
    .first<SenderRow>();
  if (
    !sender ||
    sender.mailbox_status !== "active" ||
    sender.domain_status !== "active"
  ) {
    throw new McpToolError(
      "not_found",
      "The sender mailbox or domain is not active",
    );
  }
  return sender;
}

function recipients(input: ScheduleMessageInput): Array<{
  type: "to" | "cc" | "bcc";
  address: string;
}> {
  return [
    ...input.to.map((address) => ({ type: "to" as const, address })),
    ...input.cc.map((address) => ({ type: "cc" as const, address })),
    ...input.bcc.map((address) => ({ type: "bcc" as const, address })),
  ];
}

/**
 * Insert the future-send row. Lives next to the dispatcher because PR #5
 * deliberately avoids adding a new method on `messages.send` / draft
 * services — the tool owns the SQL shape so future refactors can move it
 * into a shared helper without an additional `app-context` dependency.
 */
async function writeScheduledJob(
  ctx: McpToolContext,
  args: {
    sender: SenderRow;
    input: ScheduleMessageInput;
    resolved: { instant: Date; availableAtText: string };
  },
): Promise<{ jobId: string; messageId: string; scheduledAt: string }> {
  const { sender, input, resolved } = args;
  const messageId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const linkId = crypto.randomUUID();
  const recipientRows = recipients(input);
  const uniqueAddresses = Array.from(
    new Set(recipientRows.map((row) => row.address.toLowerCase())),
  );
  const internalMailboxes =
    uniqueAddresses.length === 0
      ? []
      : (
          await ctx.env.DB.prepare(
            `SELECT id, address FROM mailboxes
             WHERE status = 'active' AND address IN (${uniqueAddresses
               .map(() => "?")
               .join(",")})`,
          )
            .bind(...uniqueAddresses)
            .all<{ id: string; address: string }>()
        ).results;
  const internalByAddress = new Map(
    internalMailboxes.map((row) => [row.address.toLowerCase(), row]),
  );
  const hasExternal = recipientRows.some(
    (row) => !internalByAddress.has(row.address.toLowerCase()),
  );
  const providerConnectionId = hasExternal
    ? sender.outbound_connection_id
    : null;
  if (hasExternal && !providerConnectionId) {
    throw new McpToolError(
      "invalid_args",
      "The sender domain has no outbound provider configured",
    );
  }
  const attachmentRows =
    input.attachments.length === 0
      ? []
      : (
          await ctx.env.DB.prepare(
            `SELECT au.id, au.user_id, au.object_key, au.filename,
                    au.mime_type, au.size_bytes, au.disposition,
                    au.status, au.file_id, au.md5,
                    COALESCE(af.object_key, au.object_key) AS stored_object_key
             FROM attachment_uploads au
             LEFT JOIN attachment_files af ON af.id = au.file_id
             WHERE au.user_id = ?
               AND au.status = 'uploaded'
               AND au.md5 IS NOT NULL
               AND au.expires_at > CURRENT_TIMESTAMP
               AND au.id IN (${input.attachments.map(() => "?").join(",")})`,
          )
            .bind(ctx.principal.userId, ...input.attachments)
            .all<{
              id: string;
              object_key: string;
              filename: string;
              mime_type: string;
              size_bytes: number;
              disposition: "attachment" | "inline";
              stored_object_key: string;
              file_id: string | null;
              md5: string | null;
            }>()
        ).results;
  if (attachmentRows.length !== new Set(input.attachments).size) {
    throw new McpToolError(
      "invalid_args",
      "One or more attachment uploads are unavailable",
    );
  }
  const statements: D1PreparedStatement[] = [
    ctx.env.DB.prepare(
      `INSERT INTO messages (
         id, domain_id, thread_id, from_address, from_name, subject,
         html_body, text_body, status, provider_connection_id,
         created_by_user_id, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?,
                 strftime('%Y-%m-%d %H:%M:%f', 'now'))`,
    ).bind(
      messageId,
      sender.domain_id,
      messageId,
      sender.address,
      sender.display_name,
      input.subject,
      input.html_body ?? "",
      input.text_body,
      providerConnectionId,
      ctx.principal.userId,
    ),
    ctx.env.DB.prepare(
      `INSERT INTO mailbox_messages (id, mailbox_id, message_id, folder)
       VALUES (?, ?, ?, 'drafts')`,
    ).bind(linkId, sender.id, messageId),
  ];
  if (recipientRows.length > 0) {
    statements.push(
      ctx.env.DB.prepare(
        `INSERT INTO message_recipients (
           id, message_id, type, address, display_name
         ) VALUES ${recipientRows.map(() => "(?, ?, ?, ?, '')").join(",")}`,
      ).bind(
        ...recipientRows.flatMap((row) => [
          crypto.randomUUID(),
          messageId,
          row.type,
          row.address,
        ]),
      ),
    );
  }
  for (const upload of attachmentRows) {
    statements.push(
      ctx.env.DB.prepare(
        `INSERT INTO message_attachments (
           id, message_id, upload_id, object_key, filename, mime_type,
           size_bytes, disposition, file_id, md5
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        messageId,
        upload.id,
        upload.stored_object_key,
        upload.filename,
        upload.mime_type,
        upload.size_bytes,
        upload.disposition,
        upload.file_id,
        upload.md5,
      ),
    );
  }
  statements.push(
    ctx.env.DB.prepare(
      `INSERT INTO outbound_jobs (
         id, message_id, status, available_at, created_via_schedule
       ) VALUES (?, ?, 'pending', ?, 1)`,
    ).bind(jobId, messageId, resolved.availableAtText),
  );
  await ctx.env.DB.batch(statements);
  const namespace = ctx.env.MAILBOX_AGENT;
  if (namespace) {
    const stub = namespace.get(namespace.idFromName(input.mailbox_id));
    void stub
      .fetch(
        new Request("https://mailbox-agent/schedule", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            job_id: jobId,
            scheduled_at: resolved.instant.toISOString(),
          }),
        }),
      )
      .catch(() => undefined);
  }
  return {
    jobId,
    messageId,
    scheduledAt: resolved.instant.toISOString(),
  };
}

async function resolveScheduledAt(
  raw: string,
  clock: Clock,
): Promise<{ instant: Date; availableAtText: string }> {
  try {
    return resolveScheduleInstant(raw, clock());
  } catch {
    throw new McpToolError(
      "invalid_args",
      `scheduled_at must be within ${SCHEDULE_MIN_LEAD_SECONDS}s to ${SCHEDULE_MAX_LEAD_SECONDS}s from now`,
    );
  }
}

export function scheduleMessageTool(
  ctx: McpToolContext,
  deps: ScheduleDependencies = {},
): WriteToolDef {
  const clock: Clock = deps.clock ?? systemClock;
  return {
    name: "schedule_message",
    description:
      "Schedule an email for future delivery (≥90s, ≤30d from now). " +
      "Two-stage confirmation mirrors send_message. Returns a job_id whose status can later be revoked via cancel_scheduled.",
    inputSchema: scheduleMessageJsonSchema,
    handler: async (rawArgs) => {
      const parsed = ScheduleMessageInputSchema.safeParse(rawArgs);
      if (!parsed.success) throw invalidArgs(parsed.error);
      const input = parsed.data;
      const sender = await requireActiveMailbox(
        ctx,
        ctx.principal.userId,
        input.mailbox_id,
      );
      // Validate the schedule window eagerly so a malformed instant produces
      // `invalid_args` instead of being cached behind a confirmation token.
      const resolved = await resolveScheduledAt(input.scheduled_at, clock);
      const payload = {
        mailbox_id: input.mailbox_id,
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        subject: input.subject,
        text_body: input.text_body,
        html_body: input.html_body ?? "",
        attachments: input.attachments,
        scheduled_at: resolved.instant.toISOString(),
      };
      const flow = await wrapWithConfirmation(
        ctx.modules,
        ctx.principal,
        input,
        () => payload,
        () =>
          idempotencyForMcp(
            ctx.modules,
            ctx.principal,
            input.idempotency_key,
            payload,
            async () => writeScheduledJob(ctx, { sender, input, resolved }),
          ),
      );
      const structuredContent: Record<string, unknown> = { ...flow };
      return {
        content: [{ type: "text", text: JSON.stringify(flow) }],
        structuredContent,
      };
    },
  };
}

interface CancelDeps {
  // Reserved for future test-only deps; intentionally empty for PR #5.
  _reserved?: never;
}

async function loadOwnedJob(
  ctx: McpToolContext,
  userId: string,
  jobId: string,
): Promise<JobOwnershipRow> {
  const row = await ctx.env.DB.prepare(
    `SELECT oj.id, oj.message_id, m.created_by_user_id
     FROM outbound_jobs oj
     JOIN messages m ON m.id = oj.message_id
     WHERE oj.id = ?`,
  )
    .bind(jobId)
    .first<JobOwnershipRow>();
  if (!row) {
    throw new McpToolError("not_found", "Scheduled job not found");
  }
  if (row.created_by_user_id !== userId) {
    throw new McpToolError(
      "forbidden",
      "Scheduled job is not owned by the principal",
    );
  }
  return row;
}

export function cancelScheduledTool(
  ctx: McpToolContext,
  _deps: CancelDeps = {},
): WriteToolDef {
  return {
    name: "cancel_scheduled",
    description:
      "Cancel a previously scheduled send. Idempotent: re-cancelling the same job returns its current status without erroring.",
    inputSchema: cancelScheduledJsonSchema,
    handler: async (rawArgs) => {
      const parsed = CancelScheduledInputSchema.safeParse(rawArgs);
      if (!parsed.success) throw invalidArgs(parsed.error);
      const input = parsed.data;
      const job = await loadOwnedJob(ctx, ctx.principal.userId, input.job_id);
      const result = await idempotencyForMcp(
        ctx.modules,
        ctx.principal,
        input.idempotency_key,
        { job_id: input.job_id },
        async () => {
          const deleted = await ctx.env.DB.prepare(
            `DELETE FROM outbound_jobs
             WHERE id = ? AND status IN ('pending', 'enqueued')`,
          )
            .bind(job.id)
            .run();
          // 0 changes means the dispatcher has already promoted the row
          // past `enqueued`. Report the new status verbatim so the agent
          // can tell "still pending" from "already dispatched" without
          // having to re-query.
          let status:
            | "cancelled"
            | "enqueued"
            | "processing"
            | "succeeded"
            | "failed";
          if (deleted.meta.changes === 1) {
            status = "cancelled";
          } else {
            const current = await ctx.env.DB.prepare(
              `SELECT status FROM outbound_jobs WHERE id = ?`,
            )
              .bind(job.id)
              .first<{ status: string }>();
            if (!current) {
              // A concurrent dispatcher removed the row entirely. Treat as
              // a terminal cancellation so the agent's UX is symmetric.
              status = "cancelled";
            } else if (
              current.status === "pending" ||
              current.status === "enqueued"
            ) {
              status = "enqueued";
            } else if (
              current.status === "succeeded" ||
              current.status === "failed" ||
              current.status === "processing"
            ) {
              status = current.status;
            } else {
              status = "cancelled";
            }
          }
          return { job_id: job.id, status };
        },
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: { ...result },
      };
    },
  };
}
