import { parseJson } from "../lib/util";

export interface ActorRef {
  id: string;
  name: string;
  kind: string;
}

export function boardOut(r: any) {
  return {
    id: r.id as string,
    name: r.name as string,
    description: r.description as string,
    position: r.position as number,
    agent_auto_approve: parseJson<string[]>(r.agent_auto_approve, []),
    archived: r.archived_at != null,
    archived_at: (r.archived_at as string | null) ?? null,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
    version: r.version as number,
  };
}
export type Board = ReturnType<typeof boardOut>;

export function columnOut(r: any) {
  return {
    id: r.id as string,
    board_id: r.board_id as string,
    name: r.name as string,
    wip_limit: (r.wip_limit as number | null) ?? null,
    is_done: !!r.is_done,
    position: r.position as number,
    archived: r.archived_at != null,
    archived_at: (r.archived_at as string | null) ?? null,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
    version: r.version as number,
  };
}
export type Column = ReturnType<typeof columnOut>;

export function cardOut(r: any) {
  return {
    id: r.id as string,
    number: r.number as number,
    ref: `#${r.number}`,
    board_id: r.board_id as string,
    column_id: r.column_id as string,
    title: r.title as string,
    description: r.description as string,
    labels: parseJson<string[]>(r.labels, []),
    priority: r.priority as string,
    assignee: (r.assignee as string | null) ?? null,
    due_on: (r.due_on as string | null) ?? null,
    position: r.position as number,
    archived: r.archived_at != null,
    archived_at: (r.archived_at as string | null) ?? null,
    completed_at: (r.completed_at as string | null) ?? null,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
    created_by: { id: r.created_by_id, name: r.created_by_name, kind: r.created_by_kind } as ActorRef,
    updated_by: { id: r.updated_by_id, name: r.updated_by_name, kind: r.updated_by_kind } as ActorRef,
    version: r.version as number,
    ...(r.pending_reviews !== undefined ? { pending_reviews: r.pending_reviews as number } : {}),
    ...(r.comment_count !== undefined ? { comment_count: r.comment_count as number } : {}),
  };
}
export type Card = ReturnType<typeof cardOut>;

export function commentOut(r: any) {
  return {
    id: r.id as string,
    card_id: r.card_id as string,
    body: r.body as string,
    author: { id: r.author_id, name: r.author_name, kind: r.author_kind } as ActorRef,
    created_at: r.created_at as string,
    deleted: r.deleted_at != null,
  };
}

export function eventOut(r: any) {
  return {
    id: r.id as string,
    seq: r.seq as number,
    created_at: r.created_at as string,
    actor: { id: r.actor_id, name: r.actor_name, kind: r.actor_kind } as ActorRef,
    via: r.via as string,
    client: (r.client as string | null) ?? null,
    session_id: (r.session_id as string | null) ?? null,
    reason: (r.reason as string | null) ?? null,
    entity_type: r.entity_type as string,
    entity_id: r.entity_id as string,
    board_id: (r.board_id as string | null) ?? null,
    card_id: (r.card_id as string | null) ?? null,
    action: r.action as string,
    changes: parseJson<string[]>(r.changes, []),
    before: parseJson<Record<string, unknown> | null>(r.before, null),
    after: parseJson<Record<string, unknown> | null>(r.after, null),
    review: {
      status: r.review_status as "none" | "pending" | "approved" | "rejected",
      reviewed_at: (r.reviewed_at as string | null) ?? null,
      reviewed_by: r.reviewed_by_id
        ? ({ id: r.reviewed_by_id, name: r.reviewed_by_name, kind: String(r.reviewed_by_id).startsWith("policy:") ? "policy" : "human" } as ActorRef)
        : null,
      auto_approved: String(r.reviewed_by_id ?? "").startsWith("policy:"),
      note: (r.review_note as string | null) ?? null,
    },
    request_id: (r.request_id as string | null) ?? null,
    reverted_by: (r.reverted_by as string | null) ?? null,
    revert_of: (r.revert_of as string | null) ?? null,
  };
}
export type Event = ReturnType<typeof eventOut>;

export function tokenOut(r: any) {
  return {
    id: r.id as string,
    name: r.name as string,
    kind: r.kind as "human" | "agent",
    scope: r.scope as "read" | "write",
    requires_review: !!r.requires_review,
    can_skip_review: !!r.can_skip_review,
    prefix: r.token_prefix as string,
    created_at: r.created_at as string,
    last_used_at: (r.last_used_at as string | null) ?? null,
    revoked: r.revoked_at != null,
    revoked_at: (r.revoked_at as string | null) ?? null,
  };
}
