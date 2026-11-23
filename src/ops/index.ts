import { z } from "zod";
import { isHuman } from "../context";
import { createBoard, getBoard, listBoards, updateBoard } from "../core/boards";
import {
  addComment,
  cardHistory,
  createCard,
  deleteComment,
  getCard,
  listCards,
  listComments,
  moveCard,
  PRIORITIES,
  updateCard,
} from "../core/cards";
import { createColumn, updateColumn } from "../core/columns";
import { approveChanges, getEvent, listEvents, listReviews, rejectChanges, revertEvent } from "../core/history";
import { createToken, listTokens, revokeToken, updateToken } from "../core/tokens";
import { SCHEMA_VERSION } from "../db";
import { cardRef, expectedVersion, op, reason, type Operation } from "./registry";

const priority = z.enum(PRIORITIES).describe("none | low | medium | high | urgent");
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .describe("Date as YYYY-MM-DD");
const labels = z.array(z.string().min(1).max(64)).max(50);
const index = z.number().int().min(0).describe("0-based index within the parent (column for cards, board for columns). Omit to append at the end.");

export const operations: Operation[] = [
  // ------------------------------------------------------------------ meta
  op({
    name: "get_me",
    method: "GET",
    path: "/me",
    tag: "Meta",
    summary: "Who am I",
    description: "Returns the authenticated actor (owner, human token, or agent token) and whether their changes require sign-off.",
    access: "read",
    input: z.object({}),
    handler: async (ctx) => ({
      actor: { id: ctx.actor.id, name: ctx.actor.name, kind: ctx.actor.kind },
      scope: ctx.actor.scope,
      requires_review: ctx.actor.requiresReview,
      can_review: isHuman(ctx.actor),
      via: ctx.via,
      session_id: ctx.sessionId,
      schema_version: SCHEMA_VERSION,
    }),
  }),

  // ------------------------------------------------------------------ boards
  op({
    name: "list_boards",
    method: "GET",
    path: "/boards",
    tag: "Boards",
    summary: "List boards",
    access: "read",
    input: z.object({ include_archived: z.boolean().optional() }),
    handler: async (ctx, i) => ({ boards: await listBoards(ctx, i) }),
  }),
  op({
    name: "create_board",
    method: "POST",
    path: "/boards",
    tag: "Boards",
    summary: "Create a board",
    description: "Creates a board. Without `columns`, it gets Backlog / To do / Doing / Done (Done marked as the completion column).",
    access: "write",
    status: 201,
    input: z.object({
      name: z.string().min(1).max(200),
      description: z.string().max(10000).optional(),
      columns: z
        .array(
          z.union([
            z.string().min(1).max(100),
            z.object({ name: z.string().min(1).max(100), is_done: z.boolean().optional(), wip_limit: z.number().int().min(1).nullable().optional() }),
          ]),
        )
        .max(30)
        .optional()
        .describe("Column names (or objects) in order"),
      reason,
    }),
    handler: (ctx, i) => createBoard(ctx, i),
  }),
  op({
    name: "get_board",
    method: "GET",
    path: "/boards/{board_id}",
    tag: "Boards",
    summary: "Get a board with its columns and cards",
    access: "read",
    input: z.object({ board_id: z.string(), include_archived: z.boolean().optional() }),
    handler: (ctx, i) => getBoard(ctx, i.board_id, i),
  }),
  op({
    name: "update_board",
    method: "PATCH",
    path: "/boards/{board_id}",
    tag: "Boards",
    summary: "Rename, describe, reorder, archive or restore a board",
    access: "write",
    input: z.object({
      board_id: z.string(),
      name: z.string().min(1).max(200).optional(),
      description: z.string().max(10000).optional(),
      archived: z.boolean().optional(),
      position: z.number().int().min(0).optional().describe("0-based index among boards"),
      expected_version: expectedVersion,
      reason,
    }),
    handler: (ctx, i) => updateBoard(ctx, i),
  }),

  // ------------------------------------------------------------------ columns
  op({
    name: "create_column",
    method: "POST",
    path: "/boards/{board_id}/columns",
    tag: "Columns",
    summary: "Add a column to a board",
    access: "write",
    status: 201,
    input: z.object({
      board_id: z.string(),
      name: z.string().min(1).max(100),
      position: index.optional(),
      wip_limit: z.number().int().min(1).nullable().optional(),
      is_done: z.boolean().optional().describe("Cards moved here are marked completed"),
      reason,
    }),
    handler: (ctx, i) => createColumn(ctx, i),
  }),
  op({
    name: "update_column",
    method: "PATCH",
    path: "/columns/{column_id}",
    tag: "Columns",
    summary: "Rename, reorder, configure, archive or restore a column",
    description: "Archiving a column that still has active cards requires `move_cards_to`.",
    access: "write",
    input: z.object({
      column_id: z.string(),
      name: z.string().min(1).max(100).optional(),
      position: index.optional(),
      wip_limit: z.number().int().min(1).nullable().optional(),
      is_done: z.boolean().optional(),
      archived: z.boolean().optional(),
      move_cards_to: z.string().optional().describe("When archiving: column id to move remaining active cards into"),
      expected_version: expectedVersion,
      reason,
    }),
    handler: (ctx, i) => updateColumn(ctx, i),
  }),

  // ------------------------------------------------------------------ cards
  op({
    name: "list_cards",
    method: "GET",
    path: "/cards",
    tag: "Cards",
    summary: "Search and filter cards",
    access: "read",
    input: z.object({
      q: z.string().optional().describe("Text search over title and description"),
      board_id: z.string().optional(),
      column_id: z.string().optional(),
      label: z.string().optional(),
      assignee: z.string().optional(),
      priority: priority.optional(),
      archived: z.enum(["false", "true", "all"]).optional().describe("Default false"),
      completed: z.boolean().optional(),
      needs_review: z.boolean().optional().describe("Only cards with changes awaiting sign-off"),
      due_before: date.optional(),
      updated_since: z.string().optional().describe("ISO timestamp"),
      sort: z.enum(["updated", "created", "due", "position", "number"]).optional(),
      limit: z.number().int().min(1).max(200).optional(),
      offset: z.number().int().min(0).optional(),
    }),
    handler: (ctx, i) => listCards(ctx, i),
  }),
  op({
    name: "create_card",
    method: "POST",
    path: "/cards",
    tag: "Cards",
    summary: "Create a card",
    description:
      "Target a column with `column_id`, or `board_id` plus optional `column` (name, case-insensitive). With only `board_id` the card goes to the first column. With neither and exactly one board, that board is used.",
    access: "write",
    status: 201,
    input: z.object({
      board_id: z.string().optional(),
      column_id: z.string().optional(),
      column: z.string().optional().describe("Column name, used with board_id"),
      title: z.string().min(1).max(500),
      description: z.string().max(100000).optional().describe("Markdown"),
      labels: labels.optional(),
      priority: priority.optional(),
      assignee: z.string().max(100).nullable().optional().describe("Free text, e.g. 'me' or an agent name"),
      due_on: date.nullable().optional(),
      position: index.optional(),
      reason,
    }),
    handler: (ctx, i) => createCard(ctx, i),
  }),
  op({
    name: "get_card",
    method: "GET",
    path: "/cards/{card_id}",
    tag: "Cards",
    summary: "Get a card with its comments (and optionally full history)",
    access: "read",
    input: z.object({ card_id: cardRef, include_history: z.boolean().optional() }),
    handler: (ctx, i) => getCard(ctx, i.card_id, i),
  }),
  op({
    name: "update_card",
    method: "PATCH",
    path: "/cards/{card_id}",
    tag: "Cards",
    summary: "Edit, archive or restore a card",
    description: "Only provided fields change. `labels` replaces the set; `add_labels`/`remove_labels` edit it incrementally. Use move_card to change column or order.",
    access: "write",
    input: z.object({
      card_id: cardRef,
      title: z.string().min(1).max(500).optional(),
      description: z.string().max(100000).optional(),
      labels: labels.optional(),
      add_labels: labels.optional(),
      remove_labels: labels.optional(),
      priority: priority.optional(),
      assignee: z.string().max(100).nullable().optional(),
      due_on: date.nullable().optional(),
      archived: z.boolean().optional(),
      expected_version: expectedVersion,
      reason,
    }),
    handler: (ctx, i) => updateCard(ctx, i),
  }),
  op({
    name: "move_card",
    method: "POST",
    path: "/cards/{card_id}/move",
    tag: "Cards",
    summary: "Move a card to another column, board or position",
    description: "Give `column_id`, or `column` (name) on the card's board (or on `board_id`). Moving into a done column marks the card completed.",
    access: "write",
    input: z.object({
      card_id: cardRef,
      column_id: z.string().optional(),
      column: z.string().optional().describe("Target column name"),
      board_id: z.string().optional(),
      position: index.optional(),
      expected_version: expectedVersion,
      reason,
    }),
    handler: (ctx, i) => moveCard(ctx, i),
  }),
  op({
    name: "get_card_history",
    method: "GET",
    path: "/cards/{card_id}/history",
    tag: "Cards",
    summary: "Full change history of a card, oldest first",
    description: "Every create/update/move/archive/comment with actor, before/after snapshots, reason and review status.",
    access: "read",
    input: z.object({ card_id: cardRef }),
    handler: (ctx, i) => cardHistory(ctx, i.card_id),
  }),

  // ------------------------------------------------------------------ comments
  op({
    name: "list_comments",
    method: "GET",
    path: "/cards/{card_id}/comments",
    tag: "Comments",
    summary: "List comments on a card",
    access: "read",
    input: z.object({ card_id: cardRef, include_deleted: z.boolean().optional() }),
    handler: (ctx, i) => listComments(ctx, i),
  }),
  op({
    name: "add_comment",
    method: "POST",
    path: "/cards/{card_id}/comments",
    tag: "Comments",
    summary: "Comment on a card",
    description: "Good for agents to log progress notes, findings or questions on a task.",
    access: "write",
    status: 201,
    input: z.object({ card_id: cardRef, body: z.string().min(1).max(50000).describe("Markdown"), reason }),
    handler: (ctx, i) => addComment(ctx, i),
  }),
  op({
    name: "delete_comment",
    method: "DELETE",
    path: "/comments/{comment_id}",
    tag: "Comments",
    summary: "Delete a comment (soft; kept in history)",
    access: "write",
    input: z.object({ comment_id: z.string(), reason }),
    handler: (ctx, i) => deleteComment(ctx, i),
  }),

  // ------------------------------------------------------------------ history
  op({
    name: "list_events",
    method: "GET",
    path: "/events",
    tag: "History",
    summary: "Activity log across everything",
    description:
      "Newest first, paginate with `before_seq`. To tail new activity, pass `after_seq` (returns oldest first). Filter by board, card, entity, actor, session or review status.",
    access: "read",
    input: z.object({
      board_id: z.string().optional(),
      card_id: z.string().optional().describe("Card id, number or #ref"),
      entity_id: z.string().optional(),
      entity_type: z.enum(["board", "column", "card", "comment", "token"]).optional(),
      actor_id: z.string().optional(),
      actor_kind: z.enum(["owner", "human", "agent"]).optional(),
      session_id: z.string().optional(),
      review_status: z.enum(["none", "pending", "approved", "rejected"]).optional(),
      since: z.string().optional().describe("ISO timestamp"),
      before_seq: z.number().int().optional(),
      after_seq: z.number().int().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }),
    handler: (ctx, i) => listEvents(ctx, i),
  }),
  op({
    name: "get_event",
    method: "GET",
    path: "/events/{event_id}",
    tag: "History",
    summary: "Get one history event",
    access: "read",
    input: z.object({ event_id: z.string() }),
    handler: (ctx, i) => getEvent(ctx, i.event_id),
  }),
  op({
    name: "revert_event",
    method: "POST",
    path: "/events/{event_id}/revert",
    tag: "History",
    summary: "Undo a change by restoring its before-state",
    description: "Refuses with 409 if the entity changed afterwards, unless force=true. The revert itself is recorded as a new event.",
    access: "human",
    input: z.object({ event_id: z.string(), force: z.boolean().optional(), reason }),
    handler: (ctx, i) => revertEvent(ctx, i),
  }),

  // ------------------------------------------------------------------ reviews
  op({
    name: "list_reviews",
    method: "GET",
    path: "/reviews",
    tag: "Sign-off",
    summary: "Changes awaiting sign-off",
    description: "Pending changes made by agent tokens, plus a summary grouped by agent and session.",
    access: "read",
    input: z.object({
      board_id: z.string().optional(),
      actor_id: z.string().optional(),
      session_id: z.string().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }),
    handler: (ctx, i) => listReviews(ctx, i),
  }),
  op({
    name: "approve_changes",
    method: "POST",
    path: "/reviews/approve",
    tag: "Sign-off",
    summary: "Sign off on agent changes",
    description: "Select by event_ids, session_id, actor_id or card_id (combinable), or all=true for everything pending.",
    access: "human",
    input: z.object({
      event_ids: z.array(z.string()).max(500).optional(),
      session_id: z.string().optional(),
      actor_id: z.string().optional(),
      card_id: z.string().optional(),
      all: z.boolean().optional(),
      note: z.string().max(2000).optional(),
    }),
    handler: (ctx, i) => approveChanges(ctx, i),
  }),
  op({
    name: "reject_changes",
    method: "POST",
    path: "/reviews/reject",
    tag: "Sign-off",
    summary: "Reject agent changes (and revert them by default)",
    description: "Marks selected pending changes rejected and, unless revert=false, undoes them newest-first. Reverts that conflict with later edits are reported in revert_errors (use force=true to overwrite).",
    access: "human",
    input: z.object({
      event_ids: z.array(z.string()).max(500).optional(),
      session_id: z.string().optional(),
      actor_id: z.string().optional(),
      card_id: z.string().optional(),
      all: z.boolean().optional(),
      note: z.string().max(2000).optional(),
      revert: z.boolean().optional().describe("Default true"),
      force: z.boolean().optional(),
    }),
    handler: (ctx, i) => rejectChanges(ctx, i),
  }),

  // ------------------------------------------------------------------ tokens
  op({
    name: "list_tokens",
    method: "GET",
    path: "/tokens",
    tag: "Tokens",
    summary: "List API and agent tokens",
    access: "human",
    input: z.object({ include_revoked: z.boolean().optional() }),
    handler: (ctx, i) => listTokens(ctx, i),
  }),
  op({
    name: "create_token",
    method: "POST",
    path: "/tokens",
    tag: "Tokens",
    summary: "Create an API or agent token",
    description:
      "Returns the secret once. `kind: agent` tokens require sign-off on every change by default; `kind: human` tokens (e.g. for your own scripts or apps) don't, and can review.",
    access: "human",
    status: 201,
    input: z.object({
      name: z.string().min(1).max(100).describe("Shown as the author of changes, e.g. 'Claude Code' or 'iPhone app'"),
      kind: z.enum(["agent", "human"]),
      scope: z.enum(["read", "write"]).optional().describe("Default write"),
      requires_review: z.boolean().optional().describe("Default: true for agents, false for humans"),
    }),
    handler: (ctx, i) => createToken(ctx, i),
  }),
  op({
    name: "update_token",
    method: "PATCH",
    path: "/tokens/{token_id}",
    tag: "Tokens",
    summary: "Rename a token or change its scope / sign-off requirement",
    access: "human",
    input: z.object({
      token_id: z.string(),
      name: z.string().min(1).max(100).optional(),
      scope: z.enum(["read", "write"]).optional(),
      requires_review: z.boolean().optional(),
    }),
    handler: (ctx, i) => updateToken(ctx, i),
  }),
  op({
    name: "revoke_token",
    method: "DELETE",
    path: "/tokens/{token_id}",
    tag: "Tokens",
    summary: "Revoke a token",
    access: "human",
    input: z.object({ token_id: z.string() }),
    handler: (ctx, i) => revokeToken(ctx, i),
  }),

  // ------------------------------------------------------------------ export
  op({
    name: "export_data",
    method: "GET",
    path: "/export",
    tag: "Meta",
    summary: "Export everything as JSON",
    description: "Boards, columns, cards (incl. archived) and comments. Pass include_events=true for the full history log too.",
    access: "human",
    input: z.object({ include_events: z.boolean().optional() }),
    handler: async (ctx, i) => {
      const q = (sql: string) => ctx.db.prepare(sql);
      const stmts = [
        q(`SELECT * FROM boards ORDER BY position`),
        q(`SELECT * FROM columns ORDER BY board_id, position`),
        q(`SELECT * FROM cards ORDER BY number`),
        q(`SELECT * FROM comments ORDER BY created_at`),
      ];
      if (i.include_events) stmts.push(q(`SELECT * FROM events ORDER BY seq`));
      const [b, c, k, m, e] = await ctx.db.batch(stmts);
      const s = await import("../core/serialize");
      return {
        exported_at: new Date().toISOString(),
        schema_version: SCHEMA_VERSION,
        boards: b.results.map(s.boardOut),
        columns: c.results.map(s.columnOut),
        cards: k.results.map(s.cardOut),
        comments: m.results.map(s.commentOut),
        ...(e ? { events: e.results.map(s.eventOut) } : {}),
      };
    },
  }),
];

export const operationsByName = new Map(operations.map((o) => [o.name, o]));
