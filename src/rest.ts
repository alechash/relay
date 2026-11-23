import { authenticate, checkAdminToken, clearSessionCookie, createSessionCookie } from "./auth";
import type { Ctx } from "./context";
import type { Env } from "./env";
import { ApiError } from "./lib/errors";
import { operations } from "./ops";
import type { Operation } from "./ops/registry";
import { baseType, pathParams, runOperation } from "./ops/run";
import { buildOpenApi } from "./openapi";

export const API_PREFIX = "/api/v1";

interface Route {
  op: Operation;
  regex: RegExp;
  params: string[];
}

const routes: Route[] = operations.map((op) => ({
  op,
  params: pathParams(op.path),
  regex: new RegExp("^" + op.path.replace(/\{(\w+)\}/g, "([^/]+)") + "/?$"),
}));

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) return json(err.toJSON(), err.status);
  console.error("Unhandled error", err);
  return json(new ApiError("internal_error", "Internal error").toJSON(), 500);
}

/** Query strings are untyped; coerce them using the operation's schema so the same schema serves JSON bodies and MCP. */
function coerceQuery(op: Operation, query: URLSearchParams): Record<string, unknown> {
  const shape = op.input.shape as Record<string, any>;
  const out: Record<string, unknown> = {};
  for (const key of new Set(query.keys())) {
    const field = shape[key];
    const values = query.getAll(key);
    const raw = values[values.length - 1];
    if (!field) {
      out[key] = raw;
      continue;
    }
    const { type } = baseType(field);
    if (type === "number") out[key] = raw === "" ? undefined : Number(raw);
    else if (type === "boolean") out[key] = raw === "" || raw === "true" || raw === "1" ? true : raw === "false" || raw === "0" ? false : raw;
    else if (type === "array") out[key] = values.flatMap((v) => v.split(",")).filter(Boolean);
    else if (raw === "null" && field.safeParse(null).success) out[key] = null;
    else out[key] = raw;
  }
  return out;
}

export async function handleApi(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.slice(API_PREFIX.length) || "/";
  const secure = url.protocol === "https:";
  try {
    // ---- session endpoints for the built-in web UI (not part of the operation registry)
    if (path === "/auth/login" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { token?: string };
      if (!body.token || !(await checkAdminToken(env, body.token))) {
        await new Promise((r) => setTimeout(r, 400)); // slow down guessing
        throw new ApiError("unauthorized", "Wrong admin token");
      }
      return json({ ok: true }, 200, { "Set-Cookie": await createSessionCookie(env, secure) });
    }
    if (path === "/auth/logout" && req.method === "POST") {
      return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie(secure) });
    }
    if (path === "/openapi.json" && req.method === "GET") {
      return json(buildOpenApi(url.origin));
    }

    const route = routes.find((r) => r.op.method === req.method && r.regex.test(path));
    if (!route) {
      const anyMethod = routes.some((r) => r.regex.test(path));
      throw new ApiError(anyMethod ? "bad_request" : "not_found", anyMethod ? `Method ${req.method} not allowed on ${path}` : `No route ${req.method} ${path}`);
    }

    const auth = await authenticate(req, env, env.DB, (p) => exec.waitUntil(p));
    if (auth.cookie && req.method !== "GET" && !req.headers.get("X-Relay-Client")) {
      throw new ApiError("forbidden", "Cookie-authenticated writes must send an X-Relay-Client header");
    }

    const m = route.regex.exec(path)!;
    const params: Record<string, string> = {};
    route.params.forEach((p, i) => (params[p] = decodeURIComponent(m[i + 1])));

    let body: Record<string, unknown> = {};
    if (req.method !== "GET" && req.method !== "DELETE") {
      const text = await req.text();
      if (text.trim()) {
        try {
          body = JSON.parse(text);
        } catch {
          throw new ApiError("bad_request", "Request body must be valid JSON");
        }
        if (typeof body !== "object" || body === null || Array.isArray(body)) throw new ApiError("bad_request", "Request body must be a JSON object");
      }
    }
    const input = { ...coerceQuery(route.op, url.searchParams), ...body, ...params };

    const ctx: Ctx = {
      env,
      db: env.DB,
      actor: auth.actor,
      via: auth.cookie ? "web" : "api",
      client: req.headers.get("X-Relay-Client")?.slice(0, 200) ?? null,
      sessionId: req.headers.get("X-Relay-Session")?.slice(0, 200) ?? null,
      waitUntil: (p) => exec.waitUntil(p),
    };
    const result = await runOperation(ctx, route.op, input);
    return json(result, route.op.status ?? 200);
  } catch (err) {
    return errorResponse(err);
  }
}
