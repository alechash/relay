import type { Ctx } from "../context";
import { badRequest, conflict, notFound } from "../lib/errors";
import { nowIso } from "../lib/util";
import { getCardRow, writeCard } from "./cards";
import { eventStatement } from "./events";
import { boardOut, columnOut, commentOut, eventOut } from "./serialize";

/**
 * Names for ids referenced by a page of events (columns and cards), so clients
 * can render "moved #12 from To do → Doing" without extra round-trips.
 */
export async function collectRefs(ctx: Ctx, events: { entity_type: string; card_id: string | null; before: any; after: any }[]) {
  const colIds = new Set<string>();
  const cardIds = new Set<string>();
  const boardIds = new Set<string>();
  for (const e of events) {
    if (e.card_id) cardIds.add(e.card_id);
    for (const snap of [e.before, e.after]) {
      if (!snap) continue;
      if (e.entity_type === "card" && snap.column_id) colIds.add(snap.column_id);
      if (snap.board_id) boardIds.add(snap.board_id);
    }
  }
  const q = async (table: string, cols: string, ids: Set<string>) => {
    const list = [...ids];
    const out: any[] = [];
    for (let i = 0; i < list.length; i += 50) {
      const chunk = list.slice(i, i + 50);
      const { results } = await ctx.db.prepare(`SELECT ${cols} FROM ${table} WHERE id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all();
      out.push(...results);
    }
    return out;
  };
  const [cols, cards, boards] = await Promise.all([
    q("columns", "id, name", colIds),
    q("cards", "id, number, title", cardIds),
    q("boards", "id, name", boardIds),
  ]);
  return {
    columns: Object.fromEntries(cols.map((c) => [c.id, c.name as string])),
    boards: Object.fromEntries(boards.map((b) => [b.id, b.name as string])),
    cards: Object.fromEntries(cards.map((c) => [c.id, { ref: `#${c.number}`, title: c.title as string }])),
  };
}

export interface ListEventsInput {
  board_id?: string;
  card_id?: string;
  entity_id?: string;
  entity_type?: string;
  actor_id?: string;
  actor_kind?: string;
  session_id?: string;
  review_status?: string;
  since?: string;
  before_seq?: number;
  after_seq?: number;
  limit?: number;
}

export async function listEvents(ctx: Ctx, input: ListEventsInput) {
  const where: string[] = [];
  const args: unknown[] = [];
  if (input.card_id) {
    const card = await getCardRow(ctx, input.card_id);
    where.push(`card_id = ?`), args.push(card.id);
  }
  if (input.board_id) where.push(`board_id = ?`), args.push(input.board_id);
  if (input.entity_id) where.push(`entity_id = ?`), args.push(input.entity_id);
  if (input.entity_type) where.push(`entity_type = ?`), args.push(input.entity_type);
  if (input.actor_id) where.push(`actor_id = ?`), args.push(input.actor_id);
  if (input.actor_kind) where.push(`actor_kind = ?`), args.push(input.actor_kind);
  if (input.session_id) where.push(`session_id = ?`), args.push(input.session_id);
  if (input.review_status) where.push(`review_status = ?`), args.push(input.review_status);
  if (input.since) where.push(`created_at >= ?`), args.push(input.since);
  if (input.before_seq !== undefined) where.push(`seq < ?`), args.push(input.before_seq);
  if (input.after_seq !== undefined) where.push(`seq > ?`), args.push(input.after_seq);
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 500);
  // after_seq is for tailing (oldest first); otherwise newest first.
  const order = input.after_seq !== undefined ? "ASC" : "DESC";
  const { results } = await ctx.db
    .prepare(`SELECT * FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY seq ${order} LIMIT ?`)
    .bind(...args, limit + 1)
    .all();
  const has_more = results.length > limit;
  const events = results.slice(0, limit).map(eventOut);
  return {
    events,
    refs: await collectRefs(ctx, events),
    has_more,
    next_before_seq: has_more && order === "DESC" ? events[events.length - 1].seq : null,
    next_after_seq: order === "ASC" && events.length ? events[events.length - 1].seq : null,
  };
}

export async function getEvent(ctx: Ctx, id: string) {
  const row = await ctx.db.prepare(`SELECT * FROM events WHERE id = ?`).bind(id).first();
  if (!row) throw notFound("Event", id);
  return eventOut(row);
}

// ---------------- reviews / sign-off ----------------

export async function listReviews(ctx: Ctx, input: { board_id?: string; actor_id?: string; session_id?: string; limit?: number }) {
  const where = [`e.review_status = 'pending'`];
  const args: unknown[] = [];
  if (input.board_id) where.push(`e.board_id = ?`), args.push(input.board_id);
  if (input.actor_id) where.push(`e.actor_id = ?`), args.push(input.actor_id);
  if (input.session_id) where.push(`e.session_id = ?`), args.push(input.session_id);
  const w = where.join(" AND ");
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 500);
  const [events, groups, count] = await ctx.db.batch([
    ctx.db
      .prepare(
        `SELECT e.*, c.number AS card_number, c.title AS card_title FROM events e LEFT JOIN cards c ON c.id = e.card_id WHERE ${w} ORDER BY e.seq DESC LIMIT ?`,
      )
      .bind(...args, limit),
    ctx.db
      .prepare(
        `SELECT e.session_id, e.actor_id, e.actor_name, e.actor_kind, MAX(e.client) AS client, COUNT(*) AS count,
            MIN(e.created_at) AS first_at, MAX(e.created_at) AS last_at, COUNT(DISTINCT e.card_id) AS cards
         FROM events e WHERE ${w} GROUP BY e.session_id, e.actor_id ORDER BY last_at DESC`,
      )
      .bind(...args),
    ctx.db.prepare(`SELECT COUNT(*) AS n FROM events e WHERE ${w}`).bind(...args),
  ]);
  const evs = events.results.map((r: any) => ({
    ...eventOut(r),
    card: r.card_id ? { id: r.card_id, number: r.card_number, ref: r.card_number ? `#${r.card_number}` : null, title: r.card_title } : null,
  }));
  return {
    pending_count: (count.results[0] as any).n as number,
    refs: await collectRefs(ctx, evs),
    groups: groups.results.map((g: any) => ({
      session_id: g.session_id as string | null,
      actor: { id: g.actor_id, name: g.actor_name, kind: g.actor_kind },
      client: g.client as string | null,
      count: g.count as number,
      cards: g.cards as number,
      first_at: g.first_at as string,
      last_at: g.last_at as string,
    })),
    events: evs,
  };
}

interface Selector {
  event_ids?: string[];
  session_id?: string;
  actor_id?: string;
  card_id?: string;
  all?: boolean;
}

async function selectPending(ctx: Ctx, sel: Selector): Promise<any[]> {
  const where = [`review_status = 'pending'`];
  const args: unknown[] = [];
  let scoped = false;
  if (sel.event_ids?.length) {
    where.push(`id IN (${sel.event_ids.map(() => "?").join(",")})`), args.push(...sel.event_ids);
    scoped = true;
  }
  if (sel.session_id) where.push(`session_id = ?`), args.push(sel.session_id), (scoped = true);
  if (sel.actor_id) where.push(`actor_id = ?`), args.push(sel.actor_id), (scoped = true);
  if (sel.card_id) {
    const card = await getCardRow(ctx, sel.card_id);
    where.push(`card_id = ?`), args.push(card.id), (scoped = true);
  }
  if (!scoped && !sel.all) throw badRequest("Specify event_ids, session_id, actor_id or card_id, or pass all: true");
  const { results } = await ctx.db.prepare(`SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY seq DESC`).bind(...args).all();
  return results;
}

export async function approveChanges(ctx: Ctx, input: Selector & { note?: string }) {
  const rows = await selectPending(ctx, input);
  if (rows.length === 0) return { approved: 0, event_ids: [] as string[] };
  const ids = rows.map((r) => r.id as string);
  const now = nowIso();
  // D1 caps bound parameters per statement, so chunk.
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    stmts.push(
      ctx.db
        .prepare(
          `UPDATE events SET review_status = 'approved', reviewed_at = ?, reviewed_by_id = ?, reviewed_by_name = ?, review_note = ?
           WHERE review_status = 'pending' AND id IN (${chunk.map(() => "?").join(",")})`,
        )
        .bind(now, ctx.actor.id, ctx.actor.name, input.note ?? null, ...chunk),
    );
  }
  await ctx.db.batch(stmts);
  return { approved: ids.length, event_ids: ids };
}

export async function rejectChanges(ctx: Ctx, input: Selector & { note?: string; revert?: boolean; force?: boolean }) {
  const rows = await selectPending(ctx, input);
  const now = nowIso();
  const reverted: { event_id: string; revert_event_id: string | null }[] = [];
  const errors: { event_id: string; error: string }[] = [];
  // newest first so chains of edits unwind in order
  for (const r of rows) {
    await ctx.db
      .prepare(`UPDATE events SET review_status = 'rejected', reviewed_at = ?, reviewed_by_id = ?, reviewed_by_name = ?, review_note = ? WHERE id = ?`)
      .bind(now, ctx.actor.id, ctx.actor.name, input.note ?? null, r.id)
      .run();
    if (input.revert === false) continue;
    try {
      const out = await revertEvent(ctx, { event_id: r.id as string, force: input.force, reason: input.note ?? "Rejected in review" });
      reverted.push({ event_id: r.id, revert_event_id: out.revert_event_id });
    } catch (err: any) {
      errors.push({ event_id: r.id, error: err?.message ?? String(err) });
    }
  }
  return { rejected: rows.length, event_ids: rows.map((r) => r.id as string), reverted, revert_errors: errors };
}

// ---------------- revert ----------------

/**
 * Undo one recorded change by restoring the entity's `before` snapshot.
 * Refuses when the entity changed after this event (unless force=true), so a
 * revert never silently clobbers later work.
 */
export async function revertEvent(ctx: Ctx, input: { event_id: string; force?: boolean; reason?: string }) {
  const e: any = await ctx.db.prepare(`SELECT * FROM events WHERE id = ?`).bind(input.event_id).first();
  if (!e) throw notFound("Event", input.event_id);
  if (e.reverted_by) throw conflict(`Event already reverted by ${e.reverted_by}`);
  if (e.action === "revert" && !input.force) throw badRequest("This event is itself a revert; revert the original event's revert by passing force: true");
  const before = e.before ? JSON.parse(e.before) : null;
  const after = e.after ? JSON.parse(e.after) : null;
  const reason = input.reason ?? `Revert of ${e.id}`;
  const opts = { reason, revertOf: e.id as string, reviewable: false };
  let revertId: string | null = null;

  const assertUnchanged = (current: any) => {
    if (!input.force && after && current.version !== after.version) {
      throw conflict(`${e.entity_type} ${e.entity_id} changed after this event (now version ${current.version}, event left it at ${after.version}). Pass force: true to overwrite.`);
    }
  };

  if (e.entity_type === "card") {
    const row = await getCardRow(ctx, e.entity_id);
    assertUnchanged(row);
    let next: any;
    if (e.action === "create") {
      if (row.archived_at) throw conflict("Card is already archived");
      next = { ...row, archived_at: nowIso() };
    } else {
      if (!before) throw badRequest("Event has no prior state to restore");
      const col: any = await ctx.db.prepare(`SELECT * FROM columns WHERE id = ?`).bind(before.column_id).first();
      if (!col || col.archived_at) throw conflict("The card's previous column no longer exists or is archived");
      next = {
        ...row,
        board_id: before.board_id,
        column_id: before.column_id,
        title: before.title,
        description: before.description,
        labels: JSON.stringify(before.labels ?? []),
        priority: before.priority,
        assignee: before.assignee,
        due_on: before.due_on,
        position: before.position,
        archived_at: before.archived_at,
        completed_at: before.completed_at,
      };
    }
    revertId = await writeCard(ctx, row, next, { action: "revert", ...opts });
  } else if (e.entity_type === "column") {
    const row: any = await ctx.db.prepare(`SELECT * FROM columns WHERE id = ?`).bind(e.entity_id).first();
    if (!row) throw notFound("Column", e.entity_id);
    assertUnchanged(row);
    const now = nowIso();
    let next: any;
    if (e.action === "create") {
      const n = await ctx.db.prepare(`SELECT COUNT(*) AS n FROM cards WHERE column_id = ? AND archived_at IS NULL`).bind(row.id).first<{ n: number }>();
      if (n && n.n > 0) throw conflict("Column has active cards; move them before reverting its creation");
      next = { ...row, archived_at: now };
    } else {
      next = { ...row, name: before.name, wip_limit: before.wip_limit, is_done: before.is_done ? 1 : 0, position: before.position, archived_at: before.archived_at };
    }
    const ev = eventStatement(
      ctx,
      { entityType: "column", entityId: row.id, boardId: row.board_id, action: "revert", before: columnOut(row), after: columnOut({ ...next, updated_at: now, version: row.version + 1 }), ...opts },
      true,
    );
    const res = await ctx.db.batch([
      ctx.db
        .prepare(`UPDATE columns SET name = ?, wip_limit = ?, is_done = ?, position = ?, archived_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?`)
        .bind(next.name, next.wip_limit, next.is_done, next.position, next.archived_at, now, row.id, row.version),
      ev.stmt,
    ]);
    if (res[0].meta.changes === 0) throw conflict("Column was modified concurrently, retry");
    revertId = ev.id;
  } else if (e.entity_type === "board") {
    const row: any = await ctx.db.prepare(`SELECT * FROM boards WHERE id = ?`).bind(e.entity_id).first();
    if (!row) throw notFound("Board", e.entity_id);
    assertUnchanged(row);
    const now = nowIso();
    const next =
      e.action === "create"
        ? { ...row, archived_at: now }
        : { ...row, name: before.name, description: before.description, position: before.position, archived_at: before.archived_at };
    const ev = eventStatement(
      ctx,
      { entityType: "board", entityId: row.id, boardId: row.id, action: "revert", before: boardOut(row), after: boardOut({ ...next, updated_at: now, version: row.version + 1 }), ...opts },
      true,
    );
    const res = await ctx.db.batch([
      ctx.db
        .prepare(`UPDATE boards SET name = ?, description = ?, position = ?, archived_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?`)
        .bind(next.name, next.description, next.position, next.archived_at, now, row.id, row.version),
      ev.stmt,
    ]);
    if (res[0].meta.changes === 0) throw conflict("Board was modified concurrently, retry");
    revertId = ev.id;
  } else if (e.entity_type === "comment") {
    const row: any = await ctx.db.prepare(`SELECT * FROM comments WHERE id = ?`).bind(e.entity_id).first();
    if (!row) throw notFound("Comment", e.entity_id);
    const deletedAt = e.action === "create" ? nowIso() : null;
    const ev = eventStatement(ctx, {
      entityType: "comment",
      entityId: row.id,
      boardId: e.board_id,
      cardId: e.card_id,
      action: "revert",
      before: commentOut(row),
      after: commentOut({ ...row, deleted_at: deletedAt }),
      ...opts,
    });
    await ctx.db.batch([ctx.db.prepare(`UPDATE comments SET deleted_at = ? WHERE id = ?`).bind(deletedAt, row.id), ev.stmt]);
    revertId = ev.id;
  } else {
    throw badRequest(`Events on ${e.entity_type} cannot be reverted`);
  }

  await ctx.db.prepare(`UPDATE events SET reverted_by = ? WHERE id = ?`).bind(revertId, e.id).run();
  return { event_id: e.id as string, revert_event_id: revertId, event: await getEvent(ctx, revertId!) };
}
