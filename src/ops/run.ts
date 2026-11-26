import { z } from "zod";
import { isHuman, type Ctx } from "../context";
import { ApiError } from "../lib/errors";
import type { Operation } from "./registry";

export function canAccess(ctx: Ctx, op: Operation): boolean {
  if (op.access === "read") return true;
  if (op.access === "write") return ctx.actor.scope === "write";
  return isHuman(ctx.actor) && (op.method === "GET" || ctx.actor.scope === "write");
}

/** Single entry point used by REST, MCP and the web UI (via REST): validate, authorize, execute. */
export async function runOperation(ctx: Ctx, op: Operation, raw: unknown): Promise<unknown> {
  if (!canAccess(ctx, op)) {
    if (op.access === "human") throw new ApiError("forbidden", `${op.name} can only be performed by a human (owner session, ADMIN_TOKEN or a human token)`);
    throw new ApiError("forbidden", `${op.name} requires a token with write scope`);
  }
  const parsed = op.input.safeParse(raw ?? {});
  ctx.skipReview = false; // per call: an MCP batch can carry several calls on one context
  if (parsed.success && (parsed.data as any).skip_review === true) {
    // Never silently honour a bypass: either the token was granted it, or the call fails.
    if (ctx.actor.requiresReview && !ctx.actor.canSkipReview) {
      throw new ApiError("forbidden", "skip_review is not allowed for this token. A human can grant it in Settings → Tokens (can_skip_review).");
    }
    ctx.skipReview = ctx.actor.requiresReview;
  }
  if (op.access === "write" && ctx.actor.requiresReview && !ctx.autoApprove) {
    const { results } = await ctx.db.prepare(`SELECT id, agent_auto_approve FROM boards WHERE agent_auto_approve != '[]'`).all<any>();
    ctx.autoApprove = new Map(results.map((r) => [r.id as string, JSON.parse(r.agent_auto_approve)]));
  }
  if (!parsed.success) {
    throw new ApiError(
      "validation_error",
      "Invalid input: " + parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
      { issues: z.treeifyError(parsed.error) },
    );
  }
  return op.handler(ctx, parsed.data);
}

// ---------- schema helpers shared by REST query coercion and OpenAPI ----------

/** Peels optional/nullable/default wrappers and returns the base zod type name. */
export function baseType(schema: z.ZodType): { type: string; schema: z.ZodType } {
  let s: any = schema;
  for (let i = 0; i < 10; i++) {
    const t = s?._zod?.def?.type;
    if ((t === "optional" || t === "nullable" || t === "default" || t === "readonly") && s._zod.def.innerType) {
      s = s._zod.def.innerType;
      continue;
    }
    return { type: t, schema: s };
  }
  return { type: "unknown", schema: s };
}

export function pathParams(path: string): string[] {
  return [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
}

export function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const out = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete out.$schema;
  return out;
}
