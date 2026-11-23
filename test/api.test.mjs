// End-to-end tests against a real local Worker (wrangler dev + local D1).
// Run with: npm test
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

const ADMIN = "test-admin-token-0123456789";
const PORT = 8900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
let proc;
let persistDir;

before(async () => {
  persistDir = mkdtempSync(join(tmpdir(), "relay-test-"));
  proc = spawn(
    "npx",
    ["wrangler", "dev", "--port", String(PORT), "--ip", "127.0.0.1", "--persist-to", persistDir, "--var", `ADMIN_TOKEN:${ADMIN}`, "--show-interactive-dev-session=false"],
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" }, detached: true },
  );
  let log = "";
  proc.stdout.on("data", (d) => (log += d));
  proc.stderr.on("data", (d) => (log += d));
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("wrangler dev did not start:\n" + log);
});

after(() => {
  try {
    process.kill(-proc.pid, "SIGTERM"); // whole group: npx → wrangler → workerd
  } catch {}
  proc?.stdout.destroy();
  proc?.stderr.destroy();
  try {
    rmSync(persistDir, { recursive: true, force: true });
  } catch {}
});

async function call(method, path, { token = ADMIN, body, headers = {} } = {}) {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}
const ok = async (...args) => {
  const r = await call(...args);
  assert.ok(r.status < 300, `${args[0]} ${args[1]} → ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
};

async function mcp(token, message, sessionId) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    },
    body: JSON.stringify(message),
  });
  const text = await res.text();
  return { status: res.status, session: res.headers.get("Mcp-Session-Id"), data: text ? JSON.parse(text) : null };
}

describe("relay", () => {
  let board;
  let agentToken;
  let agentId;
  let readToken;
  const col = (name) => board.columns.find((c) => c.name === name).id;

  test("rejects unauthenticated and wrong tokens", async () => {
    assert.equal((await call("GET", "/boards", { token: null })).status, 401);
    assert.equal((await call("GET", "/boards", { token: "nope" })).status, 401);
    assert.equal((await call("GET", "/boards", { token: "rly_doesnotexist" })).status, 401);
  });

  test("owner creates a board with default columns", async () => {
    board = await ok("POST", "/boards", { body: { name: "Everything" } });
    assert.deepEqual(
      board.columns.map((c) => [c.name, c.is_done]),
      [["Backlog", false], ["To do", false], ["Doing", false], ["Done", true]],
    );
  });

  test("validation errors are 422 with a readable message", async () => {
    const r = await call("POST", "/cards", { body: { board_id: board.id, title: "" } });
    assert.equal(r.status, 422);
    assert.match(r.data.error.message, /title/);
  });

  test("tokens: create agent + read-only tokens; secret shown once", async () => {
    const a = await ok("POST", "/tokens", { body: { name: "Test Agent", kind: "agent" } });
    assert.ok(a.token.startsWith("rly_"));
    assert.equal(a.requires_review, true);
    agentToken = a.token;
    agentId = a.id;
    const r = await ok("POST", "/tokens", { body: { name: "Reader", kind: "human", scope: "read" } });
    readToken = r.token;
    const list = await ok("GET", "/tokens");
    assert.ok(list.tokens.every((t) => !("token" in t) && !("token_hash" in t)));
  });

  test("read-only token can read but not write", async () => {
    await ok("GET", "/boards", { token: readToken });
    const r = await call("POST", "/cards", { token: readToken, body: { board_id: board.id, title: "x" } });
    assert.equal(r.status, 403);
  });

  test("agent changes are applied immediately and queued for sign-off", async () => {
    const card = await ok("POST", "/cards", {
      token: agentToken,
      headers: { "X-Relay-Session": "run-1" },
      body: { board_id: board.id, column: "to do", title: "Renew passport", labels: ["admin", "Admin", " errands "], reason: "Found in inbox" },
    });
    assert.equal(card.number, 1);
    assert.equal(card.column_id, col("To do"));
    assert.deepEqual(card.labels, ["admin", "errands"]);
    assert.equal(card.created_by.kind, "agent");
    assert.equal(card.pending_reviews, 1);

    const reviews = await ok("GET", "/reviews");
    assert.equal(reviews.pending_count, 1);
    assert.equal(reviews.groups[0].session_id, "run-1");
    assert.equal(reviews.events[0].reason, "Found in inbox");
    assert.equal(reviews.events[0].card.ref, "#1");
  });

  test("agents cannot sign off or manage tokens", async () => {
    assert.equal((await call("POST", "/reviews/approve", { token: agentToken, body: { all: true } })).status, 403);
    assert.equal((await call("GET", "/tokens", { token: agentToken })).status, 403);
    assert.equal((await call("POST", "/events/x/revert", { token: agentToken })).status, 403);
  });

  test("card refs, optimistic concurrency, and done tracking", async () => {
    const c = await ok("GET", "/cards/%231");
    assert.equal(c.title, "Renew passport");
    const moved = await ok("POST", "/cards/1/move", { token: agentToken, body: { column: "Done", reason: "finished" } });
    assert.ok(moved.completed_at);
    const stale = await call("PATCH", "/cards/1", { token: agentToken, body: { title: "x", expected_version: c.version } });
    assert.equal(stale.status, 409);
    const back = await ok("POST", "/cards/1/move", { token: agentToken, body: { column_id: col("Doing") } });
    assert.equal(back.completed_at, null);
  });

  test("ordering by index within a column", async () => {
    const todo = col("To do");
    const a = await ok("POST", "/cards", { body: { column_id: todo, title: "A" } });
    const b = await ok("POST", "/cards", { body: { column_id: todo, title: "B" } });
    const c = await ok("POST", "/cards", { body: { column_id: todo, title: "C", position: 0 } });
    await ok("POST", `/cards/${a.id}/move`, { body: { position: 2 } });
    const full = await ok("GET", `/boards/${board.id}`);
    assert.deepEqual(full.columns.find((x) => x.id === todo).cards.map((x) => x.title), ["C", "B", "A"]);
    assert.ok(b && c);
  });

  test("search and filters", async () => {
    await ok("PATCH", "/cards/2", { body: { add_labels: ["home"], priority: "high", due_on: "2026-01-01" } });
    assert.equal((await ok("GET", "/cards?label=home")).cards.length, 1);
    assert.equal((await ok("GET", "/cards?q=passport")).cards[0].ref, "#1");
    assert.equal((await ok("GET", "/cards?priority=high")).cards[0].ref, "#2");
    assert.ok((await ok("GET", "/cards?needs_review=true")).cards.every((c) => c.pending_reviews > 0));
    assert.equal((await ok("GET", "/cards?due_before=2026-06-01")).cards[0].ref, "#2");
    const page = await ok("GET", "/cards?limit=2&sort=number");
    assert.equal(page.cards.length, 2);
    assert.equal(page.has_more, true);
    assert.equal(page.next_offset, 2);
  });

  test("reject reverts an agent edit; approve signs off", async () => {
    await ok("PATCH", "/cards/1", { token: agentToken, body: { title: "Renew passport!!!", priority: "urgent", reason: "seemed urgent" } });
    const pending = await ok("GET", `/events?card_id=%231&review_status=pending`);
    const edit = pending.events.find((e) => e.action === "update");
    assert.deepEqual(edit.changes.sort(), ["priority", "title"]);

    const rej = await ok("POST", "/reviews/reject", { body: { event_ids: [edit.id], note: "no" } });
    assert.equal(rej.rejected, 1);
    assert.equal(rej.revert_errors.length, 0);
    const card = await ok("GET", "/cards/1");
    assert.equal(card.title, "Renew passport");
    assert.equal(card.priority, "none");

    const ev = await ok("GET", `/events/${edit.id}`);
    assert.equal(ev.review.status, "rejected");
    assert.equal(ev.review.note, "no");
    assert.ok(ev.reverted_by);

    const appr = await ok("POST", "/reviews/approve", { body: { actor_id: agentId } });
    assert.ok(appr.approved >= 3);
    assert.equal((await ok("GET", "/reviews")).pending_count, 0);
  });

  test("revert refuses to clobber later edits unless forced", async () => {
    const original = (await ok("GET", "/cards/2")).title;
    await ok("PATCH", "/cards/2", { body: { title: "B v2" } });
    const first = (await ok("GET", "/events?card_id=2&limit=1")).events[0];
    await ok("PATCH", "/cards/2", { body: { title: "B v3" } });
    const r = await call("POST", `/events/${first.id}/revert`, { body: {} });
    assert.equal(r.status, 409);
    await ok("POST", `/events/${first.id}/revert`, { body: { force: true } });
    assert.equal((await ok("GET", "/cards/2")).title, original);
    const again = await call("POST", `/events/${first.id}/revert`, { body: { force: true } });
    assert.equal(again.status, 409);
  });

  test("full card history with before/after snapshots", async () => {
    await ok("POST", "/cards/1/comments", { body: { body: "Booked appointment" } });
    const h = await ok("GET", "/cards/1/history");
    const actions = h.events.map((e) => `${e.entity_type}.${e.action}`);
    assert.deepEqual(actions.slice(0, 2), ["card.create", "card.move"]);
    assert.ok(actions.includes("card.revert"));
    assert.ok(actions.includes("comment.create"));
    assert.ok(h.events.every((e) => e.actor && e.created_at));
    assert.equal(h.refs.columns[col("Done")], "Done");
  });

  test("archiving a column with cards requires a destination", async () => {
    const extra = await ok("POST", `/boards/${board.id}/columns`, { body: { name: "Waiting", position: 2 } });
    await ok("POST", "/cards", { body: { column_id: extra.id, title: "Hear back from landlord" } });
    assert.equal((await call("PATCH", `/columns/${extra.id}`, { body: { archived: true } })).status, 409);
    await ok("PATCH", `/columns/${extra.id}`, { body: { archived: true, move_cards_to: col("Backlog") } });
    const full = await ok("GET", `/boards/${board.id}`);
    assert.ok(!full.columns.some((c) => c.id === extra.id));
    assert.ok(full.columns.find((c) => c.name === "Backlog").cards.some((c) => c.title === "Hear back from landlord"));
  });

  test("archive and restore cards; nothing is hard-deleted", async () => {
    await ok("PATCH", "/cards/3", { body: { archived: true } });
    assert.ok(!(await ok("GET", "/cards")).cards.some((c) => c.number === 3));
    assert.ok((await ok("GET", "/cards?archived=true")).cards.some((c) => c.number === 3));
    const restored = await ok("PATCH", "/cards/3", { body: { archived: false } });
    assert.equal(restored.archived, false);
  });

  test("events pagination and tailing", async () => {
    const p1 = await ok("GET", "/events?limit=3");
    assert.equal(p1.events.length, 3);
    const p2 = await ok("GET", `/events?limit=3&before_seq=${p1.next_before_seq}`);
    assert.ok(p2.events[0].seq < p1.events[2].seq);
    const tail = await ok("GET", `/events?after_seq=${p2.events[0].seq}`);
    assert.ok(tail.events.every((e, i, a) => i === 0 || e.seq > a[i - 1].seq));
  });

  test("web session: login cookie, CSRF guard on writes", async () => {
    const bad = await call("POST", "/auth/login", { token: null, body: { token: "wrong" } });
    assert.equal(bad.status, 401);
    const login = await call("POST", "/auth/login", { token: null, body: { token: ADMIN } });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    assert.equal((await call("GET", "/me", { token: null, headers: { Cookie: cookie } })).data.via, "web");
    const noHeader = await call("POST", "/cards", { token: null, headers: { Cookie: cookie }, body: { board_id: board.id, title: "x" } });
    assert.equal(noHeader.status, 403);
    const withHeader = await call("POST", "/cards", { token: null, headers: { Cookie: cookie, "X-Relay-Client": "web" }, body: { board_id: board.id, title: "From web" } });
    assert.equal(withHeader.status, 201);
  });

  test("MCP: initialize, list tools, call tools with attribution", async () => {
    const init = await mcp(agentToken, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-client", version: "9.9" } } });
    assert.equal(init.status, 200);
    assert.equal(init.data.result.protocolVersion, "2025-06-18");
    assert.ok(init.session?.startsWith("mcp_"));
    const sid = init.session;

    assert.equal((await mcp(agentToken, { jsonrpc: "2.0", method: "notifications/initialized" }, sid)).status, 202);

    const tools = (await mcp(agentToken, { jsonrpc: "2.0", id: 2, method: "tools/list" }, sid)).data.result.tools;
    const names = tools.map((t) => t.name);
    assert.ok(names.includes("create_card") && names.includes("move_card"));
    assert.ok(!names.includes("approve_changes"), "agents should not see human-only tools");
    assert.equal(tools.find((t) => t.name === "list_boards").annotations.readOnlyHint, true);

    const res = await mcp(agentToken, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "create_card", arguments: { board_id: board.id, title: "Via MCP", reason: "test" } } }, sid);
    assert.equal(res.data.result.isError, false);
    const card = res.data.result.structuredContent;
    assert.equal(card.title, "Via MCP");

    const ev = (await ok("GET", `/events?card_id=${card.id}`)).events[0];
    assert.equal(ev.via, "mcp");
    assert.equal(ev.client, "test-client/9.9");
    assert.equal(ev.session_id, sid.split(".")[0]);
    assert.equal(ev.review.status, "pending");

    const bad = await mcp(agentToken, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_card", arguments: { card_id: "#99999" } } }, sid);
    assert.equal(bad.data.result.isError, true);
    assert.match(bad.data.result.content[0].text, /not_found/);

    const unknown = await mcp(agentToken, { jsonrpc: "2.0", id: 5, method: "nope" }, sid);
    assert.equal(unknown.data.error.code, -32601);

    const unauth = await mcp("rly_bad", { jsonrpc: "2.0", id: 6, method: "tools/list" });
    assert.equal(unauth.status, 401);
  });

  test("parity: every REST operation is an MCP tool and vice versa", async () => {
    const spec = (await call("GET", "/openapi.json", { token: null })).data;
    const restOps = new Set();
    for (const methods of Object.values(spec.paths)) for (const op of Object.values(methods)) restOps.add(op.operationId);
    restOps.delete("login");
    restOps.delete("logout");
    const init = await mcp(ADMIN, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const tools = (await mcp(ADMIN, { jsonrpc: "2.0", id: 2, method: "tools/list" }, init.session)).data.result.tools.map((t) => t.name);
    assert.deepEqual([...restOps].sort(), [...tools].sort());
  });

  test("export includes everything", async () => {
    const dump = await ok("GET", "/export?include_events=true");
    assert.ok(dump.boards.length >= 1);
    assert.ok(dump.cards.some((c) => c.archived === false));
    assert.ok(dump.events.length > 10);
  });

  test("revoked tokens stop working", async () => {
    await ok("DELETE", `/tokens/${agentId}`);
    assert.equal((await call("GET", "/me", { token: agentToken })).status, 401);
  });
});
