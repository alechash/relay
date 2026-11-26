import { AUTO_APPROVE_ACTIONS, isHuman, type Ctx } from "../context";
import { conflict, forbidden, notFound } from "../lib/errors";
import { newId, nowIso } from "../lib/util";
import { eventStatement } from "./events";
import { positionAt, renumber } from "./positions";
import { boardOut, cardOut, columnOut, type Board } from "./serialize";

export const DEFAULT_COLUMNS = [
  { name: "Backlog", is_done: false },
  { name: "To do", is_done: false },
  { name: "Doing", is_done: false },
  { name: "Done", is_done: true },
];

export async function getBoardRow(ctx: Ctx, id: string) {
  const row = await ctx.db.prepare(`SELECT * FROM boards WHERE id = ?`).bind(id).first();
  if (!row) throw notFound("Board", id);
  return row;
}

export async function listBoards(ctx: Ctx, opts: { include_archived?: boolean }) {
  const where = opts.include_archived ? "" : "WHERE b.archived_at IS NULL";
  const { results } = await ctx.db
    .prepare(
      `SELECT b.*,
        (SELECT COUNT(*) FROM cards c WHERE c.board_id = b.id AND c.archived_at IS NULL) AS open_cards,
        (SELECT COUNT(*) FROM events e WHERE e.board_id = b.id AND e.review_status = 'pending') AS pending_reviews
       FROM boards b ${where} ORDER BY b.position`,
    )
    .all();
  return results.map((r: any) => ({ ...boardOut(r), card_count: r.open_cards as number, pending_reviews: r.pending_reviews as number }));
}

export async function createBoard(
  ctx: Ctx,
  input: { name: string; description?: string; columns?: (string | { name: string; is_done?: boolean; wip_limit?: number | null })[]; reason?: string },
) {
  const now = nowIso();
  const last = await ctx.db.prepare(`SELECT MAX(position) AS p FROM boards`).first<{ p: number | null }>();
  const board = {
    id: newId("brd"),
    name: input.name,
    description: input.description ?? "",
    position: (last?.p ?? 0) + 1024,
    archived_at: null,
    created_at: now,
    updated_at: now,
    version: 1,
  };
  const cols = (input.columns ?? DEFAULT_COLUMNS).map((c, i) => {
    const spec = typeof c === "string" ? { name: c } : c;
    return {
      id: newId("col"),
      board_id: board.id,
      name: spec.name,
      position: (i + 1) * 1024,
      wip_limit: ("wip_limit" in spec ? spec.wip_limit : null) ?? null,
      is_done: "is_done" in spec && spec.is_done ? 1 : 0,
      archived_at: null,
      created_at: now,
      updated_at: now,
      version: 1,
    };
  });
  // If the caller gave plain names, treat a final column called "Done" as the done column.
  if (input.columns && input.columns.every((c) => typeof c === "string") && cols.length > 0) {
    const lastCol = cols[cols.length - 1];
    if (/^(done|complete|completed|finished|shipped)$/i.test(lastCol.name)) lastCol.is_done = 1;
  }
  const stmts: D1PreparedStatement[] = [
    ctx.db
      .prepare(`INSERT INTO boards (id, name, description, position, archived_at, created_at, updated_at, version) VALUES (?, ?, ?, ?, NULL, ?, ?, 1)`)
      .bind(board.id, board.name, board.description, board.position, now, now),
    eventStatement(ctx, { entityType: "board", entityId: board.id, boardId: board.id, action: "create", after: boardOut(board), reason: input.reason }).stmt,
  ];
  for (const c of cols) {
    stmts.push(
      ctx.db
        .prepare(
          `INSERT INTO columns (id, board_id, name, position, wip_limit, is_done, archived_at, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 1)`,
        )
        .bind(c.id, c.board_id, c.name, c.position, c.wip_limit, c.is_done, now, now),
    );
    stmts.push(
      eventStatement(ctx, { entityType: "column", entityId: c.id, boardId: board.id, action: "create", after: columnOut(c), reason: input.reason }).stmt,
    );
  }
  await ctx.db.batch(stmts);
  return getBoard(ctx, board.id, {});
}

export async function getBoard(ctx: Ctx, id: string, opts: { include_archived?: boolean }) {
  const board = boardOut(await getBoardRow(ctx, id));
  const colWhere = opts.include_archived ? "" : "AND archived_at IS NULL";
  const cardWhere = opts.include_archived ? "" : "AND c.archived_at IS NULL";
  const [cols, cards] = await ctx.db.batch([
    ctx.db.prepare(`SELECT * FROM columns WHERE board_id = ? ${colWhere} ORDER BY position`).bind(id),
    ctx.db
      .prepare(
        `SELECT c.*,
          (SELECT COUNT(*) FROM events e WHERE e.card_id = c.id AND e.review_status = 'pending') AS pending_reviews,
          (SELECT COUNT(*) FROM comments m WHERE m.card_id = c.id AND m.deleted_at IS NULL) AS comment_count
         FROM cards c WHERE c.board_id = ? ${cardWhere} ORDER BY c.position`,
      )
      .bind(id),
  ]);
  const byColumn = new Map<string, ReturnType<typeof cardOut>[]>();
  for (const r of cards.results) {
    const c = cardOut(r);
    if (!byColumn.has(c.column_id)) byColumn.set(c.column_id, []);
    byColumn.get(c.column_id)!.push(c);
  }
  return {
    ...board,
    columns: cols.results.map((r) => {
      const col = columnOut(r);
      return { ...col, cards: byColumn.get(col.id) ?? [] };
    }),
  };
}

export async function updateBoard(
  ctx: Ctx,
  input: {
    board_id: string;
    name?: string;
    description?: string;
    archived?: boolean;
    position?: number;
    agent_auto_approve?: string[];
    expected_version?: number;
    reason?: string;
  },
) {
  if (input.agent_auto_approve !== undefined && !isHuman(ctx.actor)) {
    throw forbidden("Only a human can change a board's agent auto-approve policy");
  }
  const row: any = await getBoardRow(ctx, input.board_id);
  if (input.expected_version !== undefined && input.expected_version !== row.version) {
    throw conflict(`Board was modified (version ${row.version}, expected ${input.expected_version})`, { current: boardOut(row) });
  }
  const before = boardOut(row);
  const now = nowIso();
  const next = { ...row };
  if (input.name !== undefined) next.name = input.name;
  if (input.description !== undefined) next.description = input.description;
  if (input.archived !== undefined) next.archived_at = input.archived ? (row.archived_at ?? now) : null;
  if (input.agent_auto_approve !== undefined) {
    const allowed = new Set<string>(AUTO_APPROVE_ACTIONS);
    next.agent_auto_approve = JSON.stringify([...new Set(input.agent_auto_approve)].filter((a) => allowed.has(a)));
  }
  const stmts: D1PreparedStatement[] = [];
  if (input.position !== undefined) {
    const { results } = await ctx.db.prepare(`SELECT id, position FROM boards WHERE id != ? ORDER BY position`).bind(row.id).all<any>();
    let pos = positionAt(results, input.position);
    if (pos === null) {
      const re = renumber(results);
      for (const r of re) stmts.push(ctx.db.prepare(`UPDATE boards SET position = ? WHERE id = ?`).bind(r.position, r.id));
      pos = positionAt(re, input.position)!;
    }
    next.position = pos;
  }
  const after: Board = boardOut({ ...next, updated_at: now, version: row.version + 1 });
  const action = input.archived === true && !row.archived_at ? "archive" : input.archived === false && row.archived_at ? "restore" : "update";
  stmts.push(
    ctx.db
      .prepare(
        `UPDATE boards SET name = ?, description = ?, archived_at = ?, position = ?, agent_auto_approve = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?`,
      )
      .bind(next.name, next.description, next.archived_at, next.position, next.agent_auto_approve ?? "[]", now, row.id, row.version),
  );
  stmts.push(eventStatement(ctx, { entityType: "board", entityId: row.id, boardId: row.id, action, before, after, reason: input.reason }, true).stmt);
  const res = await ctx.db.batch(stmts);
  if (res[res.length - 2].meta.changes === 0) throw conflict("Board was modified concurrently, retry");
  return boardOut(await getBoardRow(ctx, row.id));
}
