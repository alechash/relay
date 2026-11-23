import { adminTokenProblem } from "./auth";
import { ensureSchema } from "./db";
import type { Env } from "./env";
import { renderDocs } from "./docs";
import { handleMcp } from "./mcp";
import { API_PREFIX, errorResponse, handleApi, json } from "./rest";
import { buildOpenApi } from "./openapi";

export default {
  async fetch(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === "/healthz") {
      const problem = adminTokenProblem(env);
      return json({ ok: true, configured: problem === null, admin_token: problem ?? "ok", database: !!env.DB });
    }
    if (p === "/docs") return new Response(renderDocs(url.origin), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    if (p === "/openapi.json") return json(buildOpenApi(url.origin));

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
} satisfies ExportedHandler<Env>;
