import type { Ctx } from "../context";
import { newId, nowIso } from "../lib/util";

export type EntityType = "board" | "column" | "card" | "comment" | "token";

export interface EventInput {
  entityType: EntityType;
  entityId: string;
  boardId?: string | null;
  cardId?: string | null;
  action: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  reason?: string | null;
  /** Override review: e.g. token management and reviews themselves never need sign-off. */
  reviewable?: boolean;
  revertOf?: string | null;
}

/** Fields that never count as a meaningful change. */
const NOISE = new Set(["updated_at", "version", "updated_by", "pending_reviews", "comment_count"]);

export function diffKeys(before: Record<string, unknown> | null | undefined, after: Record<string, unknown> | null | undefined): string[] {
  if (!before || !after) return [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out: string[] = [];
  for (const k of keys) {
    if (NOISE.has(k)) continue;
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) out.push(k);
  }
  return out;
}

/**
 * Builds the INSERT for one history event. Callers batch it together with the
 * entity write so the change and its history entry commit atomically.
 *
 * When `guardChanges` is true the insert only happens if the immediately
 * preceding statement in the batch changed a row (used for optimistic
 * concurrency: no row updated ⇒ no event recorded).
 */
export function eventStatement(ctx: Ctx, e: EventInput, guardChanges = false): { id: string; stmt: D1PreparedStatement; reviewStatus: string } {
  const id = newId("evt");
  const reviewStatus = e.reviewable !== false && ctx.actor.requiresReview ? "pending" : "none";
  const changes = e.action === "update" || e.action === "move" ? diffKeys(e.before, e.after) : [];
  const cols = `(id, created_at, actor_id, actor_name, actor_kind, via, client, session_id, reason, entity_type, entity_id, board_id, card_id, action, before, after, changes, review_status, revert_of)`;
  const values = [
    id,
    nowIso(),
    ctx.actor.id,
    ctx.actor.name,
    ctx.actor.kind,
    ctx.via,
    ctx.client,
    ctx.sessionId,
    e.reason ?? null,
    e.entityType,
    e.entityId,
    e.boardId ?? null,
    e.cardId ?? null,
    e.action,
    e.before ? JSON.stringify(e.before) : null,
    e.after ? JSON.stringify(e.after) : null,
    JSON.stringify(changes),
    reviewStatus,
    e.revertOf ?? null,
  ];
  const placeholders = values.map(() => "?").join(", ");
  const sql = guardChanges
    ? `INSERT INTO events ${cols} SELECT ${placeholders} WHERE changes() > 0`
    : `INSERT INTO events ${cols} VALUES (${placeholders})`;
  return { id, stmt: ctx.db.prepare(sql).bind(...values), reviewStatus };
}
