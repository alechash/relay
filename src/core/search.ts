import type { Ctx } from "../context";
import { badRequest } from "../lib/errors";
import { nowIso, parseJson } from "../lib/util";
import { getCardRow, writeCard } from "./cards";
import { cardOut } from "./serialize";

/**
 * Card search shared by list_cards (full cards) and search_cards (compact summaries).
 *
 * Semantics (documented in the API):
 * - `q`: whitespace-separated terms; every term must appear (case-insensitive) in the title or
 *   description. A term like `#42` or `42` also matches that card number.
 * - `labels`: with `label_mode: "all"` (default) a card must carry every label; with "any", at least one.
 *   Label matching is case-insensitive.
 * - `due_after` / `due_before`: inclusive, YYYY-MM-DD. Either implies the card has a due date.
 * - `status`: column name (case-insensitive), e.g. "Doing". Combine with `board_id` to be unambiguous.
 * - All filters combine with AND.
 */
export interface CardFilters {
  q?: string;
  board_id?: string;
  column_id?: string;
  status?: string;
  label?: string;
  labels?: string[];
  label_mode?: "any" | "all";
  assignee?: string;
  priority?: string;
  archived?: "false" | "true" | "all";
  completed?: boolean;
  needs_review?: boolean;
  due_before?: string;
  due_after?: string;
  updated_since?: string;
  sort?: "updated" | "created" | "due" | "position" | "number";
  limit?: number;
  offset?: number;
}

function escapeLike(s: string) {
  return `%${s.replace(/[\\%_]/g, (m) => "\\" + m)}%`;
}

function buildWhere(f: CardFilters): { sql: string; args: unknown[] } {
  const where: string[] = [];
  const args: unknown[] = [];
  const terms = (f.q ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 10);
  for (const t of terms) {
    const num = /^#?(\d+)$/.exec(t);
    if (num) {
      where.push(`(c.number = ? OR c.title LIKE ? ESCAPE '\\' OR c.description LIKE ? ESCAPE '\\')`);
      args.push(Number(num[1]), escapeLike(t), escapeLike(t));
    } else {
      where.push(`(c.title LIKE ? ESCAPE '\\' OR c.description LIKE ? ESCAPE '\\')`);
      args.push(escapeLike(t), escapeLike(t));
    }
  }
  if (f.board_id) where.push(`c.board_id = ?`), args.push(f.board_id);
  if (f.column_id) where.push(`c.column_id = ?`), args.push(f.column_id);
  if (f.status) where.push(`lower(col.name) = lower(?)`), args.push(f.status.trim());
  const labels = [...(f.labels ?? []), ...(f.label ? [f.label] : [])].map((l) => l.trim()).filter(Boolean);
  if (labels.length) {
    const has = `EXISTS (SELECT 1 FROM json_each(c.labels) j WHERE lower(j.value) = lower(?))`;
    const parts = labels.map(() => has);
    where.push(f.label_mode === "any" ? `(${parts.join(" OR ")})` : parts.join(" AND "));
    args.push(...labels);
  }
  if (f.assignee) where.push(`lower(c.assignee) = lower(?)`), args.push(f.assignee);
  if (f.priority) where.push(`c.priority = ?`), args.push(f.priority);
  const archived = f.archived ?? "false";
  if (archived === "false") where.push(`c.archived_at IS NULL`);
  if (archived === "true") where.push(`c.archived_at IS NOT NULL`);
  if (f.completed === true) where.push(`c.completed_at IS NOT NULL`);
  if (f.completed === false) where.push(`c.completed_at IS NULL`);
  if (f.needs_review === true) where.push(`EXISTS (SELECT 1 FROM events e WHERE e.card_id = c.id AND e.review_status = 'pending')`);
  if (f.needs_review === false) where.push(`NOT EXISTS (SELECT 1 FROM events e WHERE e.card_id = c.id AND e.review_status = 'pending')`);
  if (f.due_after && f.due_before && f.due_after > f.due_before) throw badRequest("due_after must be on or before due_before");
  if (f.due_after) where.push(`c.due_on IS NOT NULL AND c.due_on >= ?`), args.push(f.due_after);
  if (f.due_before) where.push(`c.due_on IS NOT NULL AND c.due_on <= ?`), args.push(f.due_before);
  if (f.updated_since) where.push(`c.updated_at >= ?`), args.push(f.updated_since);
  return { sql: where.length ? "WHERE " + where.join(" AND ") : "", args };
}

const ORDER = {
  updated: "c.updated_at DESC",
  created: "c.created_at DESC",
  due: "c.due_on IS NULL, c.due_on ASC, c.number ASC",
  position: "c.board_id, col.position, c.position",
  number: "c.number ASC",
};

async function query(ctx: Ctx, f: CardFilters, defaultLimit: number) {
  const { sql, args } = buildWhere(f);
  const limit = Math.min(Math.max(f.limit ?? defaultLimit, 1), 200);
  const offset = Math.max(f.offset ?? 0, 0);
  const from = `FROM cards c JOIN columns col ON col.id = c.column_id JOIN boards b ON b.id = c.board_id ${sql}`;
  const [rows, count] = await ctx.db.batch([
    ctx.db
      .prepare(
        `SELECT c.*, col.name AS column_name, b.name AS board_name,
          (SELECT COUNT(*) FROM events e WHERE e.card_id = c.id AND e.review_status = 'pending') AS pending_reviews
         ${from} ORDER BY ${ORDER[f.sort ?? "updated"]} LIMIT ? OFFSET ?`,
      )
      .bind(...args, limit + 1, offset),
    ctx.db.prepare(`SELECT COUNT(*) AS n ${from}`).bind(...args),
  ]);
  const results = rows.results as any[];
  const has_more = results.length > limit;
  return {
    rows: results.slice(0, limit),
    total: (count.results[0] as any).n as number,
    has_more,
    next_offset: has_more ? offset + limit : null,
  };
}

export async function listCards(ctx: Ctx, f: CardFilters) {
  const r = await query(ctx, f, 50);
  return {
    cards: r.rows.map((row) => ({ ...cardOut(row), column_name: row.column_name as string, board_name: row.board_name as string })),
    total: r.total,
    has_more: r.has_more,
    next_offset: r.next_offset,
  };
}

export async function searchCards(ctx: Ctx, f: CardFilters & { detail?: "summary" | "full" }) {
  if (f.detail === "full") return listCards(ctx, { ...f, limit: f.limit ?? 25 });
  const r = await query(ctx, f, 25);
  const colors = await labelColorOverrides(ctx);
  return {
    cards: r.rows.map((row) => {
      const labels = parseJson<string[]>(row.labels, []);
      return {
        id: row.id as string,
        ref: `#${row.number}`,
        title: row.title as string,
        board_id: row.board_id as string,
        board_name: row.board_name as string,
        column_id: row.column_id as string,
        status: row.column_name as string,
        labels: labels.map((l) => ({ name: l, ...labelColor(l, colors) })),
        priority: row.priority as string,
        assignee: (row.assignee as string | null) ?? null,
        due_on: (row.due_on as string | null) ?? null,
        completed: row.completed_at != null,
        archived: row.archived_at != null,
        pending_reviews: row.pending_reviews as number,
        updated_at: row.updated_at as string,
      };
    }),
    total: r.total,
    has_more: r.has_more,
    next_offset: r.next_offset,
  };
}

// ---------------------------------------------------------------- labels

const LABEL_COLORS_KEY = "label_colors";

/** Custom hues set with update_label, keyed by lower-cased label name. */
async function labelColorOverrides(ctx: Ctx): Promise<Record<string, number>> {
  const row = await ctx.db.prepare(`SELECT value FROM settings WHERE key = ?`).bind(LABEL_COLORS_KEY).first<{ value: string }>();
  return parseJson<Record<string, number>>(row?.value, {});
}

function hslHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return "#" + [f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, "0")).join("");
}

/**
 * Deterministic display colour for a label (stable across clients), unless overridden.
 * `color`/`text_color` are a light pair (≥ 7:1 contrast); `dark_color`/`dark_text_color` suit dark themes.
 */
export function labelColor(name: string, overrides: Record<string, number> = {}) {
  const key = name.trim().toLowerCase();
  let hue = overrides[key];
  if (hue === undefined) {
    let h = 2166136261;
    for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
    hue = (h >>> 0) % 360;
  }
  return {
    hue,
    color: hslHex(hue, 70, 91),
    text_color: hslHex(hue, 65, 24),
    dark_color: hslHex(hue, 35, 24),
    dark_text_color: hslHex(hue, 80, 85),
    custom: overrides[key] !== undefined,
  };
}

export async function listLabels(ctx: Ctx, input: { board_id?: string; include_archived?: boolean }) {
  const where: string[] = [];
  const args: unknown[] = [];
  if (input.board_id) where.push(`c.board_id = ?`), args.push(input.board_id);
  if (!input.include_archived) where.push(`c.archived_at IS NULL`);
  const { results } = await ctx.db
    .prepare(
      `SELECT j.value AS name, COUNT(*) AS n FROM cards c, json_each(c.labels) j ${where.length ? "WHERE " + where.join(" AND ") : ""}
       GROUP BY lower(j.value) ORDER BY n DESC, lower(j.value)`,
    )
    .bind(...args)
    .all<{ name: string; n: number }>();
  const overrides = await labelColorOverrides(ctx);
  return { labels: results.map((r) => ({ name: r.name, count: r.n, ...labelColor(r.name, overrides) })) };
}

/**
 * Rename (or merge) a label on every card that has it, and/or set its display hue.
 * Each affected card gets its own history event, so the change is reviewable and revertible.
 */
export async function updateLabel(ctx: Ctx, input: { name: string; rename_to?: string; hue?: number | null; board_id?: string; reason?: string }) {
  const name = input.name.trim();
  if (!name) throw badRequest("name is required");
  const out: { name: string; cards_updated: number; hue?: number | null } = { name: input.rename_to?.trim() || name, cards_updated: 0 };

  if (input.rename_to !== undefined) {
    const target = input.rename_to.trim();
    if (!target) throw badRequest("rename_to cannot be empty");
    const where = [`EXISTS (SELECT 1 FROM json_each(labels) j WHERE lower(j.value) = lower(?))`];
    const args: unknown[] = [name];
    if (input.board_id) where.push(`board_id = ?`), args.push(input.board_id);
    const { results } = await ctx.db.prepare(`SELECT * FROM cards WHERE ${where.join(" AND ")} LIMIT 500`).bind(...args).all<any>();
    for (const row of results) {
      const labels = parseJson<string[]>(row.labels, []);
      const seen = new Set<string>();
      const next: string[] = [];
      for (const l of labels.map((l) => (l.toLowerCase() === name.toLowerCase() ? target : l))) {
        if (!seen.has(l.toLowerCase())) seen.add(l.toLowerCase()), next.push(l);
      }
      if (JSON.stringify(next) === JSON.stringify(labels)) continue;
      const fresh = await getCardRow(ctx, row.id);
      await writeCard(ctx, fresh, { ...fresh, labels: JSON.stringify(next) }, { action: "update", reason: input.reason ?? `Renamed label "${name}" to "${target}"` });
      out.cards_updated++;
    }
  }

  if (input.hue !== undefined) {
    const overrides = await labelColorOverrides(ctx);
    const key = out.name.toLowerCase();
    if (input.hue === null) delete overrides[key];
    else overrides[key] = ((Math.round(input.hue) % 360) + 360) % 360;
    await ctx.db
      .prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .bind(LABEL_COLORS_KEY, JSON.stringify(overrides), nowIso())
      .run();
    out.hue = input.hue;
  }
  return { ...out, ...labelColor(out.name, await labelColorOverrides(ctx)) };
}
