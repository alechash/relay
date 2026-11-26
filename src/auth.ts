import type { Actor } from "./context";
import type { Env } from "./env";
import { ApiError } from "./lib/errors";
import { hmac, nowIso, safeEqual, sha256Hex } from "./lib/util";
import { TOKEN_PREFIX } from "./core/tokens";

export const SESSION_COOKIE = "relay_session";
const SESSION_TTL_S = 60 * 60 * 24 * 30;

export function ownerActor(env: Env): Actor {
  return { id: "owner", name: env.OWNER_NAME || "Owner", kind: "owner", scope: "write", requiresReview: false };
}

export const MIN_ADMIN_TOKEN_LENGTH = 12;

/** settings row holding the SHA-256 of an admin token, an alternative to the ADMIN_TOKEN secret. */
export const ADMIN_HASH_KEY = "admin_token_sha256";

interface AdminConfig {
  /** ADMIN_TOKEN from the Worker environment, if usable. */
  envToken: string | null;
  /** SHA-256 (hex) of an admin token stored in the database, if any. */
  dbHash: string | null;
  /** Key material for signing web sessions. */
  sessionSecret: string;
}

export type AdminStatus = "env" | "database" | "missing" | "too_short";

function envTokenState(env: Env): { token: string | null; problem: "missing" | "too_short" | null } {
  const t = typeof env.ADMIN_TOKEN === "string" ? env.ADMIN_TOKEN.trim() : "";
  if (!t) return { token: null, problem: "missing" };
  if (t.length < MIN_ADMIN_TOKEN_LENGTH) return { token: null, problem: "too_short" };
  return { token: t, problem: null };
}

let cachedHash: { value: string | null; at: number } | null = null;

async function readDbHash(db: D1Database): Promise<string | null> {
  if (cachedHash && Date.now() - cachedHash.at < 30_000) return cachedHash.value;
  const row = await db.prepare(`SELECT value FROM settings WHERE key = ?`).bind(ADMIN_HASH_KEY).first<{ value: string }>();
  const value = row?.value && /^[0-9a-f]{64}$/.test(row.value) ? row.value : null;
  // Only cache a hit, so a newly stored hash takes effect on the very next request.
  cachedHash = value ? { value, at: Date.now() } : null;
  return value;
}

/** Where the admin credential comes from: the ADMIN_TOKEN secret, a hash in the database, or nowhere. */
export async function adminStatus(env: Env, db: D1Database): Promise<AdminStatus> {
  const e = envTokenState(env);
  if (e.token) return "env";
  if (await readDbHash(db)) return "database";
  return e.problem!;
}

async function requireConfigured(env: Env, db: D1Database): Promise<AdminConfig> {
  const e = envTokenState(env);
  const dbHash = await readDbHash(db);
  if (e.token || dbHash) return { envToken: e.token, dbHash, sessionSecret: e.token ?? `db:${dbHash}` };
  if (e.problem === "too_short") {
    throw new ApiError(
      "not_configured",
      `ADMIN_TOKEN is set but shorter than ${MIN_ADMIN_TOKEN_LENGTH} characters. Replace it with a longer random value (e.g. \`openssl rand -hex 32\`) under Settings → Variables and Secrets.`,
      { problem: e.problem },
    );
  }
  throw new ApiError(
    "not_configured",
    "The Worker can't see an ADMIN_TOKEN at runtime. Add it under Settings → Variables and Secrets (type: Secret), not under Build → Variables. Runtime secrets apply immediately, with no rebuild needed. From a terminal: `npx wrangler secret put ADMIN_TOKEN`.",
    { problem: e.problem },
  );
}

const sessionKey = (secret: string) => `relay-session:${secret}`;

export async function createSessionCookie(env: Env, db: D1Database, secure: boolean): Promise<string> {
  const admin = await requireConfigured(env, db);
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_S;
  const sig = await hmac(sessionKey(admin.sessionSecret), `owner.${exp}`);
  return `${SESSION_COOKIE}=${exp}.${sig}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_S}${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

async function verifySession(admin: AdminConfig, value: string): Promise<boolean> {
  const [expStr, sig] = value.split(".");
  const exp = Number(expStr);
  if (!exp || !sig || exp < Date.now() / 1000) return false;
  return safeEqual(sig, await hmac(sessionKey(admin.sessionSecret), `owner.${exp}`));
}

async function matchesAdmin(admin: AdminConfig, candidate: string): Promise<boolean> {
  const c = candidate.trim();
  if (!c) return false;
  let ok = false;
  if (admin.envToken && safeEqual(c, admin.envToken)) ok = true;
  if (admin.dbHash && safeEqual(await sha256Hex(c), admin.dbHash)) ok = true;
  return ok;
}

export async function checkAdminToken(env: Env, db: D1Database, candidate: string): Promise<boolean> {
  return matchesAdmin(await requireConfigured(env, db), candidate);
}

export interface AuthResult {
  actor: Actor;
  /** True when authenticated by cookie (browser). Mutations then require a custom header (CSRF guard). */
  cookie: boolean;
}

/**
 * Resolves the caller. Accepts, in order:
 *  - `Authorization: Bearer <admin token>` → the owner (ADMIN_TOKEN secret, or the token whose hash is in settings)
 *  - `Authorization: Bearer rly_…` → an API/agent token
 *  - the signed session cookie set by the web UI login → the owner
 */
export async function authenticate(req: Request, env: Env, db: D1Database, waitUntil: (p: Promise<unknown>) => void): Promise<AuthResult> {
  const admin = await requireConfigured(env, db);
  const auth = req.headers.get("Authorization");
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (!m) throw new ApiError("unauthorized", "Authorization header must be `Bearer <token>`");
    const token = m[1].trim();
    if (await matchesAdmin(admin, token)) return { actor: ownerActor(env), cookie: false };
    if (token.startsWith(TOKEN_PREFIX)) {
      const row: any = await db.prepare(`SELECT * FROM tokens WHERE token_hash = ?`).bind(await sha256Hex(token)).first();
      if (row && !row.revoked_at) {
        const stale = !row.last_used_at || Date.now() - Date.parse(row.last_used_at) > 5 * 60 * 1000;
        if (stale) waitUntil(db.prepare(`UPDATE tokens SET last_used_at = ? WHERE id = ?`).bind(nowIso(), row.id).run());
        return {
          actor: { id: row.id, name: row.name, kind: row.kind, scope: row.scope, requiresReview: !!row.requires_review, canSkipReview: !!row.can_skip_review },
          cookie: false,
        };
      }
    }
    throw new ApiError("unauthorized", "Invalid or revoked token");
  }
  const cookie = readCookie(req, SESSION_COOKIE);
  if (cookie && (await verifySession(admin, cookie))) return { actor: ownerActor(env), cookie: true };
  throw new ApiError("unauthorized", "Authentication required: send `Authorization: Bearer <token>` or sign in to the web UI");
}
