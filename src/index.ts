import { adminStatus } from "./auth";
import { ensureSchema } from "./db";
import type { Env } from "./env";
import { renderDocs } from "./docs";
import { handleMcp } from "./mcp";
import { API_PREFIX, errorResponse, handleApi, json } from "./rest";
import { buildOpenApi } from "./openapi";
import { handleHook, runScheduled } from "./core/webhooks";

export default {
  async fetch(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === "/healthz") {
      try {
        await ensureSchema(env.DB);
        const status = await adminStatus(env, env.DB);
        return json({ ok: true, configured: status === "env" || status === "database", admin_token: status });
      } catch (err) {
        return json({ ok: false, error: String(err) }, 500);
      }
    }
    if (p === "/docs") return new Response(renderDocs(url.origin), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    if (p === "/openapi.json") return json(buildOpenApi(url.origin));

    const hook = /^\/hooks\/([A-Za-z0-9_]+)\/?$/.exec(p);
    if (hook) {
      try {
        await ensureSchema(env.DB);
        return await handleHook(req, env, exec, hook[1]);
      } catch (err) {
        return errorResponse(err);
      }
    }

    if (p === API_PREFIX || p.startsWith(API_PREFIX + "/") || p === "/mcp" || p.startsWith("/mcp/")) {
      try {
        await ensureSchema(env.DB);
      } catch (err) {
        return errorResponse(err);
      }
      return p.startsWith("/mcp") ? handleMcp(req, env, exec) : handleApi(req, env, exec);
    }

    return env.ASSETS.fetch(req);
  },

  /** Cron (every minute): retry outbound webhook deliveries and prune old bookkeeping. */
  async scheduled(_event: ScheduledController, env: Env, exec: ExecutionContext): Promise<void> {
    await ensureSchema(env.DB);
    exec.waitUntil(runScheduled(env));
  },
} satisfies ExportedHandler<Env>;
