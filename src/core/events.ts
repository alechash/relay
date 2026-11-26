import type { AutoApproveAction, Ctx } from "../context";
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
/** Maps an event to the policy action kind that can auto-approve it. */
function policyActionsFor(e: EventInput): AutoApproveAction[] {
  if (e.entityType === "comment") return ["comment"];
  if (e.entityType === "board" || e.entityType === "column") return ["structure"];
  if (e.entityType !== "card") return [];
  if (e.action === "create") return ["create"];
  if (e.action === "archive" || e.action === "restore") return ["archive"];
  if (e.action === "move") {
    const completing = !(e.before as any)?.completed_at && !!(e.after as any)?.completed_at;
    return completing ? ["move", "complete"] : ["move"];
  }
  return ["update"];
}

/**
 * Decides whether a change by an actor that normally needs sign-off is auto-approved, and by what.
 * The approval is recorded on the event itself, so every bypass stays visible and attributable.
 */
function autoApproval(ctx: Ctx, e: EventInput): { by: string; byName: string; note: string } | null {
  if (ctx.skipReview) {
    return { by: "policy:skip_review", byName: "skip_review", note: `Auto-approved: ${ctx.actor.name} passed skip_review (token permission)` };
  }
  const policy = e.boardId ? ctx.autoApprove?.get(e.boardId) : undefined;
  if (!policy?.length) return null;
  const kinds = policyActionsFor(e);
  const hit = policy.includes("all") ? "all" : kinds.find((k) => policy.includes(k));
  if (!hit) return null;
  return { by: "policy:board", byName: "Board policy", note: `Auto-approved by board policy (${hit})` };
}

export function eventStatement(ctx: Ctx, e: EventInput, guardChanges = false): { id: string; stmt: D1PreparedStatement; reviewStatus: string } {
  const id = newId("evt");
  const needsReview = e.reviewable !== false && ctx.actor.requiresReview;
  const auto = needsReview ? autoApproval(ctx, e) : null;
  const reviewStatus = needsReview ? (auto ? "approved" : "pending") : "none";
  const now = nowIso();
  const changes = e.action === "update" || e.action === "move" ? diffKeys(e.before, e.after) : [];
  const cols = `(id, created_at, actor_id, actor_name, actor_kind, via, client, session_id, reason, entity_type, entity_id, board_id, card_id, action, before, after, changes, review_status, revert_of, reviewed_at, reviewed_by_id, reviewed_by_name, review_note, request_id)`;
  const values = [
    id,
    now,
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
    auto ? now : null,
    auto?.by ?? null,
    auto?.byName ?? null,
    auto?.note ?? null,
    ctx.requestId ?? null,
  ];
  const placeholders = values.map(() => "?").join(", ");
  const sql = guardChanges
    ? `INSERT INTO events ${cols} SELECT ${placeholders} WHERE changes() > 0`
    : `INSERT INTO events ${cols} VALUES (${placeholders})`;
  return { id, stmt: ctx.db.prepare(sql).bind(...values), reviewStatus };
}
