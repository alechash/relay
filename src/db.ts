/**
 * Schema migrations. Applied automatically by the Worker on the first request
 * each isolate handles, so a fresh deploy (Deploy button or `wrangler deploy`)
 * needs no separate migration step.
 *
 * Rules for adding a migration: append a new entry with the next id. Never edit
 * an existing one. Each migration runs inside a single D1 batch (a transaction).
 */
const MIGRATIONS: { id: number; name: string; statements: string[] }[] = [
  {
    id: 1,
    name: "init",
    statements: [
      `CREATE TABLE IF NOT EXISTS boards (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        position REAL NOT NULL,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1
      )`,
      `CREATE TABLE IF NOT EXISTS columns (
        id TEXT PRIMARY KEY,
        board_id TEXT NOT NULL REFERENCES boards(id),
        name TEXT NOT NULL,
        position REAL NOT NULL,
        wip_limit INTEGER,
        is_done INTEGER NOT NULL DEFAULT 0,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1
      )`,
      `CREATE INDEX IF NOT EXISTS idx_columns_board ON columns(board_id, position)`,
      `CREATE TABLE IF NOT EXISTS cards (
        id TEXT PRIMARY KEY,
        number INTEGER NOT NULL UNIQUE,
        board_id TEXT NOT NULL REFERENCES boards(id),
        column_id TEXT NOT NULL REFERENCES columns(id),
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        labels TEXT NOT NULL DEFAULT '[]',
        priority TEXT NOT NULL DEFAULT 'none',
        assignee TEXT,
        due_on TEXT,
        position REAL NOT NULL,
        archived_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        created_by_id TEXT NOT NULL,
        created_by_name TEXT NOT NULL,
        created_by_kind TEXT NOT NULL,
        updated_by_id TEXT NOT NULL,
        updated_by_name TEXT NOT NULL,
        updated_by_kind TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1
      )`,
      `CREATE INDEX IF NOT EXISTS idx_cards_column ON cards(column_id, position)`,
      `CREATE INDEX IF NOT EXISTS idx_cards_board ON cards(board_id, updated_at)`,
      `CREATE INDEX IF NOT EXISTS idx_cards_updated ON cards(updated_at)`,
      `CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        card_id TEXT NOT NULL REFERENCES cards(id),
        body TEXT NOT NULL,
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_kind TEXT NOT NULL,
        created_at TEXT NOT NULL,
        deleted_at TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_comments_card ON comments(card_id, created_at)`,
      `CREATE TABLE IF NOT EXISTS tokens (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        scope TEXT NOT NULL,
        requires_review INTEGER NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        token_prefix TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        actor_name TEXT NOT NULL,
        actor_kind TEXT NOT NULL,
        via TEXT NOT NULL,
        client TEXT,
        session_id TEXT,
        reason TEXT,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        board_id TEXT,
        card_id TEXT,
        action TEXT NOT NULL,
        before TEXT,
        after TEXT,
        changes TEXT NOT NULL DEFAULT '[]',
        review_status TEXT NOT NULL DEFAULT 'none',
        reviewed_at TEXT,
        reviewed_by_id TEXT,
        reviewed_by_name TEXT,
        review_note TEXT,
        reverted_by TEXT,
        revert_of TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_events_card ON events(card_id, seq)`,
      `CREATE INDEX IF NOT EXISTS idx_events_board ON events(board_id, seq)`,
      `CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entity_id, seq)`,
      `CREATE INDEX IF NOT EXISTS idx_events_review ON events(review_status, seq)`,
      `CREATE INDEX IF NOT EXISTS idx_events_actor ON events(actor_id, seq)`,
      `CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, seq)`,
    ],
  },
  {
    id: 2,
    name: "settings",
    statements: [
      // Key/value settings. `admin_token_sha256` holds the hash of an admin token as an
      // alternative to the ADMIN_TOKEN Worker secret (useful when only D1 access is available).
      `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    ],
  },
  {
    id: 3,
    name: "search_indexes",
    statements: [
      `CREATE INDEX IF NOT EXISTS idx_cards_due ON cards(due_on) WHERE due_on IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_cards_number ON cards(number)`,
    ],
  },
  {
    id: 4,
    name: "idempotency_keys",
    statements: [
      `CREATE TABLE IF NOT EXISTS idempotency_keys (actor_id TEXT NOT NULL, key TEXT NOT NULL, response TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (actor_id, key))`,
    ],
  },
  {
    id: 5,
    name: "review_policies",
    statements: [
      `ALTER TABLE boards ADD COLUMN agent_auto_approve TEXT NOT NULL DEFAULT '[]'`,
      `ALTER TABLE tokens ADD COLUMN can_skip_review INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE events ADD COLUMN request_id TEXT`,
    ],
  },
  {
    id: 6,
    name: "webhooks",
    statements: [
      `CREATE TABLE IF NOT EXISTS webhooks (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        board_id TEXT,
        secret TEXT NOT NULL,
        config TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revoked_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id TEXT PRIMARY KEY,
        webhook_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        external_id TEXT,
        event_type TEXT,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        last_error TEXT,
        response_status INTEGER,
        payload TEXT,
        result TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_external ON webhook_deliveries(webhook_id, external_id) WHERE external_id IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_deliveries_due ON webhook_deliveries(status, next_attempt_at)`,
      `CREATE INDEX IF NOT EXISTS idx_deliveries_hook ON webhook_deliveries(webhook_id, created_at)`,
    ],
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].id;

let ready: Promise<void> | null = null;

export function ensureSchema(db: D1Database): Promise<void> {
  if (!ready) {
    ready = migrate(db).catch((err) => {
      ready = null; // retry on the next request
      throw err;
    });
  }
  return ready;
}

async function migrate(db: D1Database): Promise<void> {
  await db
    .prepare(`CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`)
    .run();
  const row = await db.prepare(`SELECT COALESCE(MAX(id), 0) AS v FROM _migrations`).first<{ v: number }>();
  const current = row?.v ?? 0;
  for (const m of MIGRATIONS) {
    if (m.id <= current) continue;
    await db.batch([
      ...m.statements.map((s) => db.prepare(s)),
      db.prepare(`INSERT OR IGNORE INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)`).bind(m.id, m.name, new Date().toISOString()),
    ]);
  }
}
