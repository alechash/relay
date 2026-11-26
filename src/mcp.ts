import { authenticate } from "./auth";
import type { Ctx } from "./context";
import type { Env } from "./env";
import { ApiError } from "./lib/errors";
import { base64url, base64urlDecode, randomToken } from "./lib/util";
import { operations, operationsByName } from "./ops";
import { canAccess, jsonSchema, runOperation } from "./ops/run";

/**
 * Stateless MCP server over Streamable HTTP (JSON responses, no SSE).
 * Every tool is generated from the same operation registry as the REST API,
 * so MCP and REST always have identical capabilities.
 */

const SUPPORTED = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const VERSION = "0.1.0";

const INSTRUCTIONS = `Relay is the user's personal task tracker: boards contain ordered columns, columns contain ordered cards.
- Cards can be referenced by id (crd_…) or by number ("#42" or "42").
- Start with list_boards / get_board to see the layout, list_cards to search.
- Always pass a short "reason" on every change: it is stored in the history and shown to the user when they sign off.
- If get_me says requires_review=true, your changes are applied immediately but queued for the user's sign-off; they may reject and revert them.
- Prefer move_card to change status, add_comment to log progress or findings on a task, and update_card for edits.
- Nothing is ever hard-deleted: archive with update_card {archived: true}. Every change is in get_card_history / list_events.`;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: any;
}

const rpcResult = (id: any, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: any, code: number, message: string, data?: unknown) => ({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } });

function encodeSession(clientInfo: any): string {
  const name = typeof clientInfo?.name === "string" ? clientInfo.name.slice(0, 60) : "mcp-client";
  const version = typeof clientInfo?.version === "string" ? clientInfo.version.slice(0, 30) : "";
  const label = version ? `${name}/${version}` : name;
  return `mcp_${randomToken(9)}.${base64url(new TextEncoder().encode(label))}`;
}

function decodeSession(header: string | null): { sessionId: string | null; client: string | null } {
  if (!header) return { sessionId: null, client: null };
  const [id, enc] = header.split(".");
  let client: string | null = null;
  try {
    client = enc ? new TextDecoder().decode(base64urlDecode(enc)).slice(0, 100) : null;
  } catch {
    client = null;
  }
  return { sessionId: id?.slice(0, 64) || null, client };
}

function toolList(ctx: Ctx) {
  return operations
    .filter((op) => canAccess(ctx, op))
    .map((op) => ({
      name: op.name,
      title: op.summary,
      description: [op.summary + ".", op.description, op.access === "write" && ctx.actor.requiresReview ? "(Your changes are queued for the user's sign-off.)" : ""]
        .filter(Boolean)
        .join(" "),
      inputSchema: jsonSchema(op.input),
      annotations: {
        title: op.summary,
        readOnlyHint: op.method === "GET",
        destructiveHint: op.name === "revoke_token" || op.name === "reject_changes" || op.name === "revert_event",
        idempotentHint: op.method === "GET",
        openWorldHint: false,
      },
    }));
}

async function handleMessage(ctx: Ctx, msg: JsonRpcRequest, newSession: { value: string | null }): Promise<object | null> {
  const isNotification = msg.id === undefined || msg.id === null;
  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return isNotification ? null : rpcError(msg.id ?? null, -32600, "Invalid Request");
  }
  switch (msg.method) {
    case "initialize": {
      const requested = msg.params?.protocolVersion;
      const protocolVersion = SUPPORTED.includes(requested) ? requested : SUPPORTED[0];
      if (!ctx.sessionId) {
        newSession.value = encodeSession(msg.params?.clientInfo);
        const decoded = decodeSession(newSession.value);
        ctx.sessionId = decoded.sessionId;
        ctx.client = decoded.client;
      }
      return rpcResult(msg.id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "relay", title: "Relay task tracker", version: VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return isNotification ? null : rpcResult(msg.id, {});
    case "tools/list":
      return rpcResult(msg.id, { tools: toolList(ctx) });
    case "tools/call": {
      const name = msg.params?.name;
      const op = typeof name === "string" ? operationsByName.get(name) : undefined;
      if (!op) return rpcError(msg.id, -32602, `Unknown tool: ${name}`);
      try {
        const result = await runOperation(ctx, op, msg.params?.arguments ?? {});
        const structured = result && typeof result === "object" && !Array.isArray(result) ? result : { result };
        return rpcResult(msg.id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: structured, isError: false });
      } catch (err) {
        const e = err instanceof ApiError ? err : null;
        if (!e) console.error("MCP tool error", err);
        const text = e ? `${e.code}: ${e.message}` : "internal_error: unexpected failure";
        return rpcResult(msg.id, { content: [{ type: "text", text }], isError: true });
      }
    }
    case "resources/list":
      return rpcResult(msg.id, { resources: [] });
    case "resources/templates/list":
      return rpcResult(msg.id, { resourceTemplates: [] });
    case "prompts/list":
      return rpcResult(msg.id, { prompts: [] });
    default:
      if (msg.method.startsWith("notifications/")) return null;
      return isNotification ? null : rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

export async function handleMcp(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "Mcp-Session-Id" };
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { ...cors, "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS", "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version" },
    });
  }
  if (req.method === "DELETE") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { ...cors, Allow: "POST, DELETE, OPTIONS" } });

  let auth;
  try {
    auth = await authenticate(req, env, env.DB, (p) => exec.waitUntil(p));
  } catch (err) {
    const e = err instanceof ApiError ? err : new ApiError("unauthorized", "Unauthorized");
    return new Response(JSON.stringify(rpcError(null, -32001, e.message)), {
      status: e.status,
      headers: { ...cors, "Content-Type": "application/json", "WWW-Authenticate": 'Bearer realm="relay"' },
    });
  }
  if (auth.cookie) {
    // MCP is for programmatic clients; refuse ambient browser cookies.
    return new Response(JSON.stringify(rpcError(null, -32001, "Use Authorization: Bearer <token> for MCP")), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify(rpcError(null, -32700, "Parse error")), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
  }

  const { sessionId, client } = decodeSession(req.headers.get("Mcp-Session-Id"));
  const ctx: Ctx = {
    env,
    db: env.DB,
    actor: auth.actor,
    via: "mcp",
    client,
    sessionId,
    waitUntil: (p) => exec.waitUntil(p),
    requestId: req.headers.get("cf-ray") ?? crypto.randomUUID(),
  };
  const newSession = { value: null as string | null };

  const messages = Array.isArray(body) ? body : [body];
  const responses: object[] = [];
  for (const m of messages) {
    const r = await handleMessage(ctx, m as JsonRpcRequest, newSession);
    if (r) responses.push(r);
  }
  const headers: Record<string, string> = { ...cors, "Content-Type": "application/json" };
  if (newSession.value) headers["Mcp-Session-Id"] = newSession.value;
  if (responses.length === 0) return new Response(null, { status: 202, headers });
  return new Response(JSON.stringify(Array.isArray(body) ? responses : responses[0]), { status: 200, headers });
}
