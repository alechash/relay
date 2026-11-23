import type { Ctx } from "../context";
import { badRequest, conflict, notFound } from "../lib/errors";
import { newId, nowIso, parseJson } from "../lib/util";
import { getColumnRow } from "./columns";
import { eventStatement } from "./events";
import { positionAt, renumber } from "./positions";
import { cardOut, commentOut, eventOut } from "./serialize";
import { collectRefs } from "./history";

export const PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const;

/** Accepts a card id (`crd_…`), a number (`42`) or a ref (`#42`). */
export async function getCardRow(ctx: Ctx, ref: string) {
  const m = /^#?(\d+)$/.exec(ref.trim());
  const row = m
    ? await ctx.db.prepare(`SELECT * FROM cards WHERE number = ?`).bind(Number(m[1])).first<any>()
    : await ctx.db.prepare(`SELECT * FROM cards WHERE id = ?`).bind(ref).first<any>();
  if (!row) throw notFound("Card", ref);
  return row;
}

function normLabels(labels: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of labels) {
    const t = l.trim();
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      out.push(t);
    }
  }
  return out;
}

async function placeCard(ctx: Ctx, columnId: string, excludeId: string | null, index: number | undefined, pre: D1PreparedStatement[]) {
  const { results } = await ctx.db
    .prepare(`SELECT id, position FROM cards WHERE column_id = ? AND archived_at IS NULL AND id != ? ORDER BY position`)
    .bind(columnId, excludeId ?? "")
    .all<any>();
  let pos = positionAt(results, index);
  if (pos === null) {
    const re = renumber(results);
    for (const r of re) pre.push(ctx.db.prepare(`UPDATE cards SET position = ? WHERE id = ?`).bind(r.position, r.id));
    pos = positionAt(re, index)!;
  }
  return pos;
}

async function resolveTargetColumn(ctx: Ctx, input: { board_id?: string; column_id?: string; column?: string }) {
  if (input.column_id) return getColumnRow(ctx, input.column_id);
  let boardId = input.board_id;
  if (!boardId) {
    const { results } = await ctx.db.prepare(`SELECT id FROM boards WHERE archived_at IS NULL LIMIT 2`).all<any>();
    if (results.length !== 1) throw badRequest("Provide column_id or board_id (there is more than one board)");
    boardId = results[0].id as string;
  }
  if (input.column) {
    const col = await ctx.db
      .prepare(`SELECT * FROM columns WHERE board_id = ? AND archived_at IS NULL AND lower(name) = lower(?) ORDER BY position LIMIT 1`)
      .bind(boardId, input.column.trim())
      .first<any>();
    if (!col) throw notFound("Column named", input.column);
    return col;
  }
  const col = await ctx.db
    .prepare(`SELECT * FROM columns WHERE board_id = ? AND archived_at IS NULL ORDER BY position LIMIT 1`)
    .bind(boardId)
    .first<any>();
  if (!col) throw notFound("Board (or it has no columns)", boardId);
  return col;
}

export interface CreateCardInput {
  board_id?: string;
  column_id?: string;
  column?: string;
  title: string;
  description?: string;
  labels?: string[];
  priority?: (typeof PRIORITIES)[number];
  assignee?: string | null;
  due_on?: string | null;
  position?: number;
  reason?: string;
}

export async function createCard(ctx: Ctx, input: CreateCardInput) {
  const col = await resolveTargetColumn(ctx, input);
  if (col.archived_at) throw badRequest("Cannot add a card to an archived column");
  const pre: D1PreparedStatement[] = [];
  const position = await placeCard(ctx, col.id, null, input.position, pre);
  const now = nowIso();
  for (let attempt = 0; attempt < 3; attempt++) {
    const max = await ctx.db.prepare(`SELECT COALESCE(MAX(number), 0) AS n FROM cards`).first<{ n: number }>();
    const row = {
      id: newId("crd"),
      number: (max?.n ?? 0) + 1,
      board_id: col.board_id,
      column_id: col.id,
      title: input.title,
      description: input.description ?? "",
      labels: JSON.stringify(normLabels(input.labels ?? [])),
      priority: input.priority ?? "none",
      assignee: input.assignee ?? null,
      due_on: input.due_on ?? null,
      position,
      archived_at: null,
      completed_at: col.is_done ? now : null,
      created_at: now,
      updated_at: now,
      created_by_id: ctx.actor.id,
      created_by_name: ctx.actor.name,
      created_by_kind: ctx.actor.kind,
      updated_by_id: ctx.actor.id,
      updated_by_name: ctx.actor.name,
      updated_by_kind: ctx.actor.kind,
      version: 1,
    };
    const keys = Object.keys(row);
    try {
      await ctx.db.batch([
        ...pre,
        ctx.db.prepare(`INSERT INTO cards (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).bind(...Object.values(row)),
        eventStatement(ctx, {
          entityType: "card",
          entityId: row.id,
          boardId: row.board_id,
          cardId: row.id,
          action: "create",
          after: cardOut(row),
          reason: input.reason,
        }).stmt,
      ]);
      return getCard(ctx, row.id);
    } catch (err) {
      if (attempt < 2 && String(err).includes("UNIQUE")) continue; // card number race, retry
      throw err;
    }
  }
  throw conflict("Could not allocate a card number, retry");
}

/** Writes a card change + its history event atomically, with optimistic concurrency. */
export async function writeCard(
  ctx: Ctx,
  row: any,
  next: any,
  opts: { action: string; reason?: string | null; pre?: D1PreparedStatement[]; revertOf?: string | null; reviewable?: boolean },
) {
  const now = nowIso();
  const updated = {
    ...next,
    updated_at: now,
    updated_by_id: ctx.actor.id,
    updated_by_name: ctx.actor.name,
    updated_by_kind: ctx.actor.kind,
    version: row.version + 1,
  };
  const before = cardOut(row);
  const after = cardOut(updated);
  const update = ctx.db
    .prepare(
      `UPDATE cards SET board_id = ?, column_id = ?, title = ?, description = ?, labels = ?, priority = ?, assignee = ?, due_on = ?, position = ?,
         archived_at = ?, completed_at = ?, updated_at = ?, updated_by_id = ?, updated_by_name = ?, updated_by_kind = ?, version = version + 1
       WHERE id = ? AND version = ?`,
    )
    .bind(
      updated.board_id,
      updated.column_id,
      updated.title,
      updated.description,
      updated.labels,
      updated.priority,
      updated.assignee,
      updated.due_on,
      updated.position,
      updated.archived_at,
      updated.completed_at,
      now,
      ctx.actor.id,
      ctx.actor.name,
      ctx.actor.kind,
      row.id,
      row.version,
    );
  const ev = eventStatement(
    ctx,
    {
      entityType: "card",
      entityId: row.id,
      boardId: updated.board_id,
      cardId: row.id,
      action: opts.action,
      before,
      after,
      reason: opts.reason,
      revertOf: opts.revertOf,
      reviewable: opts.reviewable,
    },
    true,
  );
  const pre = opts.pre ?? [];
  const res = await ctx.db.batch([...pre, update, ev.stmt]);
  if (res[pre.length].meta.changes === 0) throw conflict("Card was modified concurrently; fetch it again and retry");
  return ev.id;
}

export interface UpdateCardInput {
  card_id: string;
  title?: string;
  description?: string;
  labels?: string[];
  add_labels?: string[];
  remove_labels?: string[];
  priority?: (typeof PRIORITIES)[number];
  assignee?: string | null;
  due_on?: string | null;
  archived?: boolean;
  expected_version?: number;
  reason?: string;
}

export async function updateCard(ctx: Ctx, input: UpdateCardInput) {
  const row = await getCardRow(ctx, input.card_id);
  if (input.expected_version !== undefined && input.expected_version !== row.version) {
    throw conflict(`Card was modified (version ${row.version}, expected ${input.expected_version})`, { current: cardOut(row) });
  }
  const next = { ...row };
  if (input.title !== undefined) next.title = input.title;
  if (input.description !== undefined) next.description = input.description;
  let labels = parseJson<string[]>(row.labels, []);
  if (input.labels !== undefined) labels = input.labels;
  if (input.add_labels) labels = [...labels, ...input.add_labels];
  if (input.remove_labels) {
    const rm = new Set(input.remove_labels.map((l) => l.trim().toLowerCase()));
    labels = labels.filter((l) => !rm.has(l.toLowerCase()));
  }
  next.labels = JSON.stringify(normLabels(labels));
  if (input.priority !== undefined) next.priority = input.priority;
  if (input.assignee !== undefined) next.assignee = input.assignee || null;
  if (input.due_on !== undefined) next.due_on = input.due_on || null;
  let action = "update";
  const pre: D1PreparedStatement[] = [];
  if (input.archived === true && !row.archived_at) {
    next.archived_at = nowIso();
    action = "archive";
  } else if (input.archived === false && row.archived_at) {
    const col = await getColumnRow(ctx, row.column_id);
    if (col.archived_at) throw conflict("The card's column is archived; restore the column or move the card after restoring");
    next.archived_at = null;
    next.position = await placeCard(ctx, row.column_id, row.id, undefined, pre);
    action = "restore";
  }
  await writeCard(ctx, row, next, { action, reason: input.reason, pre });
  return getCard(ctx, row.id);
}

export async function moveCard(
  ctx: Ctx,
  input: { card_id: string; column_id?: string; column?: string; board_id?: string; position?: number; expected_version?: number; reason?: string },
) {
  const row = await getCardRow(ctx, input.card_id);
  if (input.expected_version !== undefined && input.expected_version !== row.version) {
    throw conflict(`Card was modified (version ${row.version}, expected ${input.expected_version})`, { current: cardOut(row) });
  }
  const target =
    input.column_id || input.column
      ? await resolveTargetColumn(ctx, { column_id: input.column_id, column: input.column, board_id: input.board_id ?? row.board_id })
      : input.board_id && input.board_id !== row.board_id
        ? await resolveTargetColumn(ctx, { board_id: input.board_id })
        : await getColumnRow(ctx, row.column_id);
  if (target.archived_at) throw badRequest("Cannot move a card into an archived column");
  const pre: D1PreparedStatement[] = [];
  const next = { ...row };
  next.column_id = target.id;
  next.board_id = target.board_id;
  next.position = await placeCard(ctx, target.id, row.id, input.position, pre);
  if (target.is_done && !row.completed_at) next.completed_at = nowIso();
  if (!target.is_done) next.completed_at = null;
  await writeCard(ctx, row, next, { action: "move", reason: input.reason, pre });
  return getCard(ctx, row.id);
}

export async function getCard(ctx: Ctx, ref: string, opts: { include_history?: boolean } = {}) {
  const row = await getCardRow(ctx, ref);
  const stmts = [
    ctx.db.prepare(`SELECT * FROM comments WHERE card_id = ? AND deleted_at IS NULL ORDER BY created_at`).bind(row.id),
    ctx.db.prepare(`SELECT COUNT(*) AS n FROM events WHERE card_id = ? AND review_status = 'pending'`).bind(row.id),
    ctx.db.prepare(`SELECT c.name AS column_name, b.name AS board_name FROM columns c JOIN boards b ON b.id = c.board_id WHERE c.id = ?`).bind(row.column_id),
  ];
  if (opts.include_history) stmts.push(ctx.db.prepare(`SELECT * FROM events WHERE card_id = ? ORDER BY seq`).bind(row.id));
  const [comments, pending, names, history] = await ctx.db.batch(stmts);
  const n: any = names.results[0] ?? {};
  return {
    ...cardOut({ ...row, pending_reviews: (pending.results[0] as any)?.n ?? 0, comment_count: comments.results.length }),
    column_name: (n.column_name as string) ?? null,
    board_name: (n.board_name as string) ?? null,
    comments: comments.results.map(commentOut),
    ...(history ? { history: history.results.map(eventOut) } : {}),
  };
}

export interface ListCardsInput {
  q?: string;
  board_id?: string;
  column_id?: string;
  label?: string;
  assignee?: string;
  priority?: string;
  archived?: "false" | "true" | "all";
  completed?: boolean;
  needs_review?: boolean;
  due_before?: string;
  updated_since?: string;
  sort?: "updated" | "created" | "due" | "position" | "number";
  limit?: number;
  offset?: number;
}

export async function listCards(ctx: Ctx, input: ListCardsInput) {
  const where: string[] = [];
  const args: unknown[] = [];
  if (input.q) {
    where.push(`(c.title LIKE ? ESCAPE '\\' OR c.description LIKE ? ESCAPE '\\')`);
    const like = `%${input.q.replace(/[\\%_]/g, (m) => "\\" + m)}%`;
    args.push(like, like);
  }
  if (input.board_id) where.push(`c.board_id = ?`), args.push(input.board_id);
  if (input.column_id) where.push(`c.column_id = ?`), args.push(input.column_id);
  if (input.label) where.push(`EXISTS (SELECT 1 FROM json_each(c.labels) j WHERE lower(j.value) = lower(?))`), args.push(input.label);
  if (input.assignee) where.push(`lower(c.assignee) = lower(?)`), args.push(input.assignee);
  if (input.priority) where.push(`c.priority = ?`), args.push(input.priority);
  const archived = input.archived ?? "false";
  if (archived === "false") where.push(`c.archived_at IS NULL`);
  if (archived === "true") where.push(`c.archived_at IS NOT NULL`);
  if (input.completed === true) where.push(`c.completed_at IS NOT NULL`);
  if (input.completed === false) where.push(`c.completed_at IS NULL`);
  if (input.needs_review === true) where.push(`EXISTS (SELECT 1 FROM events e WHERE e.card_id = c.id AND e.review_status = 'pending')`);
  if (input.due_before) where.push(`c.due_on IS NOT NULL AND c.due_on <= ?`), args.push(input.due_before);
  if (input.updated_since) where.push(`c.updated_at >= ?`), args.push(input.updated_since);
  const order = {
    updated: "c.updated_at DESC",
    created: "c.created_at DESC",
    due: "c.due_on IS NULL, c.due_on ASC",
    position: "c.board_id, col.position, c.position",
    number: "c.number ASC",
  }[input.sort ?? "updated"];
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const offset = Math.max(input.offset ?? 0, 0);
  const sql = `SELECT c.*, col.name AS column_name,
      (SELECT COUNT(*) FROM events e WHERE e.card_id = c.id AND e.review_status = 'pending') AS pending_reviews
    FROM cards c JOIN columns col ON col.id = c.column_id
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY ${order} LIMIT ? OFFSET ?`;
  const { results } = await ctx.db.prepare(sql).bind(...args, limit + 1, offset).all<any>();
  const has_more = results.length > limit;
  return {
    cards: results.slice(0, limit).map((r) => ({ ...cardOut(r), column_name: r.column_name as string })),
    has_more,
    next_offset: has_more ? offset + limit : null,
  };
}

export async function cardHistory(ctx: Ctx, ref: string) {
  const row = await getCardRow(ctx, ref);
  const { results } = await ctx.db.prepare(`SELECT * FROM events WHERE card_id = ? ORDER BY seq`).bind(row.id).all();
  const events = results.map(eventOut);
  return { card_id: row.id, ref: `#${row.number}`, events, refs: await collectRefs(ctx, events) };
}

// ---------- comments ----------

export async function addComment(ctx: Ctx, input: { card_id: string; body: string; reason?: string }) {
  const card = await getCardRow(ctx, input.card_id);
  const now = nowIso();
  const c = {
    id: newId("cmt"),
    card_id: card.id,
    body: input.body,
    author_id: ctx.actor.id,
    author_name: ctx.actor.name,
    author_kind: ctx.actor.kind,
    created_at: now,
    deleted_at: null,
  };
  await ctx.db.batch([
    ctx.db
      .prepare(`INSERT INTO comments (id, card_id, body, author_id, author_name, author_kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(c.id, c.card_id, c.body, c.author_id, c.author_name, c.author_kind, now),
    eventStatement(ctx, { entityType: "comment", entityId: c.id, boardId: card.board_id, cardId: card.id, action: "create", after: commentOut(c), reason: input.reason }).stmt,
  ]);
  return commentOut(c);
}

export async function listComments(ctx: Ctx, input: { card_id: string; include_deleted?: boolean }) {
  const card = await getCardRow(ctx, input.card_id);
  const { results } = await ctx.db
    .prepare(`SELECT * FROM comments WHERE card_id = ? ${input.include_deleted ? "" : "AND deleted_at IS NULL"} ORDER BY created_at`)
    .bind(card.id)
    .all();
  return { comments: results.map(commentOut) };
}

export async function deleteComment(ctx: Ctx, input: { comment_id: string; reason?: string }) {
  const row = await ctx.db.prepare(`SELECT * FROM comments WHERE id = ?`).bind(input.comment_id).first<any>();
  if (!row) throw notFound("Comment", input.comment_id);
  if (row.deleted_at) return commentOut(row);
  const card = await getCardRow(ctx, row.card_id);
  const now = nowIso();
  await ctx.db.batch([
    ctx.db.prepare(`UPDATE comments SET deleted_at = ? WHERE id = ?`).bind(now, row.id),
    eventStatement(ctx, {
      entityType: "comment",
      entityId: row.id,
      boardId: card.board_id,
      cardId: card.id,
      action: "delete",
      before: commentOut(row),
      after: commentOut({ ...row, deleted_at: now }),
      reason: input.reason,
    }).stmt,
  ]);
  return commentOut({ ...row, deleted_at: now });
}
