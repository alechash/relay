import type { Ctx } from "../context";
import { ApiError } from "../lib/errors";
import { nowIso } from "../lib/util";
import { createCard, getCardRow, moveCard, resolveTargetColumn, updateCard, type CreateCardInput, type UpdateCardInput } from "./cards";

/**
 * Batches are validated up front: every item's target board/column/card and expected_version is
 * checked before anything is written. With atomic=true (default) a single invalid item rejects the
 * whole batch with per-item errors and nothing changes. With atomic=false valid items are applied and
 * invalid ones are reported. Either way every item gets a result in input order; nothing is dropped.
 *
 * Items are then applied one by one (each with its own history event). If something changes
 * between validation and apply (a concurrent edit), that item's failure is reported in its result.
 */

export const MAX_BATCH = 50;

type ItemResult = { index: number; ok: true; card: any; client_ref?: string } | { index: number; ok: false; error: { code: string; message: string }; client_ref?: string };

const errOf = (e: unknown) =>
  e instanceof ApiError ? { code: e.code, message: e.message } : { code: "internal_error", message: "Unexpected error" };

async function withIdempotency<T>(ctx: Ctx, key: string | undefined, run: () => Promise<T>): Promise<T> {
  if (!key) return run();
  const prior = await ctx.db
    .prepare(`SELECT response FROM idempotency_keys WHERE actor_id = ? AND key = ?`)
    .bind(ctx.actor.id, key)
    .first<{ response: string }>();
  if (prior) return { ...JSON.parse(prior.response), replayed: true };
  const result = await run();
  await ctx.db
    .prepare(`INSERT OR IGNORE INTO idempotency_keys (actor_id, key, response, created_at) VALUES (?, ?, ?, ?)`)
    .bind(ctx.actor.id, key, JSON.stringify(result), nowIso())
    .run();
  return result;
}

function summarize(results: ItemResult[], atomic: boolean, applied: boolean) {
  const failed = results.filter((r) => !r.ok).length;
  return { atomic, applied, succeeded: results.length - failed, failed, results };
}

export interface BatchCreateItem extends Omit<CreateCardInput, "reason"> {
  client_ref?: string;
}

export async function batchCreateCards(
  ctx: Ctx,
  input: { board_id?: string; column?: string; cards: BatchCreateItem[]; atomic?: boolean; idempotency_key?: string; reason?: string },
) {
  const atomic = input.atomic !== false;
  return withIdempotency(ctx, input.idempotency_key, async () => {
    const items = input.cards.map((c) => ({ ...c, board_id: c.board_id ?? input.board_id, column: c.column ?? (c.column_id ? undefined : input.column) }));
    // 1. validate every target
    const pre: (ItemResult | null)[] = await Promise.all(
      items.map(async (item, index) => {
        try {
          const col = await resolveTargetColumn(ctx, item);
          if (col.archived_at) throw new ApiError("bad_request", `Column '${col.name}' is archived`);
          if (item.board_id && col.board_id !== item.board_id) throw new ApiError("bad_request", "column_id belongs to a different board");
          return null;
        } catch (e) {
          return { index, ok: false as const, error: errOf(e), client_ref: item.client_ref };
        }
      }),
    );
    if (atomic && pre.some(Boolean)) {
      const results = pre.map((r, index) => r ?? { index, ok: false as const, error: { code: "not_applied", message: "Batch rejected because another item is invalid" }, client_ref: items[index].client_ref });
      return summarize(results, atomic, false);
    }
    // 2. apply
    const results: ItemResult[] = [];
    for (const [index, item] of items.entries()) {
      if (pre[index]) {
        results.push(pre[index]!);
        continue;
      }
      try {
        const { client_ref, ...rest } = item;
        const card = await createCard(ctx, { ...rest, reason: input.reason });
        results.push({ index, ok: true, card: compact(card), client_ref });
      } catch (e) {
        results.push({ index, ok: false, error: errOf(e), client_ref: item.client_ref });
      }
    }
    return summarize(results, atomic, true);
  });
}

export interface BatchUpdateItem extends Omit<UpdateCardInput, "reason"> {
  column_id?: string;
  column?: string;
  position?: number;
  client_ref?: string;
}

export async function batchUpdateCards(ctx: Ctx, input: { updates: BatchUpdateItem[]; atomic?: boolean; idempotency_key?: string; reason?: string }) {
  const atomic = input.atomic !== false;
  return withIdempotency(ctx, input.idempotency_key, async () => {
    const seen = new Map<string, number>();
    const pre: (ItemResult | null)[] = await Promise.all(
      input.updates.map(async (u, index) => {
        try {
          const row = await getCardRow(ctx, u.card_id);
          if (seen.has(row.id)) throw new ApiError("bad_request", `Card ${u.card_id} appears more than once in this batch (also item ${seen.get(row.id)})`);
          seen.set(row.id, index);
          if (u.expected_version !== undefined && u.expected_version !== row.version) {
            throw new ApiError("conflict", `Card ${u.card_id} was modified (version ${row.version}, expected ${u.expected_version})`);
          }
          if (u.column_id || u.column) {
            const col = await resolveTargetColumn(ctx, { column_id: u.column_id, column: u.column, board_id: row.board_id });
            if (col.archived_at) throw new ApiError("bad_request", `Column '${col.name}' is archived`);
          }
          return null;
        } catch (e) {
          return { index, ok: false as const, error: errOf(e), client_ref: u.client_ref };
        }
      }),
    );
    if (atomic && pre.some(Boolean)) {
      const results = pre.map((r, index) => r ?? { index, ok: false as const, error: { code: "not_applied", message: "Batch rejected because another item is invalid" }, client_ref: input.updates[index].client_ref });
      return summarize(results, atomic, false);
    }
    const results: ItemResult[] = [];
    for (const [index, u] of input.updates.entries()) {
      if (pre[index]) {
        results.push(pre[index]!);
        continue;
      }
      try {
        const { client_ref, column_id, column, position, expected_version, ...fields } = u;
        const hasFields = Object.keys(fields).some((k) => k !== "card_id" && (fields as any)[k] !== undefined);
        let card: any;
        let version = expected_version;
        if (hasFields) {
          card = await updateCard(ctx, { ...fields, expected_version: version, reason: input.reason });
          version = undefined; // already checked
        }
        if (column_id || column || position !== undefined) {
          card = await moveCard(ctx, { card_id: u.card_id, column_id, column, position, expected_version: version, reason: input.reason });
        }
        if (!card) throw new ApiError("bad_request", "Nothing to change");
        results.push({ index, ok: true, card: compact(card), client_ref });
      } catch (e) {
        results.push({ index, ok: false, error: errOf(e), client_ref: u.client_ref });
      }
    }
    return summarize(results, atomic, true);
  });
}

function compact(card: any) {
  return {
    id: card.id,
    ref: card.ref,
    title: card.title,
    board_id: card.board_id,
    column_id: card.column_id,
    status: card.column_name ?? null,
    labels: card.labels,
    due_on: card.due_on,
    version: card.version,
  };
}
