import type { Ctx } from "../context";
import { badRequest, conflict, notFound } from "../lib/errors";
import { newId, nowIso } from "../lib/util";
import { getBoardRow } from "./boards";
import { eventStatement } from "./events";
import { positionAt, renumber } from "./positions";
import { cardOut, columnOut } from "./serialize";

export async function getColumnRow(ctx: Ctx, id: string) {
  const row = await ctx.db.prepare(`SELECT * FROM columns WHERE id = ?`).bind(id).first<any>();
  if (!row) throw notFound("Column", id);
  return row;
}

async function placeColumn(ctx: Ctx, boardId: string, excludeId: string | null, index: number | undefined, stmts: D1PreparedStatement[]) {
  const { results } = await ctx.db
    .prepare(`SELECT id, position FROM columns WHERE board_id = ? AND archived_at IS NULL AND id != ? ORDER BY position`)
    .bind(boardId, excludeId ?? "")
    .all<any>();
  let pos = positionAt(results, index);
  if (pos === null) {
    const re = renumber(results);
    for (const r of re) stmts.push(ctx.db.prepare(`UPDATE columns SET position = ? WHERE id = ?`).bind(r.position, r.id));
    pos = positionAt(re, index)!;
  }
  return pos;
}

export async function createColumn(
  ctx: Ctx,
  input: { board_id: string; name: string; position?: number; wip_limit?: number | null; is_done?: boolean; reason?: string },
) {
  await getBoardRow(ctx, input.board_id);
  const stmts: D1PreparedStatement[] = [];
  const now = nowIso();
  const col = {
    id: newId("col"),
    board_id: input.board_id,
    name: input.name,
    position: await placeColumn(ctx, input.board_id, null, input.position, stmts),
    wip_limit: input.wip_limit ?? null,
    is_done: input.is_done ? 1 : 0,
    archived_at: null,
    created_at: now,
    updated_at: now,
    version: 1,
  };
  stmts.push(
    ctx.db
      .prepare(`INSERT INTO columns (id, board_id, name, position, wip_limit, is_done, archived_at, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 1)`)
      .bind(col.id, col.board_id, col.name, col.position, col.wip_limit, col.is_done, now, now),
    eventStatement(ctx, { entityType: "column", entityId: col.id, boardId: col.board_id, action: "create", after: columnOut(col), reason: input.reason }).stmt,
  );
  await ctx.db.batch(stmts);
  return columnOut(col);
}

export async function updateColumn(
  ctx: Ctx,
  input: {
    column_id: string;
    name?: string;
    wip_limit?: number | null;
    is_done?: boolean;
    position?: number;
    archived?: boolean;
    move_cards_to?: string;
    expected_version?: number;
    reason?: string;
  },
) {
  const row = await getColumnRow(ctx, input.column_id);
  if (input.expected_version !== undefined && input.expected_version !== row.version) {
    throw conflict(`Column was modified (version ${row.version}, expected ${input.expected_version})`, { current: columnOut(row) });
  }
  const before = columnOut(row);
  const now = nowIso();
  const next = { ...row };
  const stmts: D1PreparedStatement[] = [];
  const pre: D1PreparedStatement[] = [];
  if (input.name !== undefined) next.name = input.name;
  if (input.wip_limit !== undefined) next.wip_limit = input.wip_limit;
  if (input.is_done !== undefined) next.is_done = input.is_done ? 1 : 0;
  if (input.position !== undefined) next.position = await placeColumn(ctx, row.board_id, row.id, input.position, pre);

  let action = "update";
  if (input.archived === true && !row.archived_at) {
    action = "archive";
    next.archived_at = now;
    const { results: active } = await ctx.db
      .prepare(`SELECT * FROM cards WHERE column_id = ? AND archived_at IS NULL ORDER BY position`)
      .bind(row.id)
      .all<any>();
    if (active.length > 0) {
      if (!input.move_cards_to) {
        throw conflict(`Column has ${active.length} active card(s). Pass move_cards_to with another column id, or move/archive them first.`);
      }
      const target = await getColumnRow(ctx, input.move_cards_to);
      if (target.board_id !== row.board_id || target.id === row.id || target.archived_at) {
        throw badRequest("move_cards_to must be another active column on the same board");
      }
      const last = await ctx.db.prepare(`SELECT MAX(position) AS p FROM cards WHERE column_id = ?`).bind(target.id).first<{ p: number | null }>();
      let pos = last?.p ?? 0;
      for (const c of active) {
        pos += 1024;
        const completedAt = target.is_done ? (c.completed_at ?? now) : null;
        const after = cardOut({
          ...c,
          column_id: target.id,
          position: pos,
          completed_at: completedAt,
          updated_at: now,
          version: c.version + 1,
          updated_by_id: ctx.actor.id,
          updated_by_name: ctx.actor.name,
          updated_by_kind: ctx.actor.kind,
        });
        stmts.push(
          ctx.db
            .prepare(
              `UPDATE cards SET column_id = ?, position = ?, completed_at = ?, updated_at = ?, updated_by_id = ?, updated_by_name = ?, updated_by_kind = ?, version = version + 1 WHERE id = ?`,
            )
            .bind(target.id, pos, completedAt, now, ctx.actor.id, ctx.actor.name, ctx.actor.kind, c.id),
          eventStatement(ctx, {
            entityType: "card",
            entityId: c.id,
            boardId: c.board_id,
            cardId: c.id,
            action: "move",
            before: cardOut(c),
            after,
            reason: input.reason ?? `Column '${row.name}' archived`,
          }).stmt,
        );
      }
    }
  } else if (input.archived === false && row.archived_at) {
    action = "restore";
    next.archived_at = null;
  }

  const after = columnOut({ ...next, updated_at: now, version: row.version + 1 });
  const update = ctx.db
    .prepare(`UPDATE columns SET name = ?, wip_limit = ?, is_done = ?, position = ?, archived_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?`)
    .bind(next.name, next.wip_limit, next.is_done, next.position, next.archived_at, now, row.id, row.version);
  const ev = eventStatement(ctx, { entityType: "column", entityId: row.id, boardId: row.board_id, action, before, after, reason: input.reason }, true);
  const res = await ctx.db.batch([...pre, update, ev.stmt, ...stmts]);
  if (res[pre.length].meta.changes === 0) throw conflict("Column was modified concurrently, retry");
  return columnOut(await getColumnRow(ctx, row.id));
}
