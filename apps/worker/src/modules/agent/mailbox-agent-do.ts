import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../platform/config";

/**
 * Per-mailbox agent state and hibernating WebSocket endpoint.
 *
 * MCP resources/subscribe is acknowledgement-only in v1. Full subscription
 * registration and WebSocket fanout will land in a follow-up; schedule
 * notifications are retained as in-memory pending actions here.
 */
export class MailboxAgent extends DurableObject<Env> {
  conversations = new Map<
    string,
    Array<{ role: "user" | "assistant"; text: string }>
  >();
  pendingActions: PendingAction[] = [];
  subscriptions = new Set<WebSocket>();

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      this.subscriptions.add(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname.endsWith("/schedule")) {
      const body = (await req.json()) as {
        job_id?: unknown;
        scheduled_at?: unknown;
      };
      if (
        typeof body.job_id === "string" &&
        typeof body.scheduled_at === "string"
      ) {
        this.pendingActions.push({
          id: body.job_id,
          kind: "schedule",
          payload: { job_id: body.job_id, scheduled_at: body.scheduled_at },
          created_at: Date.now(),
        });
        return Response.json({ ok: true });
      }
      return Response.json({ ok: false }, { status: 400 });
    }
    if (url.pathname.endsWith("/conversations")) {
      return Response.json(Array.from(this.conversations.entries()));
    }
    if (url.pathname.endsWith("/pending")) {
      return Response.json(this.pendingActions);
    }
    return new Response("not found", { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, _message: string | ArrayBuffer) {
    ws.send(JSON.stringify({ ack: true }));
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ) {
    this.subscriptions.delete(ws);
    try {
      ws.close(code, reason);
    } catch {
      // The peer may already have closed the socket.
    }
  }

  async webSocketError(ws: WebSocket, _error: unknown) {
    this.subscriptions.delete(ws);
  }

  broadcast(event: { type: string; data: unknown }) {
    const payload = JSON.stringify(event);
    for (const ws of this.subscriptions) {
      try {
        ws.send(payload);
      } catch {
        this.subscriptions.delete(ws);
      }
    }
  }
}

interface PendingAction {
  id: string;
  kind: "schedule" | "reply";
  payload: Record<string, unknown>;
  created_at: number;
}
