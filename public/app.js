// Relay web UI. Talks to the public REST API only (/api/v1), exactly like any
// other client: nothing here has privileged access.

// ------------------------------------------------------------------ helpers

const ICONS = {
  logo: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="4" width="5" height="16" rx="1.5" fill="currentColor"/><rect x="10" y="4" width="5" height="10" rx="1.5" fill="currentColor" opacity=".65"/><rect x="17" y="4" width="4" height="6" rx="1.5" fill="var(--color-agent)"/></svg>',
  bot: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="2.5" y="5" width="11" height="8" rx="2"/><path d="M8 5V2.5M6 9h0M10 9h0" stroke-linecap="round"/></svg>',
  person: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="8" cy="5.5" r="2.5"/><path d="M3 13.5c.8-2.4 2.7-3.5 5-3.5s4.2 1.1 5 3.5" stroke-linecap="round"/></svg>',
  dots: '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><circle cx="3.5" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.5" cy="8" r="1.3"/></svg>',
  plus: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke-linecap="round"/></svg>',
  close: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke-linecap="round"/></svg>',
  board: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="2" y="2.5" width="3.5" height="11" rx="1"/><rect x="6.75" y="2.5" width="3.5" height="7" rx="1"/><rect x="11.5" y="2.5" width="2.5" height="4.5" rx="1"/></svg>',
  check: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 8.5l3 3 7-7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  clock: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="8" cy="8" r="5.75"/><path d="M8 4.75V8l2.25 1.5" stroke-linecap="round"/></svg>',
  gear: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="8" cy="8" r="2"/><path d="M8 1.75v1.5M8 12.75v1.5M14.25 8h-1.5M3.25 8h-1.5M12.4 3.6l-1.06 1.06M4.66 11.34L3.6 12.4M12.4 12.4l-1.06-1.06M4.66 4.66L3.6 3.6" stroke-linecap="round"/></svg>',
  comment: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 3.5h10v7H7l-3 2.5v-2.5H3z" stroke-linejoin="round"/></svg>',
};

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k === "value") value = v;
    else if (k === "checked" || k === "disabled" || k === "selected") el[k] = !!v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  append(el, children);
  if (value !== undefined) el.value = value;
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
const icon = (name) => h("span", { html: ICONS[name], style: "display:inline-flex" });
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function timeAgo(iso) {
  if (!iso) return "";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: s > 86400 * 300 ? "numeric" : undefined });
}
const timeEl = (iso) => h("time", { datetime: iso, title: new Date(iso).toLocaleString() }, timeAgo(iso));

function fmtDue(d) {
  if (!d) return "";
  const date = new Date(d + "T00:00:00");
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((date - today) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
const isOverdue = (card) => card.due_on && !card.completed_at && card.due_on < new Date().toISOString().slice(0, 10);

function toast(message, opts = {}) {
  const root = document.getElementById("toasts");
  const el = h("div", { class: "toast" + (opts.error ? " error" : "") }, h("span", {}, message), opts.action ? h("button", { onclick: () => { opts.action.run(); el.remove(); } }, opts.action.label) : null);
  root.append(el);
  setTimeout(() => el.remove(), opts.error ? 6000 : 3500);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied");
  } catch {
    toast("Copy failed. Select the text and copy it manually.", { error: true });
  }
}

// ------------------------------------------------------------------ API client

class ApiError extends Error {
  constructor(status, err) {
    super(err?.message || `Request failed (${status})`);
    this.status = status;
    this.code = err?.code;
    this.details = err?.details;
  }
}

async function api(method, path, body) {
  const res = await fetch("/api/v1" + path, {
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-Relay-Client": "web" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith("/auth/")) {
    navigate("/login");
    throw new ApiError(401, data.error);
  }
  if (!res.ok) throw new ApiError(res.status, data.error);
  return data;
}
const qs = (o) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? "?" + s : "";
};

function fail(err) {
  if (err?.status === 401) return;
  console.error(err);
  toast(err?.message || "Something went wrong", { error: true });
}

// ------------------------------------------------------------------ state + router

const state = {
  me: null,
  boards: [],
  board: null,
  showArchived: false,
  filter: "",
  pending: 0,
  lastSeq: 0,
  addingIn: null,
  drag: null,
  card: null,
  cardTab: "comments",
  dirty: false,
};

function navigate(path, { replace = false } = {}) {
  if (location.pathname + location.search !== path) history[replace ? "replaceState" : "pushState"](null, "", path);
  route();
}
window.addEventListener("popstate", () => route());
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-link]");
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  navigate(a.getAttribute("href"));
});

async function route() {
  const path = location.pathname;
  const params = new URLSearchParams(location.search);
  closeMenu();
  if (path === "/login") return renderLogin();
  if (!state.me) {
    try {
      state.me = await api("GET", "/me");
    } catch (err) {
      if (err.status === 503) return renderNotConfigured(err.message);
      if (err.status !== 401) fail(err);
      return;
    }
    await Promise.all([refreshBoards(), refreshPending(), initSeq()]).catch(fail);
    startPolling();
  }
  let m;
  if ((m = /^\/b\/([^/]+)$/.exec(path))) return showBoard(decodeURIComponent(m[1]), params.get("card"));
  if ((m = /^\/c\/([^/]+)$/.exec(path))) {
    try {
      const card = await api("GET", `/cards/${encodeURIComponent(m[1])}`);
      return navigate(`/b/${card.board_id}?card=${card.number}`, { replace: true });
    } catch (err) {
      fail(err);
      return navigate("/", { replace: true });
    }
  }
  if (path === "/review") return showReview();
  if (path === "/activity") return showActivity();
  if (path === "/settings") return showSettings();
  // home: last board or first board
  const last = localGet("relay:lastBoard");
  const target = state.boards.find((b) => b.id === last) || state.boards[0];
  if (target) return navigate(`/b/${target.id}`, { replace: true });
  return showWelcome();
}

function localGet(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}
function localSet(k, v) {
  try { localStorage.setItem(k, v); } catch { /* private mode */ }
}

async function refreshBoards() {
  state.boards = (await api("GET", "/boards")).boards;
}
async function refreshPending() {
  const r = await api("GET", "/reviews?limit=1");
  state.pending = r.pending_count;
  const badge = document.querySelector("[data-pending]");
  if (badge) {
    badge.textContent = String(state.pending);
    badge.hidden = state.pending === 0;
  }
}
async function initSeq() {
  const r = await api("GET", "/events?limit=1");
  state.lastSeq = r.events[0]?.seq ?? 0;
}

// Poll for changes made elsewhere (agents, other devices) and refresh quietly.
let pollTimer = null;
function startPolling() {
  if (pollTimer) return;
  const tick = async () => {
    if (document.visibilityState !== "visible" || !state.me) return;
    try {
      const r = await api("GET", `/events${qs({ after_seq: state.lastSeq, limit: 200 })}`);
      if (r.events.length) {
        state.lastSeq = r.events[r.events.length - 1].seq;
        state.dirty = true;
        await refreshPending();
      }
      if (state.dirty && !isBusy()) {
        state.dirty = false;
        await softRefresh();
      }
    } catch {
      /* offline; try later */
    }
  };
  pollTimer = setInterval(tick, 10000);
  document.addEventListener("visibilitychange", tick);
}
function isBusy() {
  const a = document.activeElement;
  return !!state.drag || !!document.querySelector(".menu, dialog[open]") || (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
}
async function softRefresh() {
  const p = location.pathname;
  if (p.startsWith("/b/") && state.board) {
    await loadBoard(state.board.id);
    renderLanes();
    if (state.card) await reloadCard();
  } else if (p === "/review") await showReview();
  else if (p === "/activity") await showActivity();
}

// ------------------------------------------------------------------ shell

function shell(active, ...content) {
  const app = document.getElementById("app");
  const current = state.board ?? state.boards.find((b) => b.id === localGet("relay:lastBoard")) ?? null;
  const boardSelect = h(
    "select",
    {
      class: "select board-switch",
      "aria-label": "Board",
      onchange: async (e) => {
        if (e.target.value === "__new") {
          e.target.value = current?.id ?? "";
          return newBoard();
        }
        navigate(`/b/${e.target.value}`);
      },
    },
    !current ? h("option", { value: "" }, "Boards…") : null,
    state.boards.map((b) => h("option", { value: b.id, selected: current?.id === b.id }, b.name)),
    h("option", { value: "__new" }, "+ New board"),
  );
  const nav = (href, label, key, ic, extra) =>
    h("a", { href, "data-link": true, "aria-label": label, title: label, "aria-current": active === key ? "page" : null }, h("span", { class: "nav-icon", html: ICONS[ic] }), h("span", { class: "nav-label" }, label), extra);
  app.replaceChildren(
    h(
      "header",
      { class: "topbar" },
      h("a", { class: "brand", href: "/", "data-link": true, html: ICONS.logo + "<span>Relay</span>" }),
      boardSelect,
      h(
        "nav",
        { class: "nav", "aria-label": "Main" },
        nav(current ? `/b/${current.id}` : "/", "Board", "board", "board"),
        nav("/review", "Sign-off", "review", "check", h("span", { class: "count", "data-pending": true, hidden: state.pending === 0, title: "Changes awaiting sign-off" }, String(state.pending))),
        nav("/activity", "Activity", "activity", "clock"),
        nav("/settings", "Settings", "settings", "gear"),
      ),
    ),
    h("main", { id: "main" }, ...content),
    h("div", { id: "drawer-root" }),
  );
}

function renderNotConfigured(message) {
  document.getElementById("app").replaceChildren(
    h("div", { class: "login" }, h("div", { class: "panel", style: "max-width:520px" }, h("h2", {}, "Relay needs one more step"), h("p", {}, message), h("p", { class: "muted small" }, "In the Cloudflare dashboard: Workers & Pages → relay → Settings → Variables and Secrets → Add → type Secret, name ADMIN_TOKEN. Build variables don't reach the running Worker. Then reload this page."), h("button", { class: "btn", onclick: () => location.reload() }, "Reload"))),
  );
}

function renderLogin() {
  const err = h("p", { class: "error-text", role: "alert" });
  const input = h("input", { class: "input", type: "password", id: "token", autocomplete: "current-password", required: true, placeholder: "ADMIN_TOKEN" });
  const btn = h("button", { class: "btn btn-primary", type: "submit" }, "Sign in");
  document.getElementById("app").replaceChildren(
    h(
      "div",
      { class: "login" },
      h(
        "form",
        {
          onsubmit: async (e) => {
            e.preventDefault();
            btn.setAttribute("aria-busy", "true");
            err.textContent = "";
            try {
              await api("POST", "/auth/login", { token: input.value });
              state.me = null;
              navigate("/");
            } catch (e2) {
              err.textContent = e2.status === 503 ? e2.message : "That token didn't work.";
              input.setAttribute("aria-invalid", "true");
              input.focus();
            } finally {
              btn.removeAttribute("aria-busy");
            }
          },
        },
        h("h1", { html: ICONS.logo + "Relay" }),
        h("label", { class: "field", for: "token" }, "Admin token", input),
        err,
        btn,
      ),
    ),
  );
  input.focus();
}

// ------------------------------------------------------------------ dialogs & menus

function dialog({ title, fields, submit = "Save", danger = false }) {
  return new Promise((resolve) => {
    const inputs = {};
    const body = fields.map((f) => {
      let input;
      if (f.type === "select") input = h("select", { class: "select", name: f.name }, f.options.map((o) => h("option", { value: o.value, selected: o.value === f.value }, o.label)));
      else if (f.type === "textarea") input = h("textarea", { class: "textarea", name: f.name, rows: 6 }, f.value ?? "");
      else if (f.type === "checkbox") input = h("input", { type: "checkbox", name: f.name, checked: !!f.value });
      else input = h("input", { class: "input", name: f.name, type: f.type || "text", value: f.value ?? "", placeholder: f.placeholder, required: f.required, min: f.min });
      inputs[f.name] = input;
      return f.type === "checkbox" ? h("label", { class: "check" }, input, f.label) : h("label", { class: "field" }, f.label, input);
    });
    const dlg = h(
      "dialog",
      { class: "panel", style: "width:min(440px, calc(100vw - 32px)); padding: var(--space-5); color: var(--color-ink); border-color: var(--color-rule-strong)" },
      h(
        "form",
        { method: "dialog", style: "display:grid; gap: var(--space-4)" },
        h("h2", {}, title),
        body,
        h("div", { style: "display:flex; gap: var(--space-2); justify-content:flex-end" }, h("button", { class: "btn", value: "cancel", type: "submit", formnovalidate: true }, "Cancel"), h("button", { class: "btn " + (danger ? "btn-danger" : "btn-primary"), value: "ok", type: "submit" }, submit)),
      ),
    );
    dlg.addEventListener("close", () => {
      const ok = dlg.returnValue === "ok";
      const out = {};
      for (const [k, el] of Object.entries(inputs)) out[k] = el.type === "checkbox" ? el.checked : el.value;
      dlg.remove();
      resolve(ok ? out : null);
    });
    document.body.append(dlg);
    dlg.showModal();
    const first = Object.values(inputs)[0];
    if (first && first.select) first.select();
  });
}
const confirmDialog = (title, submit = "Confirm", danger = true) => dialog({ title, fields: [], submit, danger });

let menuEl = null;
function closeMenu() {
  menuEl?.remove();
  menuEl = null;
}
function openMenu(anchor, items) {
  closeMenu();
  const r = anchor.getBoundingClientRect();
  menuEl = h(
    "div",
    { class: "menu", role: "menu" },
    items.map((it) =>
      it === "-" ? h("hr") : h("button", { role: "menuitem", class: it.danger ? "danger" : "", onclick: () => { closeMenu(); it.run(); } }, it.label),
    ),
  );
  document.body.append(menuEl);
  const w = menuEl.offsetWidth;
  menuEl.style.top = Math.min(r.bottom + 4, innerHeight - menuEl.offsetHeight - 8) + "px";
  menuEl.style.left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8)) + "px";
  menuEl.querySelector("button")?.focus();
  setTimeout(() => document.addEventListener("click", closeMenu, { once: true }), 0);
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (menuEl) return closeMenu();
    if (state.card && !document.querySelector("dialog[open]")) closeCard();
  }
});

// ------------------------------------------------------------------ boards

function showWelcome() {
  state.board = null;
  shell(
    "board",
    h(
      "div",
      { class: "page" },
      h("div", { class: "empty" }, h("h2", {}, "No boards yet"), h("p", {}, "A board holds columns of cards. Start with one for everything, and split it up later if you want."), h("button", { class: "btn btn-primary", onclick: newBoard }, "Create a board")),
    ),
  );
}

async function newBoard() {
  const v = await dialog({
    title: "New board",
    submit: "Create",
    fields: [
      { name: "name", label: "Name", required: true, placeholder: "Everything" },
      { name: "columns", label: "Columns (comma separated)", value: "Backlog, To do, Doing, Done" },
    ],
  });
  if (!v || !v.name.trim()) return;
  try {
    const cols = v.columns.split(",").map((s) => s.trim()).filter(Boolean);
    const b = await api("POST", "/boards", { name: v.name.trim(), columns: cols.length ? cols : undefined });
    await refreshBoards();
    navigate(`/b/${b.id}`);
  } catch (err) {
    fail(err);
  }
}

async function loadBoard(id) {
  const [board, labels] = await Promise.all([
    api("GET", `/boards/${id}${qs({ include_archived: state.showArchived ? "true" : "" })}`),
    api("GET", "/labels").catch(() => ({ labels: [] })),
  ]);
  state.board = board;
  state.labelColors = Object.fromEntries(labels.labels.map((l) => [l.name.toLowerCase(), l]));
}

// Label chip coloured with the API's display colours (light + dark pairs).
function labelChip(name) {
  const c = state.labelColors?.[name.toLowerCase()];
  const style = c ? `--lc:${c.color};--lt:${c.text_color};--lcd:${c.dark_color};--ltd:${c.dark_text_color}` : null;
  return h("span", { class: "label", style }, name);
}

async function showBoard(id, cardRef) {
  try {
    if (state.board?.id !== id || !document.querySelector(".lanes")) {
      await loadBoard(id);
      localSet("relay:lastBoard", id);
      renderBoardPage();
    }
    if (cardRef) await openCard(cardRef);
    else if (state.card) closeCard(false);
  } catch (err) {
    if (err.status === 404) {
      localSet("relay:lastBoard", "");
      await refreshBoards();
      return navigate("/", { replace: true });
    }
    fail(err);
  }
}

function renderBoardPage() {
  const b = state.board;
  document.title = `${b.name} · Relay`;
  const search = h("input", {
    class: "input",
    type: "search",
    placeholder: "Filter cards…",
    "aria-label": "Filter cards",
    value: state.filter,
    oninput: (e) => {
      state.filter = e.target.value;
      renderLanes();
    },
  });
  shell(
    "board",
    h(
      "div",
      { class: "board-head" },
      h("button", { class: "board-title", title: "Rename board", onclick: renameBoard }, b.name),
      b.archived ? h("span", { class: "status status-reverted" }, "Archived") : null,
      b.description ? h("span", { class: "muted small" }, b.description) : null,
      h(
        "div",
        { class: "board-tools" },
        search,
        h("button", { class: "btn btn-icon", "aria-label": "Board menu", html: ICONS.dots, onclick: (e) => { e.stopPropagation(); boardMenu(e.currentTarget); } }),
      ),
    ),
    h("div", { class: "lanes", id: "lanes" }),
  );
  renderLanes();
}

async function renameBoard() {
  const b = state.board;
  const v = await dialog({ title: "Board", fields: [{ name: "name", label: "Name", value: b.name, required: true }, { name: "description", label: "Description", type: "textarea", value: b.description }] });
  if (!v) return;
  try {
    await api("PATCH", `/boards/${b.id}`, { name: v.name.trim() || b.name, description: v.description, expected_version: b.version });
    await Promise.all([loadBoard(b.id), refreshBoards()]);
    renderBoardPage();
  } catch (err) {
    fail(err);
  }
}

function boardMenu(anchor) {
  const b = state.board;
  openMenu(anchor, [
    { label: "Rename / describe…", run: renameBoard },
    { label: "Add column…", run: addColumn },
    { label: state.showArchived ? "Hide archived" : "Show archived", run: async () => { state.showArchived = !state.showArchived; await loadBoard(b.id); renderLanes(); } },
    { label: "Board history", run: () => navigate(`/activity?board_id=${b.id}`) },
    "-",
    b.archived
      ? { label: "Restore board", run: () => setBoardArchived(false) }
      : { label: "Archive board", danger: true, run: () => setBoardArchived(true) },
  ]);
}

async function setBoardArchived(archived) {
  const b = state.board;
  if (archived && !(await confirmDialog(`Archive “${b.name}”? You can restore it later.`, "Archive"))) return;
  try {
    await api("PATCH", `/boards/${b.id}`, { archived });
    await refreshBoards();
    if (archived) {
      state.board = null;
      toast("Board archived", { action: { label: "Undo", run: async () => { await api("PATCH", `/boards/${b.id}`, { archived: false }); await refreshBoards(); navigate(`/b/${b.id}`); } } });
      navigate("/");
    } else {
      await loadBoard(b.id);
      renderBoardPage();
    }
  } catch (err) {
    fail(err);
  }
}

async function addColumn() {
  const v = await dialog({ title: "Add column", submit: "Add", fields: [{ name: "name", label: "Name", required: true }, { name: "is_done", type: "checkbox", label: "Cards here count as done" }] });
  if (!v || !v.name.trim()) return;
  try {
    await api("POST", `/boards/${state.board.id}/columns`, { name: v.name.trim(), is_done: v.is_done });
    await loadBoard(state.board.id);
    renderLanes();
  } catch (err) {
    fail(err);
  }
}

function matchesFilter(card) {
  const f = state.filter.trim().toLowerCase();
  if (!f) return true;
  return (
    card.title.toLowerCase().includes(f) ||
    card.ref === f ||
    card.labels.some((l) => l.toLowerCase().includes(f)) ||
    (card.assignee || "").toLowerCase().includes(f) ||
    card.description.toLowerCase().includes(f)
  );
}

function renderLanes() {
  const lanes = document.getElementById("lanes");
  if (!lanes || !state.board) return;
  const scroll = lanes.scrollLeft;
  const activeCols = state.board.columns.filter((c) => !c.archived);
  lanes.replaceChildren(
    ...state.board.columns.map((col) => renderLane(col, activeCols)),
    h("div", { class: "lane-new" }, h("button", { class: "btn btn-ghost lane-add", onclick: addColumn }, icon("plus"), "Add column")),
  );
  lanes.scrollLeft = scroll;
  const composer = lanes.querySelector(".composer textarea");
  if (composer) composer.focus();
}

function renderLane(col, activeCols) {
  const cards = col.cards.filter(matchesFilter);
  const active = col.cards.filter((c) => !c.archived).length;
  const over = col.wip_limit && active > col.wip_limit;
  const list = h("div", { class: "lane-cards", dataset: { col: col.id } }, cards.map(renderCardTile));
  if (!col.archived) wireDrop(list, col);
  const idx = activeCols.findIndex((c) => c.id === col.id);
  return h(
    "section",
    { class: "lane", "aria-label": col.name, dataset: { col: col.id }, style: col.archived ? "opacity:.6" : null },
    h(
      "div",
      { class: "lane-head" },
      h("h2", { class: "lane-name" }, col.name),
      h("span", { class: "lane-count" + (over ? " over" : ""), title: col.wip_limit ? `WIP limit ${col.wip_limit}` : null }, col.wip_limit ? `${active}/${col.wip_limit}` : String(active)),
      col.is_done ? h("span", { class: "lane-done", title: "Cards here count as done" }, "✓ done") : null,
      col.archived ? h("span", { class: "status status-reverted" }, "Archived") : null,
      h("button", { class: "btn btn-ghost btn-sm btn-icon", "aria-label": `Column menu for ${col.name}`, html: ICONS.dots, onclick: (e) => { e.stopPropagation(); columnMenu(e.currentTarget, col, idx, activeCols); } }),
    ),
    list,
    col.archived ? null : h("div", { class: "lane-foot" }, state.addingIn === col.id ? cardComposer(col) : h("button", { class: "btn btn-ghost btn-sm lane-add", onclick: () => { state.addingIn = col.id; renderLanes(); } }, icon("plus"), "Add card")),
  );
}

function cardComposer(col) {
  const ta = h("textarea", { class: "textarea", rows: 2, placeholder: "Card title. Enter to add, Esc to close.", "aria-label": `New card in ${col.name}` });
  const submit = async () => {
    const title = ta.value.trim();
    if (!title) return;
    ta.value = "";
    try {
      await api("POST", "/cards", { column_id: col.id, title });
      await loadBoard(state.board.id);
      renderLanes();
    } catch (err) {
      ta.value = title;
      fail(err);
    }
  };
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.stopPropagation();
      state.addingIn = null;
      renderLanes();
    }
  });
  return h("div", { class: "composer" }, ta, h("div", { class: "composer-actions" }, h("button", { class: "btn btn-primary btn-sm", onclick: submit }, "Add card"), h("button", { class: "btn btn-ghost btn-sm", onclick: () => { state.addingIn = null; renderLanes(); } }, "Cancel")));
}

function columnMenu(anchor, col, idx, activeCols) {
  const patch = async (body) => {
    try {
      await api("PATCH", `/columns/${col.id}`, body);
      await loadBoard(state.board.id);
      renderLanes();
    } catch (err) {
      fail(err);
    }
  };
  if (col.archived) return openMenu(anchor, [{ label: "Restore column", run: () => patch({ archived: false }) }]);
  openMenu(anchor, [
    { label: "Rename…", run: async () => { const v = await dialog({ title: "Rename column", fields: [{ name: "name", label: "Name", value: col.name, required: true }] }); if (v?.name.trim()) patch({ name: v.name.trim() }); } },
    { label: "WIP limit…", run: async () => { const v = await dialog({ title: "WIP limit", fields: [{ name: "limit", label: "Max active cards (blank for none)", type: "number", min: 1, value: col.wip_limit ?? "" }] }); if (v) patch({ wip_limit: v.limit ? Number(v.limit) : null }); } },
    { label: col.is_done ? "Don't count as done" : "Cards here count as done", run: () => patch({ is_done: !col.is_done }) },
    idx > 0 ? { label: "Move left", run: () => patch({ position: idx - 1 }) } : null,
    idx < activeCols.length - 1 ? { label: "Move right", run: () => patch({ position: idx + 1 }) } : null,
    "-",
    {
      label: "Archive column…",
      danger: true,
      run: async () => {
        const n = col.cards.filter((c) => !c.archived).length;
        if (n === 0) {
          if (await confirmDialog(`Archive column “${col.name}”?`, "Archive")) patch({ archived: true });
          return;
        }
        const others = activeCols.filter((c) => c.id !== col.id);
        if (!others.length) return toast("Add another column first. Its cards need somewhere to go.", { error: true });
        const v = await dialog({ title: `Archive “${col.name}”`, submit: "Archive", danger: true, fields: [{ name: "to", type: "select", label: `Move its ${n} card(s) to`, options: others.map((c) => ({ value: c.id, label: c.name })) }] });
        if (v) patch({ archived: true, move_cards_to: v.to });
      },
    },
  ].filter(Boolean));
}

function renderCardTile(card) {
  const pending = card.pending_reviews > 0;
  const agentTouched = card.updated_by.kind === "agent" || card.created_by.kind === "agent";
  const meta = [
    card.priority !== "none" ? h("span", { class: `prio prio-${card.priority}` }, card.priority) : null,
    card.due_on ? h("span", { class: "due" + (isOverdue(card) ? " overdue" : "") }, fmtDue(card.due_on)) : null,
    ...card.labels.map(labelChip),
    card.assignee ? h("span", {}, "@" + card.assignee) : null,
    card.comment_count ? h("span", { style: "display:inline-flex;gap:3px;align-items:center", title: `${card.comment_count} comments` }, icon("comment"), card.comment_count) : null,
    pending
      ? h("span", { class: "agent-tag", title: `${card.pending_reviews} change(s) awaiting sign-off` }, icon("bot"), "needs sign-off")
      : agentTouched
        ? h("span", { class: "agent-tag", title: `Last touched by ${card.updated_by.name}` }, icon("bot"), card.updated_by.kind === "agent" ? card.updated_by.name : card.created_by.name)
        : null,
    card.archived ? h("span", { class: "status status-reverted" }, "archived") : null,
  ];
  const open = () => navigate(`/b/${state.board.id}?card=${card.number}`);
  const el = h(
    "div",
    {
      class: "card" + (pending ? " pending" : "") + (card.completed_at ? " done" : ""),
      role: "button",
      tabindex: 0,
      "aria-label": `${card.ref} ${card.title}`,
      draggable: card.archived ? null : "true",
      dataset: { id: card.id },
      onclick: open,
      onkeydown: (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      },
    },
    h("div", { class: "card-top" }, h("span", { class: "card-ref" }, card.ref), h("span", { class: "card-title" }, card.title)),
    h("div", { class: "card-meta" }, meta),
  );
  el.addEventListener("dragstart", (e) => {
    state.drag = { id: card.id, from: card.column_id };
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", card.ref);
    requestAnimationFrame(() => el.setAttribute("aria-grabbed", "true"));
  });
  el.addEventListener("dragend", () => {
    el.removeAttribute("aria-grabbed");
    state.drag = null;
    document.querySelectorAll(".drop-line").forEach((n) => n.remove());
    document.querySelectorAll(".drop-target").forEach((n) => n.classList.remove("drop-target"));
  });
  return el;
}

function dropIndex(list, y) {
  const items = [...list.querySelectorAll(".card")].filter((c) => c.dataset.id !== state.drag?.id);
  let i = 0;
  for (; i < items.length; i++) {
    const r = items[i].getBoundingClientRect();
    if (y < r.top + r.height / 2) break;
  }
  return { index: i, items };
}

function wireDrop(list, col) {
  const lane = () => list.closest(".lane");
  list.addEventListener("dragover", (e) => {
    if (!state.drag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    document.querySelectorAll(".drop-target").forEach((n) => n !== lane() && n.classList.remove("drop-target"));
    lane().classList.add("drop-target");
    const { index, items } = dropIndex(list, e.clientY);
    document.querySelectorAll(".drop-line").forEach((n) => n.remove());
    const line = h("div", { class: "drop-line" });
    if (index < items.length) list.insertBefore(line, items[index]);
    else list.append(line);
  });
  list.addEventListener("dragleave", (e) => {
    if (!list.contains(e.relatedTarget)) {
      lane().classList.remove("drop-target");
      list.querySelectorAll(".drop-line").forEach((n) => n.remove());
    }
  });
  list.addEventListener("drop", async (e) => {
    e.preventDefault();
    if (!state.drag) return;
    const { index, items } = dropIndex(list, e.clientY);
    // When filtered, translate the visual index to the real index among all cards in the column.
    let realIndex = index;
    if (state.filter) {
      const all = col.cards.filter((c) => c.id !== state.drag.id && !c.archived);
      const anchor = items[index]?.dataset.id;
      realIndex = anchor ? all.findIndex((c) => c.id === anchor) : all.length;
    }
    const id = state.drag.id;
    state.drag = null;
    // optimistic local move
    const card = state.board.columns.flatMap((c) => c.cards).find((c) => c.id === id);
    for (const c of state.board.columns) c.cards = c.cards.filter((x) => x.id !== id);
    if (card) {
      const target = state.board.columns.find((c) => c.id === col.id);
      const active = target.cards.filter((c) => !c.archived);
      const before = active[realIndex];
      const at = before ? target.cards.indexOf(before) : target.cards.length;
      target.cards.splice(at, 0, { ...card, column_id: col.id });
    }
    renderLanes();
    try {
      await api("POST", `/cards/${id}/move`, { column_id: col.id, position: realIndex });
    } catch (err) {
      fail(err);
    }
    await loadBoard(state.board.id);
    renderLanes();
  });
}

// ------------------------------------------------------------------ card drawer

async function openCard(ref) {
  try {
    const card = await api("GET", `/cards/${encodeURIComponent(ref)}`);
    if (state.card?.id !== card.id) state.cardTab = card.pending_reviews ? "history" : "comments";
    state.card = card;
    state.cardHistory = null;
    renderDrawer();
    if (state.cardTab === "history") loadHistory();
  } catch (err) {
    fail(err);
    closeCard();
  }
}
async function reloadCard() {
  if (!state.card) return;
  state.card = await api("GET", `/cards/${state.card.id}`);
  if (state.cardHistory) state.cardHistory = await api("GET", `/cards/${state.card.id}/history`);
  renderDrawer();
}
function closeCard(nav = true) {
  state.card = null;
  state.cardHistory = null;
  document.getElementById("drawer-root")?.replaceChildren();
  if (nav && state.board) navigate(`/b/${state.board.id}`);
}
async function loadHistory() {
  try {
    state.cardHistory = await api("GET", `/cards/${state.card.id}/history`);
    renderDrawer();
  } catch (err) {
    fail(err);
  }
}

async function patchCard(body, { reload = true } = {}) {
  const c = state.card;
  try {
    await api("PATCH", `/cards/${c.id}`, { ...body, expected_version: c.version });
  } catch (err) {
    if (err.status === 409) toast("This card changed somewhere else. Showing the latest version.", { error: true });
    else fail(err);
  }
  if (reload) {
    await reloadCard();
    await loadBoard(state.board.id);
    renderLanes();
  }
}

function autosize(ta) {
  const fit = () => {
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
  };
  requestAnimationFrame(fit);
  ta.addEventListener("input", fit);
}

function renderDrawer() {
  const root = document.getElementById("drawer-root");
  const c = state.card;
  if (!root || !c) return;
  const columns = state.board?.columns.filter((col) => !col.archived || col.id === c.column_id) ?? [];

  const title = h("textarea", { class: "title-input", rows: 1, "aria-label": "Title", value: c.title });
  autosize(title);
  title.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      title.blur();
    }
  });
  title.addEventListener("blur", () => {
    const v = title.value.trim();
    if (v && v !== c.title) patchCard({ title: v });
    else title.value = c.title;
  });

  const field = (label, control) => h("label", { class: "field" }, label, control);
  const props = h(
    "div",
    { class: "props" },
    field(
      "Column",
      h(
        "select",
        {
          class: "select",
          onchange: async (e) => {
            try {
              await api("POST", `/cards/${c.id}/move`, { column_id: e.target.value, expected_version: c.version });
            } catch (err) {
              fail(err);
            }
            await reloadCard();
            await loadBoard(state.board.id);
            renderLanes();
          },
        },
        columns.map((col) => h("option", { value: col.id, selected: col.id === c.column_id }, col.name)),
      ),
    ),
    field(
      "Priority",
      h("select", { class: "select", onchange: (e) => patchCard({ priority: e.target.value }) }, ["none", "low", "medium", "high", "urgent"].map((p) => h("option", { value: p, selected: c.priority === p }, p[0].toUpperCase() + p.slice(1)))),
    ),
    field("Due", h("input", { class: "input", type: "date", value: c.due_on ?? "", onchange: (e) => patchCard({ due_on: e.target.value || null }) })),
    field("Assignee", h("input", { class: "input", placeholder: "me, an agent…", value: c.assignee ?? "", onchange: (e) => patchCard({ assignee: e.target.value.trim() || null }) })),
    h(
      "label",
      { class: "field wide" },
      "Labels",
      h("input", {
        class: "input",
        placeholder: "comma separated",
        value: c.labels.join(", "),
        onchange: (e) => patchCard({ labels: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) }),
      }),
    ),
  );

  const history = state.cardHistory;
  const tabs = h(
    "div",
    { class: "tabs", role: "tablist" },
    h("button", { class: "tab", role: "tab", "aria-selected": state.cardTab === "comments" ? "true" : "false", onclick: () => { state.cardTab = "comments"; renderDrawer(); } }, `Comments ${c.comments.length ? `(${c.comments.length})` : ""}`),
    h(
      "button",
      { class: "tab", role: "tab", "aria-selected": state.cardTab === "history" ? "true" : "false", onclick: () => { state.cardTab = "history"; if (!state.cardHistory) loadHistory(); else renderDrawer(); } },
      "History ",
      c.pending_reviews ? h("span", { class: "count", title: "Awaiting sign-off" }, c.pending_reviews) : null,
    ),
  );

  let tabBody;
  if (state.cardTab === "comments") {
    const ta = h("textarea", { class: "textarea", rows: 3, placeholder: "Write a comment… (Markdown)" });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) post();
    });
    const post = async () => {
      const body = ta.value.trim();
      if (!body) return;
      try {
        await api("POST", `/cards/${c.id}/comments`, { body });
        await reloadCard();
      } catch (err) {
        fail(err);
      }
    };
    tabBody = h(
      "div",
      {},
      c.comments.length
        ? c.comments.map((m) =>
            h(
              "div",
              { class: "comment" },
              h(
                "div",
                { class: "comment-head" },
                actorBadge(m.author),
                h("span", { class: "faint xs" }, timeEl(m.created_at)),
                h("button", {
                  class: "btn btn-ghost btn-sm",
                  "aria-label": "Delete comment",
                  onclick: async () => {
                    if (!(await confirmDialog("Delete this comment? It stays in the history.", "Delete"))) return;
                    try {
                      await api("DELETE", `/comments/${m.id}`);
                      await reloadCard();
                    } catch (err) {
                      fail(err);
                    }
                  },
                }, "Delete"),
              ),
              h("div", { class: "md", html: markdown(m.body) }),
            ),
          )
        : h("p", { class: "faint small" }, "No comments yet."),
      h("div", { class: "composer", style: "margin-top: var(--space-3)" }, ta, h("div", { class: "composer-actions" }, h("button", { class: "btn btn-primary btn-sm", onclick: post }, "Comment"), h("span", { class: "faint xs" }, "⌘/Ctrl + Enter"))),
    );
  } else {
    tabBody = history
      ? h(
          "div",
          {},
          c.pending_reviews && state.me.can_review
            ? h(
                "div",
                { class: "event-actions", style: "margin-bottom: var(--space-2)" },
                h("button", { class: "btn btn-ok btn-sm", onclick: () => review("approve", { card_id: c.id }) }, `Approve all ${c.pending_reviews}`),
                h("button", { class: "btn btn-danger btn-sm", onclick: () => review("reject", { card_id: c.id }) }, "Reject & revert all"),
              )
            : null,
          h("div", { class: "timeline" }, [...history.events].reverse().map((e) => renderEvent(e, history.refs, { inCard: true }))),
        )
      : h("p", { class: "faint small" }, "Loading history…");
  }

  const drawer = h(
    "aside",
    { class: "drawer", role: "dialog", "aria-modal": "true", "aria-label": `Card ${c.ref}` },
    h(
      "div",
      { class: "drawer-head" },
      h("span", { class: "card-ref" }, c.ref),
      h("span", { class: "muted small" }, `${c.board_name} / ${c.column_name}`),
      c.archived ? h("span", { class: "status status-reverted" }, "Archived") : null,
      c.completed_at ? h("span", { class: "status status-approved", title: new Date(c.completed_at).toLocaleString() }, "Done") : null,
      h("span", { class: "spacer" }),
      h("button", {
        class: "btn btn-ghost btn-sm btn-icon",
        "aria-label": "Card menu",
        html: ICONS.dots,
        onclick: (e) => {
          e.stopPropagation();
          openMenu(e.currentTarget, [
            { label: "Copy link", run: () => copy(`${location.origin}/c/${c.number}`) },
            { label: "Copy ref", run: () => copy(c.ref) },
            "-",
            c.archived
              ? { label: "Restore card", run: () => patchCard({ archived: false }) }
              : { label: "Archive card", danger: true, run: async () => { await patchCard({ archived: true }); toast(`${c.ref} archived`, { action: { label: "Undo", run: () => patchCard({ archived: false }) } }); } },
          ]);
        },
      }),
      h("button", { class: "btn btn-ghost btn-sm btn-icon", "aria-label": "Close", html: ICONS.close, onclick: () => closeCard() }),
    ),
    h(
      "div",
      { class: "drawer-body" },
      h("div", {}, title, h("p", { class: "byline", style: "margin-top: var(--space-2)" }, "Created by ", h("strong", {}, c.created_by.name), " ", timeEl(c.created_at), " · updated by ", h("strong", {}, c.updated_by.name), " ", timeEl(c.updated_at))),
      props,
      descriptionBlock(c),
      h("div", {}, tabs, tabBody),
    ),
  );
  const hadDrawer = !!root.querySelector(".drawer");
  const scrollTop = root.querySelector(".drawer")?.scrollTop ?? 0;
  root.replaceChildren(h("div", { class: "scrim", onclick: () => closeCard(), style: hadDrawer ? "animation:none" : null }), drawer);
  if (hadDrawer) {
    drawer.style.animation = "none";
    drawer.scrollTop = scrollTop;
  } else drawer.querySelector(".btn[aria-label=Close]")?.focus();
}

function descriptionBlock(c) {
  const wrap = h("div", {});
  const view = () => {
    wrap.replaceChildren(
      h("div", { class: "section-title" }, "Description", c.description ? h("button", { class: "btn btn-ghost btn-sm", onclick: edit }, "Edit") : null),
      c.description ? h("div", { class: "md md-view", html: markdown(c.description), ondblclick: edit }) : h("div", { class: "md-empty", tabindex: 0, role: "button", onclick: edit, onkeydown: (e) => e.key === "Enter" && edit() }, "Add a description (Markdown, - [ ] checklists)"),
    );
    wrap.querySelectorAll("input[data-task]").forEach((box) =>
      box.addEventListener("click", (e) => {
        e.stopPropagation();
        patchCard({ description: toggleTask(c.description, Number(box.dataset.task)) });
      }),
    );
  };
  const edit = () => {
    const ta = h("textarea", { class: "textarea", rows: 10, value: c.description });
    wrap.replaceChildren(
      h("div", { class: "section-title" }, "Description"),
      ta,
      h("div", { class: "composer-actions", style: "margin-top: var(--space-2)" }, h("button", { class: "btn btn-primary btn-sm", onclick: () => patchCard({ description: ta.value }) }, "Save"), h("button", { class: "btn btn-ghost btn-sm", onclick: view }, "Cancel")),
    );
    ta.focus();
  };
  view();
  return wrap;
}

// ------------------------------------------------------------------ events (history, review, activity)

function actorBadge(actor) {
  const agent = actor.kind === "agent";
  return h("span", { class: agent ? "agent-tag" : "who", title: agent ? "Agent" : actor.kind === "owner" ? "You" : "Human token" }, agent ? icon("bot") : null, actor.name);
}

const short = (s, n = 80) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s);

function describe(e, refs, opts) {
  const colName = (id) => refs?.columns?.[id] ?? "a column";
  const a = e.after || {};
  const b = e.before || {};
  const cardLabel = () => {
    if (opts.inCard) return [];
    const c = e.card || (e.card_id && refs?.cards?.[e.card_id]) || (e.entity_type === "card" ? { ref: a.ref || b.ref, title: a.title || b.title } : null);
    if (!c) return [];
    const href = `/c/${(c.ref || "").replace("#", "")}`;
    return [" ", h("a", { href, "data-link": true }, h("span", { class: "mono" }, c.ref), " ", short(c.title, 60))];
  };
  switch (`${e.entity_type}.${e.action}`) {
    case "card.create":
      return [opts.inCard ? "created this card" : "created", ...cardLabel(), ` in ${colName(a.column_id)}`];
    case "card.move":
      return a.column_id !== b.column_id ? ["moved", ...cardLabel(), ` from ${colName(b.column_id)} to ${colName(a.column_id)}`] : ["reordered", ...cardLabel(), ` in ${colName(a.column_id)}`];
    case "card.update":
      return [opts.inCard && !e.changes.length ? "edited this card" : "edited", ...cardLabel(), e.changes.length ? h("span", { class: "muted" }, ` · ${e.changes.join(", ")}`) : ""];
    case "card.archive":
      return [opts.inCard ? "archived this card" : "archived", ...cardLabel()];
    case "card.restore":
      return [opts.inCard ? "restored this card" : "restored", ...cardLabel()];
    case "card.revert":
      return [opts.inCard ? "reverted a change" : "reverted a change to", ...cardLabel()];
    case "comment.create":
      return [opts.inCard ? "commented" : "commented on", ...cardLabel()];
    case "comment.delete":
      return [opts.inCard ? "deleted a comment" : "deleted a comment on", ...cardLabel()];
    case "comment.revert":
      return [opts.inCard ? "reverted a comment" : "reverted a comment on", ...cardLabel()];
    case "column.create":
      return [`added column “${a.name}”`];
    case "column.archive":
      return [`archived column “${b.name}”`];
    case "column.restore":
      return [`restored column “${a.name}”`];
    case "column.update":
      return [`updated column “${a.name}”`, h("span", { class: "muted" }, ` · ${e.changes.join(", ")}`)];
    case "board.create":
      return [`created board “${a.name}”`];
    case "board.update":
      return [`updated board “${a.name}”`, h("span", { class: "muted" }, ` · ${e.changes.join(", ")}`)];
    case "board.archive":
      return [`archived board “${b.name}”`];
    case "token.create":
      return [`created ${a.kind} token “${a.name}”`];
    case "token.revoke":
      return [`revoked token “${b.name}”`];
    default:
      return [`${e.action} ${e.entity_type}`, ...cardLabel()];
  }
}

function lineDiff(a, b) {
  const A = a.split("\n");
  const B = b.split("\n");
  if (A.length * B.length > 250000) return null;
  const n = A.length;
  const m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) ops.push([" ", A[i++]]), j++;
    else if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) ops.push(["-", A[i++]]);
    else ops.push(["+", B[j++]]);
  }
  const out = [];
  for (let k = 0; k < ops.length; ) {
    if (ops[k][0] !== " ") {
      out.push(h("div", { class: ops[k][0] === "+" ? "ld-add" : "ld-del" }, ops[k][0] + " " + ops[k][1]));
      k++;
      continue;
    }
    let end = k;
    while (end < ops.length && ops[end][0] === " ") end++;
    const run = ops.slice(k, end);
    const keepHead = k === 0 ? 0 : 1;
    const keepTail = end === ops.length ? 0 : 1;
    if (run.length > keepHead + keepTail + 1) {
      run.slice(0, keepHead).forEach((o) => out.push(h("div", { class: "ld-same" }, "  " + o[1])));
      out.push(h("div", { class: "ld-skip" }, `⋯ ${run.length - keepHead - keepTail} unchanged line(s)`));
      run.slice(run.length - keepTail).forEach((o) => out.push(h("div", { class: "ld-same" }, "  " + o[1])));
    } else run.forEach((o) => out.push(h("div", { class: "ld-same" }, "  " + o[1])));
    k = end;
  }
  return h("div", { class: "ldiff" }, out);
}

const HIDDEN_DIFF = new Set(["updated_at", "version", "updated_by", "position", "ref", "pending_reviews", "comment_count", "archived_at"]);
function renderDiff(e, refs) {
  if (!e.before || !e.after) {
    if (e.entity_type === "comment" && e.action === "create") return h("div", { class: "diff" }, h("div", { class: "md small", html: markdown(e.after.body) }));
    if (e.entity_type === "card" && e.action === "create" && e.after.description) return h("div", { class: "diff" }, h("div", { class: "diff-row" }, h("span", { class: "diff-key" }, "description"), h("span", { class: "diff-val" }, h("ins", { class: "long" }, e.after.description))));
    return null;
  }
  const keys = (e.changes.length ? e.changes : Object.keys(e.after).filter((k) => JSON.stringify(e.before[k]) !== JSON.stringify(e.after[k]))).filter((k) => !HIDDEN_DIFF.has(k));
  if (!keys.length) return null;
  const show = (k, v) => {
    if (v == null || v === "") return "∅";
    if (k === "column_id") return refs?.columns?.[v] ?? v;
    if (k === "board_id") return refs?.boards?.[v] ?? v;
    if (Array.isArray(v)) return v.length ? v.join(", ") : "∅";
    if (k === "completed_at" || k === "archived_at") return new Date(v).toLocaleString();
    return String(v);
  };
  return h(
    "div",
    { class: "diff" },
    keys.map((k) => {
      const long = k === "description" || String(e.after[k] ?? "").length > 60;
      if (long && typeof e.before[k] === "string" && typeof e.after[k] === "string" && e.before[k] && e.after[k]) {
        const ld = lineDiff(e.before[k], e.after[k]);
        if (ld) return h("div", { class: "diff-row" }, h("span", { class: "diff-key" }, k), h("span", { class: "diff-val" }, ld));
      }
      return h(
        "div",
        { class: "diff-row" },
        h("span", { class: "diff-key" }, k.replace("_id", "")),
        h("span", { class: "diff-val" }, h("del", { class: long ? "long" : "" }, show(k, e.before[k])), long ? null : " → ", h("ins", { class: long ? "long" : "" }, show(k, e.after[k]))),
      );
    }),
  );
}

function renderEvent(e, refs, opts = {}) {
  const agent = e.actor.kind === "agent";
  const status = e.reverted_by ? h("span", { class: "status status-reverted" }, "reverted") : e.review.status !== "none" ? h("span", { class: `status status-${e.review.status}`, title: e.review.reviewed_by ? `${e.review.status} by ${e.review.reviewed_by.name}${e.review.note ? `: ${e.review.note}` : ""}` : null }, e.review.status === "pending" ? "awaiting sign-off" : e.review.status) : null;
  const revertable = state.me?.can_review && !e.reverted_by && e.action !== "revert" && ["card", "column", "board", "comment"].includes(e.entity_type) && !(e.entity_type === "comment" && e.action === "delete");
  const actions =
    e.review.status === "pending" && state.me?.can_review
      ? [h("button", { class: "btn btn-ok btn-sm", onclick: () => review("approve", { event_ids: [e.id] }) }, "Approve"), h("button", { class: "btn btn-danger btn-sm", onclick: () => review("reject", { event_ids: [e.id] }) }, "Reject & revert")]
      : revertable && !opts.compact
        ? [h("button", { class: "btn btn-ghost btn-sm", onclick: () => revert(e) }, "Revert")]
        : [];
  return h(
    "div",
    { class: "event", dataset: { id: e.id } },
    h("span", { class: "event-dot" + (agent ? " agent" : ""), html: agent ? ICONS.bot : ICONS.person }),
    h(
      "div",
      {},
      h("div", { class: "event-line" }, actorBadge(e.actor), " ", ...describe(e, refs, opts)),
      h("div", { class: "event-sub" }, timeEl(e.created_at), h("span", {}, "via " + e.via + (e.client && e.client !== "web" ? ` · ${e.client}` : "")), status),
      e.reason ? h("div", { class: "reason" }, e.reason) : null,
      opts.compact ? null : renderDiff(e, refs),
      actions.length ? h("div", { class: "event-actions" }, actions) : null,
    ),
  );
}

async function review(kind, selector) {
  try {
    if (kind === "approve") {
      const r = await api("POST", "/reviews/approve", selector);
      toast(`Signed off ${r.approved} change${r.approved === 1 ? "" : "s"}`);
    } else {
      const r = await api("POST", "/reviews/reject", selector);
      if (r.revert_errors.length) {
        toast(`Rejected ${r.rejected}. ${r.revert_errors.length} couldn't be reverted because of later edits: ${r.revert_errors[0].error}`, { error: true });
      } else toast(`Rejected and reverted ${r.rejected} change${r.rejected === 1 ? "" : "s"}`);
    }
  } catch (err) {
    fail(err);
  }
  await refreshPending();
  state.dirty = false;
  await softRefresh();
  if (location.pathname.startsWith("/b/") && state.card) await reloadCard();
}

async function revert(e, force = false) {
  if (!force && !(await confirmDialog("Revert this change? It will be restored to how it was before, and the revert is recorded in history.", "Revert"))) return;
  try {
    await api("POST", `/events/${e.id}/revert`, { force });
    toast("Reverted");
  } catch (err) {
    if (err.status === 409 && !force && /force/.test(err.message)) {
      if (await confirmDialog("This item changed again after that event. Revert anyway and overwrite the later changes?", "Overwrite")) return revert(e, true);
      return;
    }
    fail(err);
  }
  await softRefresh();
}

// ------------------------------------------------------------------ review page

async function showReview() {
  state.board = state.board && state.boards.find((b) => b.id === state.board.id) ? state.board : null;
  document.title = "Sign-off · Relay";
  let data;
  try {
    data = await api("GET", "/reviews");
  } catch (err) {
    return fail(err);
  }
  state.pending = data.pending_count;
  const groups = data.groups.map((g) => ({ ...g, events: data.events.filter((e) => e.session_id === g.session_id && e.actor.id === g.actor.id) }));
  shell(
    "review",
    h(
      "div",
      { class: "page" },
      h(
        "div",
        { class: "page-head" },
        h("div", {}, h("h1", {}, "Sign-off"), h("p", { class: "muted" }, "Agent changes go live right away. Approve them here, or reject them, which reverts them.")),
        data.pending_count && state.me.can_review ? h("button", { class: "btn btn-ok", onclick: async () => { if (await confirmDialog(`Approve all ${data.pending_count} pending changes?`, "Approve all", false)) review("approve", { all: true }); } }, `Approve all ${data.pending_count}`) : null,
      ),
      groups.length
        ? groups.map((g) =>
            h(
              "section",
              { class: "group" },
              h(
                "header",
                { class: "group-head" },
                actorBadge(g.actor),
                h("span", { class: "muted small" }, `${g.count} change${g.count === 1 ? "" : "s"} · ${g.cards} card${g.cards === 1 ? "" : "s"}`),
                h("span", { class: "faint xs" }, g.client ? `${g.client} · ` : "", timeEl(g.last_at)),
                state.me.can_review
                  ? h(
                      "div",
                      { class: "actions" },
                      h("button", { class: "btn btn-ok btn-sm", onclick: () => review("approve", { event_ids: g.events.map((e) => e.id) }) }, "Approve"),
                      h("button", { class: "btn btn-danger btn-sm", onclick: async () => { if (await confirmDialog(`Reject and revert ${g.count} change(s) from ${g.actor.name}?`, "Reject & revert")) review("reject", { event_ids: g.events.map((e) => e.id) }); } }, "Reject all"),
                    )
                  : null,
              ),
              h("div", { class: "group-body timeline" }, g.events.map((e) => renderEvent(e, data.refs))),
            ),
          )
        : h("div", { class: "empty" }, h("h2", {}, "All signed off"), h("p", {}, "Agent changes that need your sign-off will show up here.")),
    ),
  );
}

// ------------------------------------------------------------------ activity page

async function showActivity() {
  document.title = "Activity · Relay";
  const params = new URLSearchParams(location.search);
  const filters = { actor_kind: params.get("actor_kind") || "", board_id: params.get("board_id") || "", review_status: params.get("review_status") || "" };
  const list = h("div", { class: "timeline" });
  const more = h("button", { class: "btn", hidden: true }, "Load more");
  let refs = { columns: {}, cards: {}, boards: {} };
  const load = async (before) => {
    more.setAttribute("aria-busy", "true");
    try {
      const r = await api("GET", `/events${qs({ ...filters, before_seq: before, limit: 50 })}`);
      refs = { columns: { ...refs.columns, ...r.refs.columns }, cards: { ...refs.cards, ...r.refs.cards }, boards: { ...refs.boards, ...r.refs.boards } };
      list.append(...r.events.map((e) => renderEvent(e, refs)));
      if (!list.children.length) list.append(h("div", { class: "empty" }, h("h2", {}, "Nothing here yet"), h("p", {}, "Every change from you, your apps and your agents is recorded here.")));
      more.hidden = !r.has_more;
      more.onclick = () => load(r.next_before_seq);
    } catch (err) {
      fail(err);
    } finally {
      more.removeAttribute("aria-busy");
    }
  };
  const setFilter = (k) => (e) => {
    filters[k] = e.target.value;
    navigate(`/activity${qs(filters)}`, { replace: true });
  };
  shell(
    "activity",
    h(
      "div",
      { class: "page" },
      h("div", { class: "page-head" }, h("div", {}, h("h1", {}, "Activity"), h("p", { class: "muted" }, "The full history of every change, newest first."))),
      h(
        "div",
        { class: "filters" },
        h("select", { class: "select", "aria-label": "Who", onchange: setFilter("actor_kind") }, [["", "Everyone"], ["agent", "Agents"], ["owner", "Me (web / admin)"], ["human", "Human tokens"]].map(([v, l]) => h("option", { value: v, selected: filters.actor_kind === v }, l))),
        h("select", { class: "select", "aria-label": "Board", onchange: setFilter("board_id") }, h("option", { value: "" }, "All boards"), state.boards.map((b) => h("option", { value: b.id, selected: filters.board_id === b.id }, b.name))),
        h("select", { class: "select", "aria-label": "Review status", onchange: setFilter("review_status") }, [["", "Any status"], ["pending", "Awaiting sign-off"], ["approved", "Approved"], ["rejected", "Rejected"]].map(([v, l]) => h("option", { value: v, selected: filters.review_status === v }, l))),
      ),
      list,
      h("div", { style: "margin-top: var(--space-4)" }, more),
    ),
  );
  await load();
}

// ------------------------------------------------------------------ settings page

async function showSettings() {
  document.title = "Settings · Relay";
  const origin = location.origin;
  const tokensBox = h("div", {});
  const secretBox = h("div", {});
  const renderTokens = async () => {
    try {
      const { tokens } = await api("GET", "/tokens");
      tokensBox.replaceChildren(
        ...(tokens.length
          ? tokens.map((t) =>
              h(
                "div",
                { class: "token-row" },
                t.kind === "agent" ? h("span", { class: "agent-tag" }, icon("bot"), t.name) : h("span", { class: "name" }, t.name),
                h("span", { class: "muted small" }, `${t.kind} · ${t.scope}${t.requires_review ? " · needs sign-off" : ""}`),
                h("span", { class: "faint xs mono" }, t.prefix + "…"),
                h("span", { class: "faint xs" }, t.last_used_at ? ["used ", timeEl(t.last_used_at)] : "never used"),
                h(
                  "div",
                  { class: "actions" },
                  h("button", { class: "btn btn-sm", onclick: async () => { await api("PATCH", `/tokens/${t.id}`, { requires_review: !t.requires_review }).catch(fail); renderTokens(); } }, t.requires_review ? "Stop requiring sign-off" : "Require sign-off"),
                  h("button", { class: "btn btn-sm btn-danger", onclick: async () => { if (await confirmDialog(`Revoke “${t.name}”? Anything using it stops working immediately.`, "Revoke")) { await api("DELETE", `/tokens/${t.id}`).catch(fail); renderTokens(); } } }, "Revoke"),
                ),
              ),
            )
          : [h("p", { class: "faint small", style: "margin-top: var(--space-3)" }, "No tokens yet.")]),
      );
    } catch (err) {
      fail(err);
    }
  };
  const name = h("input", { class: "input", placeholder: "e.g. Claude Code, iPhone app", required: true });
  const kind = h("select", { class: "select" }, h("option", { value: "agent" }, "Agent (needs sign-off)"), h("option", { value: "human" }, "Human / app"));
  const scope = h("select", { class: "select" }, h("option", { value: "write" }, "Read & write"), h("option", { value: "read" }, "Read only"));
  const create = async (e) => {
    e.preventDefault();
    if (!name.value.trim()) return name.focus();
    try {
      const t = await api("POST", "/tokens", { name: name.value.trim(), kind: kind.value, scope: scope.value });
      name.value = "";
      const snippet = (label, text) => h("div", {}, h("div", { class: "small muted", style: "margin-bottom: var(--space-1)" }, label), h("div", { class: "copy-row" }, h("pre", {}, text), h("button", { class: "btn btn-sm", type: "button", onclick: () => copy(text) }, "Copy")));
      secretBox.replaceChildren(
        h(
          "div",
          { class: "secret" },
          h("strong", {}, `Token for “${t.name}”. Copy it now. It won't be shown again.`),
          snippet("Token", t.token),
          snippet("Claude Code", `claude mcp add --transport http relay ${origin}/mcp --header "Authorization: Bearer ${t.token}"`),
          snippet("MCP client JSON (Cursor, Claude Desktop via config, etc.)", JSON.stringify({ mcpServers: { relay: { type: "http", url: `${origin}/mcp`, headers: { Authorization: `Bearer ${t.token}` } } } }, null, 2)),
          snippet("REST", `curl -H "Authorization: Bearer ${t.token}" ${origin}/api/v1/boards`),
          h("button", { class: "btn btn-sm", type: "button", onclick: () => secretBox.replaceChildren() }, "Done"),
        ),
      );
      renderTokens();
    } catch (err) {
      fail(err);
    }
  };
  shell(
    "settings",
    h(
      "div",
      { class: "page" },
      h("div", { class: "page-head" }, h("div", {}, h("h1", {}, "Settings"), h("p", { class: "muted" }, `Signed in as ${state.me.actor.name}.`))),
      h(
        "section",
        { class: "panel" },
        h("h2", {}, "API & agent tokens"),
        h("p", {}, "Each agent, app or script gets its own token, so every change in the history shows who made it. Agent tokens queue their changes for your sign-off."),
        h("form", { onsubmit: create }, h("div", { class: "form-row" }, h("label", { class: "field" }, "Name", name), h("label", { class: "field" }, "Kind", kind), h("label", { class: "field" }, "Access", scope)), h("div", { style: "margin-top: var(--space-3)" }, h("button", { class: "btn btn-primary", type: "submit" }, "Create token"))),
        secretBox,
        h("div", { style: "margin-top: var(--space-4)" }, tokensBox),
      ),
      h(
        "section",
        { class: "panel" },
        h("h2", {}, "Connect"),
        h("p", {}, "The web UI uses the same API as everything else. Anything it can do, your apps and agents can do too."),
        h("ul", { class: "small", style: "margin:0; padding-left: 1.2em; display:grid; gap: var(--space-1)" },
          h("li", {}, "MCP endpoint: ", h("code", {}, `${origin}/mcp`)),
          h("li", {}, "REST base URL: ", h("code", {}, `${origin}/api/v1`)),
          h("li", {}, h("a", { href: "/docs" }, "API reference"), " · ", h("a", { href: "/api/v1/openapi.json" }, "OpenAPI spec")),
        ),
      ),
      h(
        "section",
        { class: "panel" },
        h("h2", {}, "Data"),
        h("p", {}, "Download everything (boards, cards, comments and the full history) as JSON."),
        h("button", {
          class: "btn",
          onclick: async (e) => {
            e.currentTarget.setAttribute("aria-busy", "true");
            try {
              const data = await api("GET", "/export?include_events=true");
              const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
              h("a", { href: url, download: `relay-export-${new Date().toISOString().slice(0, 10)}.json` }).click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            } catch (err) {
              fail(err);
            }
            e.target.removeAttribute("aria-busy");
          },
        }, "Export JSON"),
      ),
      h(
        "section",
        { class: "panel" },
        h("h2", {}, "Session"),
        h("button", { class: "btn", onclick: async () => { await api("POST", "/auth/logout").catch(() => {}); state.me = null; navigate("/login"); } }, "Sign out"),
      ),
    ),
  );
  renderTokens();
}

// ------------------------------------------------------------------ markdown (small, safe subset)

function inlineMd(s) {
  let out = esc(s);
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  out = out.replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:|\/)[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  out = out.replace(/(^|\s)#(\d+)\b/g, '$1<a href="/c/$2" data-link>#$2</a>');
  return out;
}

function markdown(src) {
  const lines = String(src ?? "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;
  let task = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }
    let m;
    if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) {
      out.push(`<h${m[1].length + 1}>${inlineMd(m[2])}</h${m[1].length + 1}>`);
      i++;
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        const text = lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, "");
        const t = /^\[( |x|X)\]\s*(.*)$/.exec(text);
        if (t) items.push(`<li class="task"><input type="checkbox" data-task="${task++}"${t[1] !== " " ? " checked" : ""} aria-label="Toggle item">${inlineMd(t[2])}</li>`);
        else items.push(`<li>${inlineMd(text)}</li>`);
        i++;
      }
      out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      out.push(`<blockquote>${inlineMd(buf.join(" "))}</blockquote>`);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,3}\s|>\s?|\s*([-*+]|\d+\.)\s+)/.test(lines[i])) buf.push(lines[i++]);
    out.push(`<p>${buf.map(inlineMd).join("<br>")}</p>`);
  }
  return out.join("");
}

function toggleTask(src, n) {
  let count = -1;
  let inFence = false;
  return src
    .split("\n")
    .map((line) => {
      if (/^```/.test(line)) inFence = !inFence;
      if (inFence) return line;
      return line.replace(/^(\s*([-*+]|\d+\.)\s+)\[( |x|X)\]/, (all, pre, _b, mark) => {
        count++;
        if (count !== n) return all;
        return `${pre}[${mark === " " ? "x" : " "}]`;
      });
    })
    .join("\n");
}

// ------------------------------------------------------------------ boot

route();
