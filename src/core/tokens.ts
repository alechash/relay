import type { Ctx } from "../context";
import { notFound } from "../lib/errors";
import { newId, nowIso, randomToken, sha256Hex } from "../lib/util";
import { eventStatement } from "./events";
import { tokenOut } from "./serialize";

export const TOKEN_PREFIX = "rly_";

export async function listTokens(ctx: Ctx, input: { include_revoked?: boolean }) {
  const { results } = await ctx.db
    .prepare(`SELECT * FROM tokens ${input.include_revoked ? "" : "WHERE revoked_at IS NULL"} ORDER BY created_at DESC`)
    .all();
  return { tokens: results.map(tokenOut) };
}

export async function createToken(
  ctx: Ctx,
  input: { name: string; kind: "agent" | "human"; scope?: "read" | "write"; requires_review?: boolean },
) {
  const secret = TOKEN_PREFIX + randomToken(24);
  const row = {
    id: newId("tok"),
    name: input.name,
    kind: input.kind,
    scope: input.scope ?? "write",
    requires_review: (input.requires_review ?? input.kind === "agent") ? 1 : 0,
    token_hash: await sha256Hex(secret),
    token_prefix: secret.slice(0, TOKEN_PREFIX.length + 6),
    created_at: nowIso(),
    last_used_at: null,
    revoked_at: null,
  };
  await ctx.db.batch([
    ctx.db
      .prepare(`INSERT INTO tokens (id, name, kind, scope, requires_review, token_hash, token_prefix, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(row.id, row.name, row.kind, row.scope, row.requires_review, row.token_hash, row.token_prefix, row.created_at),
    eventStatement(ctx, { entityType: "token", entityId: row.id, action: "create", after: tokenOut(row), reviewable: false }).stmt,
  ]);
  return { ...tokenOut(row), token: secret };
}

export async function updateToken(ctx: Ctx, input: { token_id: string; name?: string; requires_review?: boolean; scope?: "read" | "write" }) {
  const row: any = await ctx.db.prepare(`SELECT * FROM tokens WHERE id = ?`).bind(input.token_id).first();
  if (!row) throw notFound("Token", input.token_id);
  const next = { ...row };
  if (input.name !== undefined) next.name = input.name;
  if (input.requires_review !== undefined) next.requires_review = input.requires_review ? 1 : 0;
  if (input.scope !== undefined) next.scope = input.scope;
  await ctx.db.batch([
    ctx.db.prepare(`UPDATE tokens SET name = ?, requires_review = ?, scope = ? WHERE id = ?`).bind(next.name, next.requires_review, next.scope, row.id),
    eventStatement(ctx, { entityType: "token", entityId: row.id, action: "update", before: tokenOut(row), after: tokenOut(next), reviewable: false }).stmt,
  ]);
  return tokenOut(next);
}

export async function revokeToken(ctx: Ctx, input: { token_id: string }) {
  const row: any = await ctx.db.prepare(`SELECT * FROM tokens WHERE id = ?`).bind(input.token_id).first();
  if (!row) throw notFound("Token", input.token_id);
  if (row.revoked_at) return tokenOut(row);
  const now = nowIso();
  await ctx.db.batch([
    ctx.db.prepare(`UPDATE tokens SET revoked_at = ? WHERE id = ?`).bind(now, row.id),
    eventStatement(ctx, { entityType: "token", entityId: row.id, action: "revoke", before: tokenOut(row), after: tokenOut({ ...row, revoked_at: now }), reviewable: false }).stmt,
  ]);
  return tokenOut({ ...row, revoked_at: now });
}
