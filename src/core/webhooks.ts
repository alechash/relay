import type { Actor, Ctx } from "../context";
import type { Env } from "../env";
import { ApiError, badRequest, notFound } from "../lib/errors";
import { hmacHex, newId, nowIso, parseJson, randomToken, safeEqual } from "../lib/util";
import { getBoardRow } from "./boards";
import { addComment, createCard, getCardRow, moveCard, resolveTargetColumn } from "./cards";

/**
 * Webhooks, three kinds sharing one table and one delivery log:
 *
 * - inbound  (#40): POST /hooks/{id} creates a card. Auth: HMAC signature (X-Relay-Signature +
 *   X-Relay-Timestamp, ±5 min) or `Authorization: Bearer <secret>`. Idempotent per delivery id.
 * - outbound (#41): when a card enters a trigger column, POST a signed, versioned payload to a URL.
 *   One delivery per (webhook, event); retried with backoff by the cron trigger; dead after 6 tries.
 * - github   (#39): POST /hooks/{id} receives GitHub pull_request / pull_request_review events
 *   (X-Hub-Signature-256), links PRs to cards referenced as relay-123, and optionally moves them.
 */

export type WebhookKind = "inbound" | "outbound" | "github";

export interface InboundConfig {
  column?: string;
  labels?: string[];
  requires_review?: boolean;
}
export interface OutboundConfig {
  url: string;
  columns: string[];
}
export interface GithubConfig {
  repos?: string[];
  on_open?: string | null;
  on_ready_for_review?: string | null;
  on_review_approved?: string | null;
  on_changes_requested?: string | null;
  on_merge?: string | null;
  on_close?: string | null;
  comment?: boolean;
  requires_review?: boolean;
}

const SECRET_PREFIX = "whsec_";
const MAX_INBOUND_BYTES = 64 * 1024;
const REPLAY_WINDOW_S = 300;
const RETRY_DELAYS_S = [60, 300, 1800, 7200, 43200];
const MAX_ATTEMPTS = RETRY_DELAYS_S.length + 1;

export function webhookOut(r: any, origin?: string) {
  const config = parseJson<Record<string, unknown>>(r.config, {});
  return {
    id: r.id as string,
    kind: r.kind as WebhookKind,
    name: r.name as string,
    board_id: (r.board_id as string | null) ?? null,
    config,
    endpoint: r.kind === "outbound" ? null : `${origin ?? ""}/hooks/${r.id}`,
    secret_hint: `${SECRET_PREFIX}…${String(r.secret).slice(-4)}`,
    active: !r.revoked_at,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
    revoked_at: (r.revoked_at as string | null) ?? null,
  };
}

function deliveryOut(r: any) {
  return {
    id: r.id as string,
    webhook_id: r.webhook_id as string,
    direction: r.direction as "in" | "out",
    external_id: (r.external_id as string | null) ?? null,
    event_type: (r.event_type as string | null) ?? null,
    status: r.status as string,
    attempts: r.attempts as number,
    next_attempt_at: (r.next_attempt_at as string | null) ?? null,
    last_error: (r.last_error as string | null) ?? null,
    response_status: (r.response_status as number | null) ?? null,
    result: parseJson<unknown>(r.result, null),
    payload: parseJson<unknown>(r.payload, null),
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

async function getHookRow(db: D1Database, id: string) {
  const row = await db.prepare(`SELECT * FROM webhooks WHERE id = ?`).bind(id).first<any>();
  if (!row) throw notFound("Webhook", id);
  return row;
}

function validateConfig(kind: WebhookKind, config: any): Record<string, unknown> {
  config = config ?? {};
  if (kind === "outbound") {
    let url: URL;
    try {
      url = new URL(String(config.url ?? ""));
    } catch {
      throw badRequest("Outbound webhooks need config.url (an https:// URL)");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw badRequest("config.url must be http(s)");
    const columns = (Array.isArray(config.columns) ? config.columns : []).map((c: unknown) => String(c).trim()).filter(Boolean);
    if (!columns.length) throw badRequest("Outbound webhooks need config.columns: the column names (or ids) that trigger a dispatch, e.g. [\"Ready for Dev\"]");
    return { url: url.toString(), columns };
  }
  if (kind === "inbound") {
    return {
      column: config.column ? String(config.column) : undefined,
      labels: Array.isArray(config.labels) ? config.labels.map(String) : undefined,
      requires_review: !!config.requires_review,
    };
  }
  const col = (v: unknown) => (v == null || v === "" ? null : String(v));
  return {
    repos: Array.isArray(config.repos) ? config.repos.map((r: unknown) => String(r).toLowerCase()) : undefined,
    on_open: col(config.on_open),
    on_ready_for_review: col(config.on_ready_for_review),
    on_review_approved: col(config.on_review_approved),
    on_changes_requested: col(config.on_changes_requested),
    on_merge: col(config.on_merge),
    on_close: col(config.on_close),
    comment: config.comment !== false,
    requires_review: !!config.requires_review,
  };
}

// ---------------------------------------------------------------- management (human-only ops)

export async function listWebhooks(ctx: Ctx, origin: string, input: { include_revoked?: boolean }) {
  const { results } = await ctx.db
    .prepare(
      `SELECT w.*,
        (SELECT COUNT(*) FROM webhook_deliveries d WHERE d.webhook_id = w.id AND d.status IN ('failed', 'dead', 'rejected')) AS failures,
        (SELECT MAX(d.created_at) FROM webhook_deliveries d WHERE d.webhook_id = w.id) AS last_delivery_at
       FROM webhooks w ${input.include_revoked ? "" : "WHERE w.revoked_at IS NULL"} ORDER BY w.created_at DESC`,
    )
    .all<any>();
  return { webhooks: results.map((r) => ({ ...webhookOut(r, origin), failures: r.failures as number, last_delivery_at: r.last_delivery_at ?? null })) };
}

export async function createWebhook(ctx: Ctx, origin: string, input: { kind: WebhookKind; name: string; board_id?: string | null; config?: unknown }) {
  if (input.board_id) await getBoardRow(ctx, input.board_id);
  if (input.kind === "inbound" && !input.board_id) throw badRequest("Inbound webhooks need board_id (the board new cards go to)");
  const config = validateConfig(input.kind, input.config);
  if (input.kind === "inbound" && config.column) await resolveTargetColumn(ctx, { board_id: input.board_id!, column: String(config.column) });
  const now = nowIso();
  const row = {
    id: newId("whk"),
    kind: input.kind,
    name: input.name,
    board_id: input.board_id ?? null,
    secret: SECRET_PREFIX + randomToken(24),
    config: JSON.stringify(config),
    created_at: now,
    updated_at: now,
    revoked_at: null,
  };
  await ctx.db
    .prepare(`INSERT INTO webhooks (id, kind, name, board_id, secret, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(row.id, row.kind, row.name, row.board_id, row.secret, row.config, now, now)
    .run();
  outboundCache = null;
  return { ...webhookOut(row, origin), secret: row.secret };
}

export async function updateWebhook(ctx: Ctx, origin: string, input: { webhook_id: string; name?: string; board_id?: string | null; config?: unknown; active?: boolean; rotate_secret?: boolean }) {
  const row = await getHookRow(ctx.db, input.webhook_id);
  const next = { ...row };
  if (input.name !== undefined) next.name = input.name;
  if (input.board_id !== undefined) {
    if (input.board_id) await getBoardRow(ctx, input.board_id);
    next.board_id = input.board_id;
  }
  if (input.config !== undefined) next.config = JSON.stringify(validateConfig(row.kind, { ...parseJson(row.config, {}), ...(input.config as object) }));
  if (input.active !== undefined) next.revoked_at = input.active ? null : (row.revoked_at ?? nowIso());
  if (input.rotate_secret) next.secret = SECRET_PREFIX + randomToken(24);
  next.updated_at = nowIso();
  await ctx.db
    .prepare(`UPDATE webhooks SET name = ?, board_id = ?, config = ?, secret = ?, revoked_at = ?, updated_at = ? WHERE id = ?`)
    .bind(next.name, next.board_id, next.config, next.secret, next.revoked_at, next.updated_at, row.id)
    .run();
  outboundCache = null;
  return { ...webhookOut(next, origin), ...(input.rotate_secret ? { secret: next.secret } : {}) };
}

export async function listDeliveries(ctx: Ctx, input: { webhook_id?: string; status?: string; limit?: number; before?: string }) {
  const where: string[] = [];
  const args: unknown[] = [];
  if (input.webhook_id) where.push(`webhook_id = ?`), args.push(input.webhook_id);
  if (input.status) where.push(`status = ?`), args.push(input.status);
  if (input.before) where.push(`created_at < ?`), args.push(input.before);
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const { results } = await ctx.db
    .prepare(`SELECT * FROM webhook_deliveries ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT ?`)
    .bind(...args, limit)
    .all();
  return { deliveries: results.map(deliveryOut) };
}

export async function retryDelivery(ctx: Ctx, input: { delivery_id: string }) {
  const d = await ctx.db.prepare(`SELECT * FROM webhook_deliveries WHERE id = ?`).bind(input.delivery_id).first<any>();
  if (!d) throw notFound("Delivery", input.delivery_id);
  if (d.direction !== "out") throw badRequest("Only outbound deliveries can be retried; ask the sender to redeliver inbound ones");
  await ctx.db.prepare(`UPDATE webhook_deliveries SET status = 'pending', next_attempt_at = ?, updated_at = ? WHERE id = ?`).bind(nowIso(), nowIso(), d.id).run();
  await attemptDelivery(ctx.env, d.id);
  return deliveryOut(await ctx.db.prepare(`SELECT * FROM webhook_deliveries WHERE id = ?`).bind(d.id).first());
}

// ---------------------------------------------------------------- outbound dispatch (#41)

let outboundCache: { at: number; hooks: any[] } | null = null;

async function activeOutbound(db: D1Database) {
  if (outboundCache && Date.now() - outboundCache.at < 30_000) return outboundCache.hooks;
  const { results } = await db.prepare(`SELECT * FROM webhooks WHERE kind = 'outbound' AND revoked_at IS NULL`).all<any>();
  outboundCache = { at: Date.now(), hooks: results };
  return results;
}

/**
 * Called after every successful card create/move. Dispatches only on a transition INTO a trigger
 * column (created there, or moved from a different column), never on unrelated edits. Deliveries
 * are unique per (webhook, event), so the same transition is never sent twice.
 */
export async function dispatchCardTransition(
  ctx: Ctx,
  ev: { eventId: string; action: string; before: any | null; after: any },
): Promise<void> {
  const entered = ev.after && (!ev.before || ev.before.column_id !== ev.after.column_id);
  if (!entered) return;
  const hooks = await activeOutbound(ctx.db);
  if (!hooks.length) return;
  const col = await ctx.db
    .prepare(`SELECT c.id, c.name, b.id AS board_id, b.name AS board_name FROM columns c JOIN boards b ON b.id = c.board_id WHERE c.id = ?`)
    .bind(ev.after.column_id)
    .first<any>();
  if (!col) return;
  const matching = hooks.filter((h) => {
    if (h.board_id && h.board_id !== col.board_id) return false;
    const cfg = parseJson<OutboundConfig>(h.config, { url: "", columns: [] });
    return cfg.columns.some((c) => c === col.id || c.toLowerCase() === String(col.name).toLowerCase());
  });
  if (!matching.length) return;
  const now = nowIso();
  const payload = {
    version: 1,
    type: "card.entered_column",
    event_id: ev.eventId,
    occurred_at: now,
    actor: { id: ctx.actor.id, name: ctx.actor.name, kind: ctx.actor.kind },
    board: { id: col.board_id, name: col.board_name },
    column: { id: col.id, name: col.name },
    from_column_id: ev.before?.column_id ?? null,
    card: {
      id: ev.after.id,
      ref: ev.after.ref,
      number: ev.after.number,
      title: ev.after.title,
      description: ev.after.description,
      labels: ev.after.labels,
      priority: ev.after.priority,
      assignee: ev.after.assignee,
      due_on: ev.after.due_on,
      version: ev.after.version,
      url: null as string | null,
    },
  };
  const ids: string[] = [];
  for (const h of matching) {
    const id = newId("dlv");
    const res = await ctx.db
      .prepare(
        `INSERT OR IGNORE INTO webhook_deliveries (id, webhook_id, direction, external_id, event_type, status, attempts, next_attempt_at, payload, created_at, updated_at)
         VALUES (?, ?, 'out', ?, ?, 'pending', 0, ?, ?, ?, ?)`,
      )
      .bind(id, h.id, ev.eventId, payload.type, now, JSON.stringify({ ...payload, delivery_id: id, webhook_id: h.id }), now, now)
      .run();
    if (res.meta.changes) ids.push(id);
  }
  ctx.waitUntil(Promise.all(ids.map((id) => attemptDelivery(ctx.env, id).catch((e) => console.error("delivery failed", e)))));
}

/** Sends one outbound delivery. On failure schedules a retry (backoff) or marks it dead. */
export async function attemptDelivery(env: Env, deliveryId: string): Promise<void> {
  const db = env.DB;
  const d = await db.prepare(`SELECT * FROM webhook_deliveries WHERE id = ?`).bind(deliveryId).first<any>();
  if (!d || d.status !== "pending") return;
  const hook = await db.prepare(`SELECT * FROM webhooks WHERE id = ?`).bind(d.webhook_id).first<any>();
  const now = nowIso();
  if (!hook || hook.revoked_at) {
    await db.prepare(`UPDATE webhook_deliveries SET status = 'dead', last_error = ?, updated_at = ? WHERE id = ?`).bind("Webhook disabled", now, d.id).run();
    return;
  }
  // Claim the attempt so concurrent cron runs don't double-send.
  const claim = await db
    .prepare(`UPDATE webhook_deliveries SET attempts = attempts + 1, next_attempt_at = NULL, updated_at = ? WHERE id = ? AND status = 'pending' AND attempts = ?`)
    .bind(now, d.id, d.attempts)
    .run();
  if (!claim.meta.changes) return;
  const attempts = d.attempts + 1;
  const cfg = parseJson<OutboundConfig>(hook.config, { url: "", columns: [] });
  const ts = Math.floor(Date.now() / 1000).toString();
  const body = d.payload as string;
  let status: number | null = null;
  let error: string | null = null;
  try {
    const res = await fetch(cfg.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Relay-Webhooks/1",
        "X-Relay-Event": d.event_type ?? "card.entered_column",
        "X-Relay-Event-Id": d.external_id ?? "",
        "X-Relay-Delivery": d.id,
        "X-Relay-Timestamp": ts,
        "X-Relay-Signature": `sha256=${await hmacHex(hook.secret, `${ts}.${body}`)}`,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    status = res.status;
    if (!res.ok) error = `HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`;
  } catch (e: any) {
    error = e?.name === "TimeoutError" ? "Timed out after 10s" : String(e?.message ?? e).slice(0, 300);
  }
  const done = nowIso();
  if (!error) {
    await db.prepare(`UPDATE webhook_deliveries SET status = 'delivered', response_status = ?, last_error = NULL, updated_at = ? WHERE id = ?`).bind(status, done, d.id).run();
    return;
  }
  // 4xx (other than 408/429) are permanent: retrying won't help.
  const permanent = status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429;
  if (permanent || attempts >= MAX_ATTEMPTS) {
    await db
      .prepare(`UPDATE webhook_deliveries SET status = 'dead', response_status = ?, last_error = ?, updated_at = ? WHERE id = ?`)
      .bind(status, error, done, d.id)
      .run();
    return;
  }
  const next = new Date(Date.now() + RETRY_DELAYS_S[attempts - 1] * 1000).toISOString();
  await db
    .prepare(`UPDATE webhook_deliveries SET status = 'pending', response_status = ?, last_error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?`)
    .bind(status, error, next, done, d.id)
    .run();
}

/** Cron: retry due outbound deliveries and prune old bookkeeping. */
export async function runScheduled(env: Env): Promise<void> {
  const db = env.DB;
  const { results } = await db
    .prepare(`SELECT id FROM webhook_deliveries WHERE direction = 'out' AND status = 'pending' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 25`)
    .bind(nowIso())
    .all<{ id: string }>();
  await Promise.all(results.map((r) => attemptDelivery(env, r.id).catch((e) => console.error("retry failed", e))));
  const monthAgo = new Date(Date.now() - 30 * 86400_000).toISOString();
  const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString();
  await db.batch([
    db.prepare(`DELETE FROM webhook_deliveries WHERE created_at < ? AND status IN ('delivered', 'processed', 'ignored', 'duplicate')`).bind(monthAgo),
    db.prepare(`DELETE FROM idempotency_keys WHERE created_at < ?`).bind(weekAgo),
  ]);
}

// ---------------------------------------------------------------- receiving (#40 inbound, #39 GitHub)

function hookActor(hook: any, label: string, requiresReview: boolean): Actor {
  return { id: hook.id, name: `${label}: ${hook.name}`, kind: "agent", scope: "write", requiresReview };
}

async function recordInbound(db: D1Database, hook: any, externalId: string | null, eventType: string, status: string, payload: string, result: unknown, error?: string) {
  const now = nowIso();
  await db
    .prepare(
      `INSERT OR IGNORE INTO webhook_deliveries (id, webhook_id, direction, external_id, event_type, status, attempts, payload, result, last_error, created_at, updated_at)
       VALUES (?, ?, 'in', ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    )
    .bind(newId("dlv"), hook.id, externalId, eventType, status, payload.slice(0, 20000), JSON.stringify(result ?? null), error ?? null, now, now)
    .run();
}

const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export async function handleHook(req: Request, env: Env, exec: ExecutionContext, hookId: string): Promise<Response> {
  if (req.method !== "POST") return respond(405, { error: { code: "bad_request", message: "POST only" } });
  const hook = await env.DB.prepare(`SELECT * FROM webhooks WHERE id = ?`).bind(hookId).first<any>();
  // Same answer for unknown and disabled hooks, so ids can't be probed.
  if (!hook || hook.revoked_at || hook.kind === "outbound") return respond(404, { error: { code: "not_found", message: "Unknown webhook" } });
  const len = Number(req.headers.get("Content-Length") ?? 0);
  if (len > MAX_INBOUND_BYTES) return respond(413, { error: { code: "bad_request", message: "Payload too large (64 KB max)" } });
  const raw = await req.text();
  if (raw.length > MAX_INBOUND_BYTES) return respond(413, { error: { code: "bad_request", message: "Payload too large (64 KB max)" } });

  const ctxFor = (actor: Actor, client: string | null): Ctx => ({
    env,
    db: env.DB,
    actor,
    via: "api",
    client,
    sessionId: `hook:${hook.id}`,
    waitUntil: (p) => exec.waitUntil(p),
    requestId: req.headers.get("cf-ray") ?? crypto.randomUUID(),
  });

  try {
    if (hook.kind === "github") return await handleGithub(req, env, hook, raw, ctxFor);
    return await handleInbound(req, env, hook, raw, ctxFor);
  } catch (err) {
    const e = err instanceof ApiError ? err : null;
    if (!e) console.error("hook error", err);
    return respond(e?.status ?? 500, { error: { code: e?.code ?? "internal_error", message: e?.message ?? "Internal error" } });
  }
}

async function verifyRelaySignature(req: Request, secret: string, raw: string): Promise<string | null> {
  const auth = req.headers.get("Authorization");
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    return m && safeEqual(m[1].trim(), secret) ? null : "Invalid bearer secret";
  }
  const sig = req.headers.get("X-Relay-Signature") ?? "";
  const ts = req.headers.get("X-Relay-Timestamp") ?? "";
  if (!sig || !ts) return "Missing X-Relay-Signature / X-Relay-Timestamp (or Authorization: Bearer <secret>)";
  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > REPLAY_WINDOW_S) return "Timestamp outside the 5 minute window";
  const expected = `sha256=${await hmacHex(secret, `${ts}.${raw}`)}`;
  return safeEqual(sig.trim(), expected) ? null : "Invalid signature";
}

async function handleInbound(req: Request, env: Env, hook: any, raw: string, ctxFor: (a: Actor, c: string | null) => Ctx) {
  const authError = await verifyRelaySignature(req, hook.secret, raw);
  if (authError) {
    await recordInbound(env.DB, hook, null, "card.create", "rejected", "", null, authError);
    return respond(401, { error: { code: "unauthorized", message: authError } });
  }
  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    return respond(400, { error: { code: "bad_request", message: "Body must be JSON" } });
  }
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : undefined);
  const title = str(body?.title, 500);
  if (!title) return respond(422, { error: { code: "validation_error", message: "title is required" } });
  const deliveryId = str(req.headers.get("X-Relay-Delivery") ?? body.delivery_id ?? body.idempotency_key, 200) ?? null;

  // Claim the delivery id atomically so concurrent retries can't create two cards.
  let claimId: string | null = null;
  if (deliveryId) {
    claimId = newId("dlv");
    const now = nowIso();
    const claim = await env.DB
      .prepare(
        `INSERT OR IGNORE INTO webhook_deliveries (id, webhook_id, direction, external_id, event_type, status, attempts, payload, created_at, updated_at)
         VALUES (?, ?, 'in', ?, 'card.create', 'processing', 1, ?, ?, ?)`,
      )
      .bind(claimId, hook.id, deliveryId, raw.slice(0, 20000), now, now)
      .run();
    if (!claim.meta.changes) {
      const prior = await env.DB.prepare(`SELECT * FROM webhook_deliveries WHERE webhook_id = ? AND external_id = ?`).bind(hook.id, deliveryId).first<any>();
      if (prior?.status === "processed") return respond(200, { ...parseJson(prior.result, {}), duplicate: true });
      return respond(409, { error: { code: "conflict", message: "This delivery id is already being processed" } });
    }
  }

  const cfg = parseJson<InboundConfig>(hook.config, {});
  const source = str(body.source, 100);
  const tagList = [...(Array.isArray(body.tags) ? body.tags : []), ...(Array.isArray(body.labels) ? body.labels : []), ...(cfg.labels ?? [])]
    .filter((t: unknown) => typeof t === "string")
    .map((t: string) => t.trim().slice(0, 64))
    .filter(Boolean)
    .slice(0, 20);
  const priority = ["none", "low", "medium", "high", "urgent"].includes(body.priority) ? body.priority : undefined;
  const due = typeof body.due_on === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.due_on) ? body.due_on : undefined;
  let description = str(body.description, 50000) ?? "";
  if (source) description = `${description}${description ? "\n\n" : ""}_Source: ${source}_`;

  const ctx = ctxFor(hookActor(hook, "Webhook", !!cfg.requires_review), source ?? "webhook");
  let card;
  try {
    card = await createCard(ctx, {
    board_id: hook.board_id,
    column: str(body.column, 100) ?? cfg.column,
    title,
    description,
    labels: tagList,
    priority,
    due_on: due,
    reason: `Created by inbound webhook "${hook.name}"${source ? ` from ${source}` : ""}`,
    });
  } catch (err) {
    // Release the claim so the sender can retry with the same delivery id.
    if (claimId) await env.DB.prepare(`DELETE FROM webhook_deliveries WHERE id = ?`).bind(claimId).run();
    throw err;
  }
  const result = { card: { id: card.id, ref: card.ref, number: card.number, board_id: card.board_id, column: card.column_name } };
  if (claimId) {
    await env.DB
      .prepare(`UPDATE webhook_deliveries SET status = 'processed', result = ?, updated_at = ? WHERE id = ?`)
      .bind(JSON.stringify(result), nowIso(), claimId)
      .run();
  } else {
    await recordInbound(env.DB, hook, null, "card.create", "processed", raw, result);
  }
  return respond(201, result);
}

// ---------------------------------------------------------------- GitHub (#39)

const REF_PATTERN = /\brelay[-_ ]?#?(\d{1,7})\b/gi;

export function findCardRefs(...texts: (string | null | undefined)[]): number[] {
  const out = new Set<number>();
  for (const t of texts) for (const m of (t ?? "").matchAll(REF_PATTERN)) out.add(Number(m[1]));
  return [...out];
}

async function handleGithub(req: Request, env: Env, hook: any, raw: string, ctxFor: (a: Actor, c: string | null) => Ctx) {
  const sig = req.headers.get("X-Hub-Signature-256") ?? "";
  const expected = `sha256=${await hmacHex(hook.secret, raw)}`;
  if (!sig || !safeEqual(sig.trim(), expected)) {
    await recordInbound(env.DB, hook, null, req.headers.get("X-GitHub-Event") ?? "unknown", "rejected", "", null, "Invalid X-Hub-Signature-256");
    return respond(401, { error: { code: "unauthorized", message: "Invalid X-Hub-Signature-256" } });
  }
  const event = req.headers.get("X-GitHub-Event") ?? "";
  const deliveryId = req.headers.get("X-GitHub-Delivery");
  if (deliveryId) {
    const prior = await env.DB.prepare(`SELECT status, result FROM webhook_deliveries WHERE webhook_id = ? AND external_id = ?`).bind(hook.id, deliveryId).first<any>();
    if (prior) return respond(200, { duplicate: true, result: parseJson(prior.result, null) });
  }
  if (event === "ping") {
    await recordInbound(env.DB, hook, deliveryId, event, "processed", "", { pong: true });
    return respond(200, { ok: true, pong: true });
  }
  if (event !== "pull_request" && event !== "pull_request_review") {
    await recordInbound(env.DB, hook, deliveryId, event, "ignored", "", { reason: "event not handled" });
    return respond(202, { ignored: true, reason: `Event '${event}' is not handled` });
  }

  const body = JSON.parse(raw);
  const pr = body.pull_request;
  const repo = String(body.repository?.full_name ?? "").toLowerCase();
  const cfg = parseJson<GithubConfig>(hook.config, {});
  if (cfg.repos?.length && !cfg.repos.includes(repo)) {
    await recordInbound(env.DB, hook, deliveryId, event, "ignored", "", { reason: `repo ${repo} not in allowlist` });
    return respond(202, { ignored: true, reason: "Repository not in this webhook's allowlist" });
  }

  // Decide what happened and which column (if any) it maps to.
  let what: string | null = null;
  let target: string | null | undefined;
  if (event === "pull_request") {
    const a = body.action;
    if (a === "opened" || a === "reopened") (what = a), (target = pr.draft ? null : cfg.on_open);
    else if (a === "ready_for_review") (what = "ready for review"), (target = cfg.on_ready_for_review ?? cfg.on_open);
    else if (a === "closed" && pr.merged) (what = "merged"), (target = cfg.on_merge);
    else if (a === "closed") (what = "closed without merging"), (target = cfg.on_close);
    else if (a === "edited") (what = "edited"), (target = null);
  } else if (body.action === "submitted") {
    const state = String(body.review?.state ?? "").toLowerCase();
    if (state === "approved") (what = "approved"), (target = cfg.on_review_approved);
    else if (state === "changes_requested") (what = "changes requested"), (target = cfg.on_changes_requested);
    else (what = `reviewed (${state || "commented"})`), (target = null);
  }
  if (!what) {
    await recordInbound(env.DB, hook, deliveryId, `${event}.${body.action}`, "ignored", "", { reason: "action not handled" });
    return respond(202, { ignored: true });
  }

  const numbers = findCardRefs(pr.head?.ref, pr.title, pr.body);
  const results: { ref: string; linked: boolean; moved_to: string | null; error?: string }[] = [];
  const ctx = ctxFor(hookActor(hook, "GitHub", !!cfg.requires_review), "github");
  for (const n of numbers.slice(0, 10)) {
    try {
      const card = await getCardRow(ctx, String(n));
      if (hook.board_id && card.board_id !== hook.board_id) {
        results.push({ ref: `#${n}`, linked: false, moved_to: null, error: "Card is on a different board than this webhook" });
        continue;
      }
      const prLabel = `${repo}#${pr.number}`;
      let linked = false;
      if (cfg.comment !== false) {
        // One comment per PR state change; 'edited' only links a PR the first time it references the card.
        const already = await ctx.db
          .prepare(`SELECT 1 FROM comments WHERE card_id = ? AND body LIKE ? AND deleted_at IS NULL LIMIT 1`)
          .bind(card.id, `%${pr.html_url}%`)
          .first();
        if (what !== "edited" || !already) {
          const reviewer = event === "pull_request_review" ? ` by @${body.review?.user?.login ?? "unknown"}` : "";
          await addComment(ctx, {
            card_id: card.id,
            body: `**PR ${what}${reviewer}:** [${prLabel}](${pr.html_url}) ${pr.title ? `· ${pr.title}` : ""}\n\nBranch \`${pr.head?.ref ?? "?"}\` · state \`${pr.merged ? "merged" : pr.state}\``,
            reason: `GitHub ${event}.${body.action} for ${prLabel}`,
          });
          linked = true;
        }
      }
      let movedTo: string | null = null;
      if (target) {
        const col = await resolveTargetColumn(ctx, { board_id: card.board_id, column: target });
        if (col.id !== card.column_id) {
          await moveCard(ctx, { card_id: card.id, column_id: col.id, reason: `PR ${prLabel} ${what}` });
          movedTo = col.name;
        }
      }
      results.push({ ref: `#${n}`, linked, moved_to: movedTo });
    } catch (err) {
      results.push({ ref: `#${n}`, linked: false, moved_to: null, error: err instanceof ApiError ? err.message : "error" });
    }
  }
  const result = { event: `${event}.${body.action}`, pr: `${repo}#${pr.number}`, matched: numbers.map((n) => `#${n}`), results };
  await recordInbound(env.DB, hook, deliveryId, `${event}.${body.action}`, numbers.length ? "processed" : "ignored", JSON.stringify({ pr: pr.html_url, action: body.action }), result);
  return respond(200, result);
}
